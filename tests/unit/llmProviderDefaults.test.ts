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
