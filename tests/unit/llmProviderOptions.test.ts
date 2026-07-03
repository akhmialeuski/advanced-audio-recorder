/**
 * Tests that the LLM-provider dropdown options come from the single
 * LLM_PROVIDER_LABELS map (no hardcoded list that can drift) and that every
 * advertised value is a provider the factory can actually build.
 * @module tests/unit/llmProviderOptions.test
 */

import type { LlmProviderId } from 'src/settings/settingsSchema';
import { mergeSettings } from 'src/settings/settingsSerialization';
import { LLM_PROVIDER_LABELS, LLM_PROVIDER_OPTIONS } from 'src/settings/labels';
import { createLlmProvider } from 'src/transcription/factories';

describe('LLM provider options (single source of truth)', () => {
	it('derives the options from the label map, preserving order', () => {
		expect(LLM_PROVIDER_OPTIONS).toEqual(
			Object.entries(LLM_PROVIDER_LABELS).map(([value, label]) => ({
				value,
				label,
			})),
		);
	});

	it('lists every provider with non-empty labels', () => {
		expect(LLM_PROVIDER_OPTIONS.map((option) => option.value)).toEqual([
			'openai-compatible',
			'anthropic',
			'gemini',
		]);
		for (const option of LLM_PROVIDER_OPTIONS) {
			expect(option.label.length).toBeGreaterThan(0);
		}
	});

	it('regression: every advertised value is a provider the factory builds', () => {
		// Guards against the label map listing a provider id the factory does
		// not support, which would let the dropdown offer a broken choice.
		for (const option of LLM_PROVIDER_OPTIONS) {
			const settings = mergeSettings({
				llmProvider: option.value as LlmProviderId,
				// Each provider reads its own vendor key (OpenAI reuses the
				// Whisper key, Gemini its transcription key, Anthropic its own).
				whisperApiKey: 'sk-test',
				anthropicApiKey: 'ak-test',
				geminiApiKey: 'gm-test',
			});
			expect(() => createLlmProvider(settings)).not.toThrow();
		}
	});
});
