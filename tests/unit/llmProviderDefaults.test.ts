/**
 * Tests for applyLlmProviderDefaults: switching the LLM provider should move
 * the base URL to the new provider's default when it is still a default, and
 * must never clobber a custom endpoint the user typed. The model is no longer
 * switched here - each provider keeps its own selected model.
 */

import { applyLlmProviderDefaults } from 'src/settings/settingsSchema';
import { mergeSettings } from 'src/settings/settingsSerialization';
import {
	DEFAULT_LLM_OPENAI_BASE_URL,
	DEFAULT_LLM_ANTHROPIC_BASE_URL,
	DEFAULT_LLM_GEMINI_BASE_URL,
} from 'src/constants';

describe('applyLlmProviderDefaults', () => {
	it('switches the OpenAI base URL to Anthropic when choosing Anthropic', () => {
		const settings = mergeSettings({
			llmBaseUrl: DEFAULT_LLM_OPENAI_BASE_URL,
		});
		applyLlmProviderDefaults(settings, 'anthropic');
		expect(settings.llmBaseUrl).toBe(DEFAULT_LLM_ANTHROPIC_BASE_URL);
	});

	it('moves the Anthropic base URL back to OpenAI when choosing OpenAI', () => {
		const settings = mergeSettings({
			llmBaseUrl: DEFAULT_LLM_ANTHROPIC_BASE_URL,
		});
		applyLlmProviderDefaults(settings, 'openai-compatible');
		expect(settings.llmBaseUrl).toBe(DEFAULT_LLM_OPENAI_BASE_URL);
	});

	it('switches the OpenAI base URL to Gemini when choosing Gemini', () => {
		const settings = mergeSettings({
			llmBaseUrl: DEFAULT_LLM_OPENAI_BASE_URL,
		});
		applyLlmProviderDefaults(settings, 'gemini');
		expect(settings.llmBaseUrl).toBe(DEFAULT_LLM_GEMINI_BASE_URL);
	});

	it('moves the Gemini base URL back to OpenAI when choosing OpenAI', () => {
		const settings = mergeSettings({
			llmBaseUrl: DEFAULT_LLM_GEMINI_BASE_URL,
		});
		applyLlmProviderDefaults(settings, 'openai-compatible');
		expect(settings.llmBaseUrl).toBe(DEFAULT_LLM_OPENAI_BASE_URL);
	});

	it('preserves a custom base URL', () => {
		const settings = mergeSettings({
			llmBaseUrl: 'https://my-proxy.example/v1',
		});
		applyLlmProviderDefaults(settings, 'anthropic');
		expect(settings.llmBaseUrl).toBe('https://my-proxy.example/v1');
	});

	it('leaves each provider model untouched (model is per-provider now)', () => {
		const settings = mergeSettings({
			llmOpenAiModel: 'gpt-custom',
			llmAnthropicModel: 'claude-custom',
		});
		applyLlmProviderDefaults(settings, 'anthropic');
		expect(settings.llmOpenAiModel).toBe('gpt-custom');
		expect(settings.llmAnthropicModel).toBe('claude-custom');
	});
});
