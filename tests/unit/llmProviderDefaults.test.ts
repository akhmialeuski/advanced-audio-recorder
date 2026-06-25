/**
 * Tests for applyLlmProviderDefaults: switching the LLM provider should move
 * the base URL and model to the new provider's defaults when they are still
 * defaults, and must never clobber a custom endpoint or model the user typed.
 */

import { applyLlmProviderDefaults, mergeSettings } from 'src/settings/Settings';
import {
	DEFAULT_LLM_OPENAI_BASE_URL,
	DEFAULT_LLM_OPENAI_MODEL,
	DEFAULT_LLM_ANTHROPIC_BASE_URL,
	DEFAULT_LLM_ANTHROPIC_MODEL,
	DEFAULT_LLM_GEMINI_BASE_URL,
	DEFAULT_LLM_GEMINI_MODEL,
} from 'src/constants';

describe('applyLlmProviderDefaults', () => {
	it('switches OpenAI defaults to Anthropic defaults when choosing Anthropic', () => {
		const settings = mergeSettings({
			llmBaseUrl: DEFAULT_LLM_OPENAI_BASE_URL,
			llmModel: DEFAULT_LLM_OPENAI_MODEL,
		});
		applyLlmProviderDefaults(settings, 'anthropic');
		expect(settings.llmBaseUrl).toBe(DEFAULT_LLM_ANTHROPIC_BASE_URL);
		expect(settings.llmModel).toBe(DEFAULT_LLM_ANTHROPIC_MODEL);
	});

	it('moves Anthropic defaults back to OpenAI defaults when choosing OpenAI-compatible', () => {
		const settings = mergeSettings({
			llmBaseUrl: DEFAULT_LLM_ANTHROPIC_BASE_URL,
			llmModel: DEFAULT_LLM_ANTHROPIC_MODEL,
		});
		applyLlmProviderDefaults(settings, 'openai-compatible');
		expect(settings.llmBaseUrl).toBe(DEFAULT_LLM_OPENAI_BASE_URL);
		expect(settings.llmModel).toBe(DEFAULT_LLM_OPENAI_MODEL);
	});

	it('switches OpenAI defaults to Gemini defaults when choosing Gemini', () => {
		const settings = mergeSettings({
			llmBaseUrl: DEFAULT_LLM_OPENAI_BASE_URL,
			llmModel: DEFAULT_LLM_OPENAI_MODEL,
		});
		applyLlmProviderDefaults(settings, 'gemini');
		expect(settings.llmBaseUrl).toBe(DEFAULT_LLM_GEMINI_BASE_URL);
		expect(settings.llmModel).toBe(DEFAULT_LLM_GEMINI_MODEL);
	});

	it('moves Gemini defaults back to OpenAI defaults when choosing OpenAI-compatible', () => {
		const settings = mergeSettings({
			llmBaseUrl: DEFAULT_LLM_GEMINI_BASE_URL,
			llmModel: DEFAULT_LLM_GEMINI_MODEL,
		});
		applyLlmProviderDefaults(settings, 'openai-compatible');
		expect(settings.llmBaseUrl).toBe(DEFAULT_LLM_OPENAI_BASE_URL);
		expect(settings.llmModel).toBe(DEFAULT_LLM_OPENAI_MODEL);
	});

	it('preserves a custom base URL and model', () => {
		const settings = mergeSettings({
			llmBaseUrl: 'https://my-proxy.example/v1',
			llmModel: 'my-custom-model',
		});
		applyLlmProviderDefaults(settings, 'anthropic');
		expect(settings.llmBaseUrl).toBe('https://my-proxy.example/v1');
		expect(settings.llmModel).toBe('my-custom-model');
	});
});
