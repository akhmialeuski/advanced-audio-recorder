/**
 * LLM provider abstraction for transcript post-processing, plus the OpenAI,
 * Anthropic, and Google Gemini implementations. The OpenAI provider speaks the
 * OpenAI Chat Completions API. All calls go through Obsidian's `requestUrl`.
 * @module transcription/llm/LlmProvider
 */

import {
	ANTHROPIC_API_VERSION,
	ANTHROPIC_LOW_EFFORT,
	GEMINI_API_KEY_HEADER,
	LLM_PROVIDER_IDS,
	LLM_REQUEST_TIMEOUT_MS,
} from '../../constants';
import { EngineLabel } from '../../providers/providers';
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
	extractAnthropicUsage,
	extractGeminiText,
	extractGeminiUsage,
	extractOpenAiText,
	extractOpenAiUsage,
	type LlmUsage,
} from './llmResponse';
import {
	assertGeminiNotBlocked,
	assertGeminiNotTruncated,
	geminiGenerateContentUrl,
	geminiGenerationControls,
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
	/**
	 * Releases the request when the run is cancelled. Without it a Cancel
	 * pressed during an LLM step released nothing, and the run waited out the
	 * request's own five-minute timeout before it stopped.
	 */
	signal?: AbortSignal | undefined;
}

/**
 * One completed call: the assistant's text and, when the vendor reported
 * them, the token counts it billed. An absent `usage` is what tells the
 * accounting to fall back to an estimate rather than record a false zero.
 */
export interface LlmCompletion {
	/** The assistant's text. */
	text: string;
	/** Token counts the vendor reported, absent when it reported none. */
	usage?: LlmUsage;
}

/** A provider that completes a single prompt and returns text. */
export interface LlmProvider {
	/**
	 * The vendor this provider implements. Typed as the settings id rather
	 * than a bare string, so an implementation cannot claim an id the settings
	 * (and therefore the vendor registry) do not know about.
	 */
	readonly id: LlmProviderId;
	readonly label: EngineLabel;
	/**
	 * Completes a prompt and returns the assistant's text with whatever
	 * usage the vendor reported alongside it.
	 * @param prompt - System + user prompt
	 * @param maxTokens - Maximum output tokens
	 * @param options - Optional generation options (temperature)
	 */
	complete(
		prompt: LlmPrompt,
		maxTokens: number,
		options?: LlmCompleteOptions,
	): Promise<LlmCompletion>;
}

/**
 * Builds the completion, carrying usage only when the vendor reported any.
 * An empty object would read as "billed nothing", which is a different claim
 * from "said nothing", and only the second may fall back to an estimate.
 * @param text - The assistant's text
 * @param usage - Counts read from the same response
 * @returns The completion to hand back
 */
