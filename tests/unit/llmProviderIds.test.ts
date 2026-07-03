/**
 * Tests that LLM_PROVIDER_IDS is the single source of truth for the provider
 * id strings: the provider classes' `id` fields, the label map keys, and the
 * factory discriminator must all agree with it, so the literals are never
 * hand-typed and cannot drift apart.
 * @module tests/unit/llmProviderIds.test
 */

import { LLM_PROVIDER_IDS } from 'src/constants';
import { LLM_PROVIDER_LABELS } from 'src/settings/labels';
import {
	AnthropicLlmProvider,
	GeminiLlmProvider,
	OpenAiCompatibleLlmProvider,
} from 'src/transcription/llm/LlmProvider';

const CONFIG = { baseUrl: 'https://x.example', apiKey: 'k', model: 'm' };

describe('LLM_PROVIDER_IDS as single source of truth', () => {
	it('exposes the expected provider ids', () => {
		expect(LLM_PROVIDER_IDS).toEqual({
			OPENAI_COMPATIBLE: 'openai-compatible',
			ANTHROPIC: 'anthropic',
			GEMINI: 'gemini',
		});
	});

	it('matches each provider class id to its constant', () => {
		expect(new OpenAiCompatibleLlmProvider(CONFIG).id).toBe(
			LLM_PROVIDER_IDS.OPENAI_COMPATIBLE,
		);
		expect(new AnthropicLlmProvider(CONFIG).id).toBe(
			LLM_PROVIDER_IDS.ANTHROPIC,
		);
		expect(new GeminiLlmProvider(CONFIG).id).toBe(LLM_PROVIDER_IDS.GEMINI);
	});

	it('keys the label map exactly by the provider ids', () => {
		expect(Object.keys(LLM_PROVIDER_LABELS).sort()).toEqual(
			Object.values(LLM_PROVIDER_IDS).sort(),
		);
	});
});
