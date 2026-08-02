/**
 * Tests what replaced the LLM base-URL switching: every provider keeps its own
 * endpoint and key, so changing which vendor post-processes moves nothing, and
 * a config saved under the single shared endpoint carries onto the provider it
 * belonged to.
 * @module tests/unit/llmProviderDefaults.test
 */

import { DEFAULT_SETTINGS } from 'src/settings/settingsSchema';
import { mergeSettings } from 'src/settings/settingsSerialization';
import {
	ACCOUNTS,
	ACCOUNT_IDS,
	vendorConnection,
} from 'src/providers/providers';

describe('account endpoints', () => {
	it('gives each account a field of its own', () => {
		// One endpoint per service, whatever the request is for: the field a
		// vendor reads is the field its transcription side reads.
		const keys = [
			ACCOUNT_IDS.OPENAI,
			ACCOUNT_IDS.DEEPGRAM,
			ACCOUNT_IDS.GEMINI,
			ACCOUNT_IDS.ANTHROPIC,
		].map((id) => ACCOUNTS[id].baseUrlKey);

		expect(keys).toEqual([
			'whisperApiBaseUrl',
			'deepgramBaseUrl',
			'geminiBaseUrl',
			'anthropicBaseUrl',
		]);
		expect(new Set(keys).size).toBe(keys.length);
	});

	it('reaches a vendor through the endpoint its provider holds', () => {
		const settings = { ...DEFAULT_SETTINGS, geminiBaseUrl: 'https://my' };

		expect(vendorConnection('gemini').baseUrl(settings)).toBe('https://my');
		expect(vendorConnection('openai-compatible').baseUrl(settings)).toBe(
			DEFAULT_SETTINGS.whisperApiBaseUrl,
		);
	});

	it('carries a stored shared endpoint onto the vendor that used it', () => {
		const merged = mergeSettings({
			llmProvider: 'anthropic',
			llmBaseUrl: 'https://claude.internal/v1',
		});

		expect(merged.anthropicBaseUrl).toBe('https://claude.internal/v1');
		// The superseded field is dropped, so a later save does not persist it.
		expect('llmBaseUrl' in merged).toBe(false);
	});

	it('never overwrites an endpoint the provider already holds', () => {
		// That field is also the transcription endpoint, and a URL typed there
		// is worth more than one the vendor switch happened to leave behind.
		const merged = mergeSettings({
			llmProvider: 'gemini',
			geminiBaseUrl: 'https://gemini.internal',
			llmBaseUrl: 'https://generativelanguage.googleapis.com',
		});

		expect(merged.geminiBaseUrl).toBe('https://gemini.internal');
	});
});

describe('the pre-rework single LLM model', () => {
	it('never overwrites a model the provider already holds', () => {
		// Gemini serves one catalogue for both jobs, so the field the legacy
		// chat model maps onto is the one transcription picks from: adopting it
		// unconditionally replaced the id chosen to transcribe with.
		const merged = mergeSettings({
			llmProvider: 'gemini',
			geminiModel: 'gemini-2.5-pro',
			llmModel: 'gemini-2.0-flash',
		});

		expect(merged.geminiModel).toBe('gemini-2.5-pro');
		expect('llmModel' in merged).toBe(false);
	});

	it('carries onto a field still holding what this version ships', () => {
		const merged = mergeSettings({
			llmProvider: 'gemini',
			llmModel: 'gemini-2.0-flash',
		});

		expect(merged.geminiModel).toBe('gemini-2.0-flash');
		// The migrated id is what a run uses, so the catalogue lists it too.
		expect(merged.geminiModels).toContain('gemini-2.0-flash');
	});

	it('leaves a vendor with a catalogue of its own untouched by the other', () => {
		// OpenAI keeps its chat ids apart from its Whisper ids, so the legacy
		// chat model reaches one of them only.
		const merged = mergeSettings({
			llmProvider: 'openai-compatible',
			llmModel: 'gpt-4o-mini',
		});

		expect(merged.llmOpenAiModel).toBe('gpt-4o-mini');
		expect(merged.whisperApiModel).toBe(DEFAULT_SETTINGS.whisperApiModel);
	});
});