function withUsage(text: string, usage: LlmUsage): LlmCompletion {
	return Object.keys(usage).length > 0 ? { text, usage } : { text };
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
const OutputTokenParam = {
	/** The original name, which every OpenAI-compatible server understands. */
	MaxTokens: 'max_tokens',
	/** The name OpenAI's own current models require instead. */
	MaxCompletionTokens: 'max_completion_tokens',
} as const;

/**
 * One of the two names an output-token ceiling can be sent under (derived from
 * {@link OutputTokenParam}).
 */
type OutputTokenParam =
	(typeof OutputTokenParam)[keyof typeof OutputTokenParam];

/** The status an endpoint refuses an unknown parameter with. */
const HTTP_BAD_REQUEST = 400;

/**
 * Whether a failure is the endpoint saying it does not take this parameter,
 * which is the one failure worth re-sending without it or under another name.
 *
 * Narrow on purpose: a 400 naming the very field just sent. Anything else - a
 * bad key, a rate limit, a model that does not exist - is the caller's answer
 * and is raised as it came, rather than retried in a shape that would fail the
 * same way.
 * @param error - The failure the request threw
 * @param param - The parameter name that request carried
 */
function rejectedParam(error: unknown, param: string): boolean {
	return (
		error instanceof HttpError &&
		error.status === HTTP_BAD_REQUEST &&
		error.message.includes(param)
	);
}

/**
 * Which vendor a provider instance answers as.
 *
 * The OpenAI Chat Completions wire format is spoken by more than one service,
 * and the client is the same for all of them, so the identity is a fact about
 * the vendor being called rather than about the class. It is required rather
 * than defaulted on purpose: a default would let a second vendor built on this
 * client be priced and accounted as OpenAI, which is precisely the mistake the
 * parameter exists to make impossible.
 */
export interface LlmVendorIdentity {
	readonly id: LlmProviderId;
	readonly label: EngineLabel;
}

/**
 * Chat-completions provider speaking the OpenAI Chat Completions API, used for
 * every vendor that serves that wire format - OpenAI itself, Mistral, and any
 * compatible endpoint a Base URL is pointed at.
 */
export class OpenAiCompatibleLlmProvider implements LlmProvider {
	readonly id: LlmProviderId;
	readonly label: EngineLabel;

	/**
	 * The name this endpoint took, once it has answered.
	 *
	 * Which name it takes is a fact about the endpoint rather than about the
	 * call, so it is asked once and remembered: the advanced two-pass mode
	 * drives six sequential agent calls through one provider, and renegotiating
	 * on each of them pays the refused request six times over.
	 */
	private acceptedParam: OutputTokenParam | null = null;

	constructor(
		private readonly config: LlmConfig,
		vendor: LlmVendorIdentity,
	) {
		this.id = vendor.id;
		this.label = vendor.label;
	}

	async complete(
		prompt: LlmPrompt,
		maxTokens: number,
		options?: LlmCompleteOptions,
	): Promise<LlmCompletion> {
		const headers = authHeader(
			'Authorization',
			this.config.apiKey,
			'Bearer',
		);
		const candidates = this.candidateParams();
		let lastError: unknown;
		for (const [index, param] of candidates.entries()) {
			let json: unknown;
			try {
				json = await this.request(
					prompt,
					headers,
					{
						[param]: maxTokens,
						...(options?.temperature !== undefined
							? { temperature: options.temperature }
							: {}),
					},
					options?.signal,
				);
			} catch (error) {
				lastError = error;
				const isLast = index === candidates.length - 1;
				if (isLast || !rejectedParam(error, param)) {
					throw error;
				}
				continue;
			}
			// The request went through, so this is the name this endpoint takes.
			// Recorded after the call rather than after the parse: an answer this
			// client cannot read is still an answer the parameter was accepted for.
			this.acceptedParam = param;
			return withUsage(extractOpenAiText(json), extractOpenAiUsage(json));
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
			return Object.values(OutputTokenParam);
		}
		return [
			accepted,
			...Object.values(OutputTokenParam).filter(
				(param) => param !== accepted,
			),
		];
	}

	/**
	 * Sends one chat completion.
	 * @param prompt - System + user prompt
	 * @param headers - Authorization headers, when a key is configured
	 * @param generation - The generation fields this attempt carries
	 * @param signal - Releases the request when the run is cancelled
	 * @returns The parsed response body
	 */
	private request(
		prompt: LlmPrompt,
		headers: Record<string, string>,
		generation: Record<string, number>,
		signal?: AbortSignal,
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
			signal,
		});
	}
}

/**
 * The optional request fields the Anthropic provider sends that a model may
 * refuse. A refusal is recognised by this name or by the body key the field
 * travels under, because the wording of a refusal is not documented.
 */
const AnthropicOptionalField = {
	/** The caller's sampling temperature, refused by Opus 4.7 and later. */
	Temperature: 'temperature',
	/**
	 * The reasoning effort under `output_config`, refused by Sonnet 4.5,
	 * Haiku 4.5 and older models.
	 */
	Effort: 'effort',
} as const;

/** One optional Anthropic field (derived from {@link AnthropicOptionalField}). */
type AnthropicOptionalField =
	(typeof AnthropicOptionalField)[keyof typeof AnthropicOptionalField];

/**
 * Anthropic Messages API provider (Claude). Uses `x-api-key` auth and the
 * direct-browser-access header so the request works from the renderer.
 */
export class AnthropicLlmProvider implements LlmProvider {
	readonly id = LLM_PROVIDER_IDS.ANTHROPIC;
	readonly label = EngineLabel.Anthropic;

