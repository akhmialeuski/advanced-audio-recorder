/**
 * LLM provider abstraction for transcript post-processing, plus the
 * OpenAI-compatible (OpenAI / Groq / Ollama) and Anthropic
 * implementations. All calls go through Obsidian's `requestUrl`.
 * @module transcription/llm/LlmProvider
 */

import { ANTHROPIC_API_VERSION, LLM_REQUEST_TIMEOUT_MS } from '../../constants';
import { requestJson, trimTrailingSlash } from '../httpClient';
import type { LlmPrompt } from '../llmPostProcess';
import { extractAnthropicText, extractOpenAiText } from './llmResponse';

/** A provider that completes a single prompt and returns text. */
export interface LlmProvider {
	readonly id: string;
	readonly label: string;
	/**
	 * Completes a prompt and returns the assistant's text.
	 * @param prompt - System + user prompt
	 * @param maxTokens - Maximum output tokens
	 */
	complete(prompt: LlmPrompt, maxTokens: number): Promise<string>;
}

/** Configuration shared by HTTP LLM providers. */
export interface LlmConfig {
	baseUrl: string;
	apiKey: string;
	model: string;
}

/**
 * OpenAI-compatible chat-completions provider. Works with OpenAI, Groq,
 * and a local Ollama server (which accepts an empty API key).
 */
export class OpenAiCompatibleLlmProvider implements LlmProvider {
	readonly id = 'openai-compatible';
	readonly label = 'OpenAI-compatible (OpenAI / Groq / Ollama)';

	constructor(private readonly config: LlmConfig) {}

	async complete(prompt: LlmPrompt, maxTokens: number): Promise<string> {
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
	readonly id = 'anthropic';
	readonly label = 'Anthropic (Claude)';

	constructor(private readonly config: LlmConfig) {}

	async complete(prompt: LlmPrompt, maxTokens: number): Promise<string> {
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
				system: prompt.system,
				messages: [{ role: 'user', content: prompt.user }],
			}),
			timeoutMs: LLM_REQUEST_TIMEOUT_MS,
		});
		return extractAnthropicText(json);
	}
}
