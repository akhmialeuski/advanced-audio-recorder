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
			MISTRAL: 'mistral',
		});
	});

	it.each([
		{
			name: 'OpenAI',
			build: (): { id: string } =>
				new OpenAiCompatibleLlmProvider(CONFIG, {
					id: LLM_PROVIDER_IDS.OPENAI_COMPATIBLE,
					label: 'OpenAI',
				}),
			id: LLM_PROVIDER_IDS.OPENAI_COMPATIBLE,
		},
		{
			name: 'Mistral',
			build: (): { id: string } =>
				new OpenAiCompatibleLlmProvider(CONFIG, {
					id: LLM_PROVIDER_IDS.MISTRAL,
					label: 'Mistral',
				}),
			id: LLM_PROVIDER_IDS.MISTRAL,
		},
		{
			name: 'Anthropic',
			build: (): { id: string } => new AnthropicLlmProvider(CONFIG),
			id: LLM_PROVIDER_IDS.ANTHROPIC,
		},
		{
			name: 'Gemini',
			build: (): { id: string } => new GeminiLlmProvider(CONFIG),
			id: LLM_PROVIDER_IDS.GEMINI,
		},
	])('the $name provider answers to its own constant', ({ build, id }) => {
		// The id is what the settings store matches on and what the cost model
		// and the session counter charge against. Two vendors share the
		// OpenAI-compatible client, so each is built with the identity it
		// answers as: a hand-typed one would have priced Mistral calls at
		// OpenAI rates and billed them to the OpenAI account.
		expect(build().id).toBe(id);
	});

	it('keys the label map exactly by the provider ids', () => {
		expect(Object.keys(LLM_PROVIDER_LABELS).sort()).toEqual(
			Object.values(LLM_PROVIDER_IDS).sort(),
		);
	});
});