	/**
	 * The optional fields this endpoint has refused, once it has answered.
	 *
	 * Which fields a model takes is a fact about the model rather than about
	 * the call, so a refusal is remembered: the advanced two-pass mode drives
	 * six sequential agent calls through one provider, and re-learning it on
	 * each of them pays the refused request six times over.
	 */
	private readonly refusedFields = new Set<AnthropicOptionalField>();

	constructor(private readonly config: LlmConfig) {}

	async complete(
		prompt: LlmPrompt,
		maxTokens: number,
		options?: LlmCompleteOptions,
	): Promise<LlmCompletion> {
		// Each optional field can be refused at most once, so the last attempt
		// is the one that carries none of the fields still in question.
		for (;;) {
			const fields = this.optionalFields(options?.temperature);
			try {
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
						...Object.assign({}, ...fields.values()),
						system: prompt.system,
						messages: [{ role: 'user', content: prompt.user }],
					}),
					timeoutMs: LLM_REQUEST_TIMEOUT_MS,
					signal: options?.signal,
				});
				return withUsage(
					extractAnthropicText(json),
					extractAnthropicUsage(json),
				);
			} catch (error) {
				// A refusal may name the field or only the body key it travels
				// under, such as `output_config` for the effort.
				const refused = [...fields].find(([field, fragment]) =>
					[field, ...Object.keys(fragment)].some((name) =>
						rejectedParam(error, name),
					),
				)?.[0];
				if (!refused) {
					throw error;
				}
				this.refusedFields.add(refused);
			}
		}
	}

	/**
	 * The optional fields this request carries: the lowest reasoning effort and
	 * the caller's temperature, less whatever the endpoint already refused.
	 *
	 * Which models take each field moves with every release and runs in both
	 * directions - Claude Opus 4.7 and later refuse a non-default temperature,
	 * Sonnet 4.5, Haiku 4.5 and older refuse the effort control - so the
	 * endpoint is asked rather than a model list consulted, the same way the
	 * OpenAI client settles its output-token parameter.
	 * @param temperature - What the caller asked for, if anything
	 * @returns Each field sent, with the fragment it adds to the request body
	 */
	private optionalFields(
		temperature?: number,
	): Map<AnthropicOptionalField, Record<string, unknown>> {
		const fields = new Map<
			AnthropicOptionalField,
			Record<string, unknown>
		>();
		if (!this.refusedFields.has(AnthropicOptionalField.Effort)) {
			fields.set(AnthropicOptionalField.Effort, {
				output_config: { effort: ANTHROPIC_LOW_EFFORT },
			});
		}
		if (
			temperature !== undefined &&
			!this.refusedFields.has(AnthropicOptionalField.Temperature)
		) {
			fields.set(AnthropicOptionalField.Temperature, { temperature });
		}
		return fields;
	}
}

/**
 * Google Gemini provider via the `generateContent` endpoint. Uses
 * `x-goog-api-key` auth and maps the prompt's system/user parts onto Gemini's
 * `systemInstruction`/`contents` shape.
 */
export class GeminiLlmProvider implements LlmProvider {
	readonly id = LLM_PROVIDER_IDS.GEMINI;
	readonly label = EngineLabel.Gemini;

	constructor(private readonly config: LlmConfig) {}

	async complete(
		prompt: LlmPrompt,
		maxTokens: number,
		options?: LlmCompleteOptions,
	): Promise<LlmCompletion> {
		const url = geminiGenerateContentUrl(
			this.config.baseUrl,
			this.config.model,
		);
		// Cleanup/summary is deterministic; on models that support a thinking
		// budget, thinking would otherwise consume maxOutputTokens and truncate
		// or empty the answer. The temperature travels with that decision,
		// because a generation that reasons by level is tuned for its own
		// default and reads a lowered one as a reason to loop.
		const controls = geminiGenerationControls(
			this.config.model,
			options?.temperature,
		);
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
					...controls,
				},
			}),
			timeoutMs: LLM_REQUEST_TIMEOUT_MS,
			signal: options?.signal,
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
		return withUsage(extractGeminiText(json), extractGeminiUsage(json));
	}
}
