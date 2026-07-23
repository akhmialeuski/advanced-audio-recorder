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
import { requestJson, trimTrailingSlash } from '../httpClient';
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
	readonly id: string;
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
 * OpenAI chat-completions provider, using the OpenAI Chat Completions API.
 * The implementation stays OpenAI-compatible, but only OpenAI is offered as a
 * configured vendor.
 */
export class OpenAiCompatibleLlmProvider implements LlmProvider {
	readonly id = LLM_PROVIDER_IDS.OPENAI_COMPATIBLE;
	readonly label = 'OpenAI';

	constructor(private readonly config: LlmConfig) {}

	async complete(
		prompt: LlmPrompt,
		maxTokens: number,
		options?: LlmCompleteOptions,
	): Promise<string> {
		const headers: Record<string, string> = {};
		if (this.config.apiKey) {
			headers.Authorization = `Bearer ${this.config.apiKey}`;
		}
		const json = await requestJson({
			url: `${trimTrailingSlash(this.config.baseUrl)}/chat/completions`,
			method: 'POST',
			headers,
			contentType: 'application/json',
			body: JSON.stringify({
				model: this.config.model,
				max_tokens: maxTokens,
				...(options?.temperature !== undefined
					? { temperature: options.temperature }
					: {}),
				messages: [
					{ role: 'system', content: prompt.system },
					{ role: 'user', content: prompt.user },
				],
			}),
			timeoutMs: LLM_REQUEST_TIMEOUT_MS,
		});
		return extractOpenAiText(json);
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
				'x-api-key': this.config.apiKey,
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
			headers: { [GEMINI_API_KEY_HEADER]: this.config.apiKey },
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
