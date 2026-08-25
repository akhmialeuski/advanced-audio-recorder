/**
 * LLM provider abstraction for transcript post-processing, plus the OpenAI,
 * Anthropic, and Google Gemini implementations. The OpenAI provider speaks the
 * OpenAI Chat Completions API. All calls go through Obsidian's `requestUrl`.
 * @module transcription/llm/LlmProvider
 */

import {
	ANTHROPIC_API_VERSION,
	GEMINI_API_KEY_HEADER,
	LLM_PROVIDER_IDS,
	LLM_REQUEST_TIMEOUT_MS,
} from '../../constants';
import {
	authHeader,
	HttpError,
	requestJson,
	trimTrailingSlash,
} from '../httpClient';
import type { LlmProviderId } from '../../settings/settingsSchema';
import type { LlmPrompt } from '../llmPostProcess';
import {
	extractAnthropicText,
	extractGeminiText,
	extractOpenAiText,
} from './llmResponse';
import {
	assertGeminiNotBlocked,
	assertGeminiNotTruncated,
	geminiGenerateContentUrl,
	geminiThinkingConfig,
} from '../providers/geminiShared';

/**
 * Per-call generation options. Every field is optional; an omitted field
 * leaves the provider's API default in place, so existing callers are
 * unaffected.
 */
export interface LlmCompleteOptions {
	/**
	 * Sampling temperature. The advanced transcription context agents pin it
	 * to 0 so the same recording yields the same bias prompt on every run.
	 */
	temperature?: number;
}

/** A provider that completes a single prompt and returns text. */
export interface LlmProvider {
	/**
	 * The vendor this provider implements. Typed as the settings id rather
	 * than a bare string, so an implementation cannot claim an id the settings
	 * (and therefore the vendor registry) do not know about.
	 */
	readonly id: LlmProviderId;
	readonly label: string;
	/**
	 * Completes a prompt and returns the assistant's text.
	 * @param prompt - System + user prompt
	 * @param maxTokens - Maximum output tokens
	 * @param options - Optional generation options (temperature)
	 */
	complete(
		prompt: LlmPrompt,
		maxTokens: number,
		options?: LlmCompleteOptions,
	): Promise<string>;
}

/** Configuration shared by HTTP LLM providers. */
export interface LlmConfig {
	baseUrl: string;
	apiKey: string;
	model: string;
}

/**
 * The names the OpenAI chat API has had for its output-token ceiling, in the
 * order an endpoint is asked about them.
 *
 * `max_tokens` is the original. OpenAI itself has superseded it with
 * `max_completion_tokens` and its current models refuse the old name outright,
 * so a request carrying it fails before generating anything. Which name an
 * endpoint takes is not knowable from the model id: a list of "new" model
 * families goes stale with every release, and the same base URL setting also
 * points at Groq, LM Studio, llama.cpp and the rest. So it is asked rather than
 * guessed, and the endpoint's own refusal is what selects the other name.
 *
 * The original is asked first, because the two ways of not understanding a
 * field are not equally safe. A server that refuses an unknown field answers
 * 400 and costs one extra request; a server that ignores one answers 200 and
 * silently drops the ceiling, which is a truncation guard that is not there
 * and says nothing about it. Every OpenAI-compatible server understands
 * `max_tokens`, so asking it first means only OpenAI's own current models ever
 * reach the second attempt, and no endpoint can quietly discard the budget.
 */
const OUTPUT_TOKEN_PARAMS = ['max_tokens', 'max_completion_tokens'] as const;

/** The status an endpoint refuses an unknown parameter with. */
const HTTP_BAD_REQUEST = 400;

/** One of the two names an output-token ceiling can be sent under. */
type OutputTokenParam = (typeof OUTPUT_TOKEN_PARAMS)[number];

/**
 * Whether a failure is the endpoint saying it does not know this parameter,
 * which is the one failure worth re-sending under the other name.
 *
 * Narrow on purpose: a 400 naming the very field just sent. Anything else - a
 * bad key, a rate limit, a model that does not exist - is the caller's answer
 * and is raised as it came, rather than retried under a name that would fail
 * the same way.
 * @param error - The failure the request threw
 * @param param - The parameter name that request carried
 */
function rejectedTokenParam(error: unknown, param: OutputTokenParam): boolean {
	return (
		error instanceof HttpError &&
		error.status === HTTP_BAD_REQUEST &&
		error.message.includes(param)
	);
}

/**
 * OpenAI chat-completions provider, using the OpenAI Chat Completions API.
 * The implementation stays OpenAI-compatible, but only OpenAI is offered as a
 * configured vendor.
 */
export class OpenAiCompatibleLlmProvider implements LlmProvider {
	readonly id = LLM_PROVIDER_IDS.OPENAI_COMPATIBLE;
	readonly label = 'OpenAI';

	/**
	 * The name this endpoint took, once it has answered.
	 *
	 * Which name it takes is a fact about the endpoint rather than about the
	 * call, so it is asked once and remembered: the advanced two-pass mode
	 * drives six sequential agent calls through one provider, and renegotiating
	 * on each of them pays the refused request six times over.
	 */
	private acceptedParam: OutputTokenParam | null = null;

	constructor(private readonly config: LlmConfig) {}

	async complete(
		prompt: LlmPrompt,
		maxTokens: number,
		options?: LlmCompleteOptions,
	): Promise<string> {
		const headers = authHeader(
			'Authorization',
			this.config.apiKey,
			'Bearer ',
		);
		const candidates = this.candidateParams();
		let lastError: unknown;
		for (const [index, param] of candidates.entries()) {
			let json: unknown;
			try {
				json = await this.request(prompt, headers, {
					[param]: maxTokens,
					...(options?.temperature !== undefined
						? { temperature: options.temperature }
						: {}),
				});
			} catch (error) {
				lastError = error;
				const isLast = index === candidates.length - 1;
				if (isLast || !rejectedTokenParam(error, param)) {
					throw error;
				}
				continue;
			}
			// The request went through, so this is the name this endpoint takes.
			// Recorded after the call rather than after the parse: an answer this
			// client cannot read is still an answer the parameter was accepted for.
			this.acceptedParam = param;
			return extractOpenAiText(json);
		}
		// Unreachable: the loop either returns or throws on its last attempt.
		throw lastError;
	}

	/**
	 * The names to try, best guess first. A remembered name leads and the other
	 * still follows it, so an endpoint that changes under a live provider - a
	 * base URL repointed at another server between runs - renegotiates instead
	 * of failing on a memory that has gone stale.
	 */
	private candidateParams(): readonly OutputTokenParam[] {
		const accepted = this.acceptedParam;
		if (accepted === null) {
			return OUTPUT_TOKEN_PARAMS;
		}
		return [
			accepted,
			...OUTPUT_TOKEN_PARAMS.filter((param) => param !== accepted),
		];
	}

	/**
	 * Sends one chat completion.
	 * @param prompt - System + user prompt
	 * @param headers - Authorization headers, when a key is configured
	 * @param generation - The generation fields this attempt carries
	 * @returns The parsed response body
	 */
	private request(
		prompt: LlmPrompt,
		headers: Record<string, string>,
		generation: Record<string, number>,
	): Promise<unknown> {
		return requestJson({
			url: `${trimTrailingSlash(this.config.baseUrl)}/chat/completions`,
			method: 'POST',
			headers,
			contentType: 'application/json',
			body: JSON.stringify({
				model: this.config.model,
				...generation,
				messages: [
					{ role: 'system', content: prompt.system },
					{ role: 'user', content: prompt.user },
				],
			}),
			timeoutMs: LLM_REQUEST_TIMEOUT_MS,
		});
	}
}

/**
 * Anthropic Messages API provider (Claude). Uses `x-api-key` auth and the
 * direct-browser-access header so the request works from the renderer.
 */
export class AnthropicLlmProvider implements LlmProvider {
	readonly id = LLM_PROVIDER_IDS.ANTHROPIC;
	readonly label = 'Anthropic (Claude)';

	constructor(private readonly config: LlmConfig) {}

	async complete(
		prompt: LlmPrompt,
		maxTokens: number,
		options?: LlmCompleteOptions,
	): Promise<string> {
		const json = await requestJson({
			url: `${trimTrailingSlash(this.config.baseUrl)}/messages`,
			method: 'POST',
			headers: {
				...authHeader('x-api-key', this.config.apiKey),
				'anthropic-version': ANTHROPIC_API_VERSION,
				'anthropic-dangerous-direct-browser-access': 'true',
			},
			contentType: 'application/json',
			body: JSON.stringify({
				model: this.config.model,
				max_tokens: maxTokens,
				...(options?.temperature !== undefined
					? { temperature: options.temperature }
					: {}),
				system: prompt.system,
				messages: [{ role: 'user', content: prompt.user }],
			}),
			timeoutMs: LLM_REQUEST_TIMEOUT_MS,
		});
		return extractAnthropicText(json);
	}
}

/**
 * Google Gemini provider via the `generateContent` endpoint. Uses
 * `x-goog-api-key` auth and maps the prompt's system/user parts onto Gemini's
 * `systemInstruction`/`contents` shape.
 */
export class GeminiLlmProvider implements LlmProvider {
	readonly id = LLM_PROVIDER_IDS.GEMINI;
	readonly label = 'Google Gemini';

	constructor(private readonly config: LlmConfig) {}

	async complete(
		prompt: LlmPrompt,
		maxTokens: number,
		options?: LlmCompleteOptions,
	): Promise<string> {
		const url = geminiGenerateContentUrl(
			this.config.baseUrl,
			this.config.model,
		);
		// Cleanup/summary is deterministic; on models that support a thinking
		// budget, thinking would otherwise consume maxOutputTokens and truncate
		// or empty the answer. Models without a thinking budget (2.0 and
		// earlier) get no thinkingConfig, which they would otherwise reject.
		const thinkingConfig = geminiThinkingConfig(this.config.model);
		const json = await requestJson({
			url,
			method: 'POST',
			headers: authHeader(GEMINI_API_KEY_HEADER, this.config.apiKey),
			contentType: 'application/json',
			body: JSON.stringify({
				systemInstruction: { parts: [{ text: prompt.system }] },
				contents: [{ role: 'user', parts: [{ text: prompt.user }] }],
				generationConfig: {
					maxOutputTokens: maxTokens,
					...(options?.temperature !== undefined
						? { temperature: options.temperature }
						: {}),
					...(thinkingConfig ? { thinkingConfig } : {}),
				},
			}),
			timeoutMs: LLM_REQUEST_TIMEOUT_MS,
		});
		// A MAX_TOKENS stop yields a partial/empty answer; a safety/policy block
		// yields no candidate. Fail loudly instead of silently replacing the
		// transcript with a truncated or empty result.
		assertGeminiNotTruncated(
			json,
			'Raise the max output tokens in settings, shorten the input, or ' +
				'choose a model with a larger output limit.',
		);
		assertGeminiNotBlocked(json);
		return extractGeminiText(json);
	}
}
