/**
 * Tests what replaced the LLM base-URL switching: every provider keeps its own
 * endpoint and key, so changing which vendor post-processes moves nothing, and
 * a config saved under the single shared endpoint carries onto the provider it
 * belonged to.
 * @module tests/unit/llmProviderDefaults.test
 */

import {
	DEFAULT_SETTINGS,
	type AudioRecorderSettingsInput,
} from 'src/settings/settingsSchema';
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

	it('drops a chat endpoint rather than pointing transcription at it', () => {
		// The two were independent fields, and this pairing was ordinary:
		// transcribe through OpenAI on the shipped endpoint, post-process on a
		// local OpenAI-compatible chat server. They share one field now, and a
		// default sitting in it is not a sign nothing uses it - writing the
		// chat URL there would send every transcription request to a host with
		// no audio endpoint, and lose the address that did work.
		const merged = mergeSettings({
			llmProvider: 'openai-compatible',
			whisperApiKey: 'sk-live',
			llmBaseUrl: 'http://localhost:1234/v1',
		});

		expect(merged.whisperApiBaseUrl).toBe(
			DEFAULT_SETTINGS.whisperApiBaseUrl,
		);
		expect('llmBaseUrl' in merged).toBe(false);
	});

	it('drops it for Gemini while Gemini is what transcribes', () => {
		const merged = mergeSettings({
			llmProvider: 'gemini',
			transcriptionProvider: 'gemini',
			llmBaseUrl: 'http://localhost:4000',
		});

		expect(merged.geminiBaseUrl).toBe(DEFAULT_SETTINGS.geminiBaseUrl);
	});

	it('carries it onto an account nothing transcribes through as configured', () => {
		// The question is whether transcription reads the field, not whether it
		// could. Transcribing on Deepgram and prompting through a relay was
		// ordinary - it is how a provider blocked in the user's country is
		// reached at all - and the relay lived in the one endpoint field the old
		// schema had. Refusing it because Gemini is capable of transcribing took
		// away the only address that worked and pointed post-processing at a
		// host that answers nobody there.
		const merged = mergeSettings({
			transcriptionProvider: 'deepgram',
			llmProvider: 'gemini',
			llmBaseUrl: 'https://gemini-relay.internal/v1',
		});

		expect(merged.geminiBaseUrl).toBe('https://gemini-relay.internal/v1');
	});

	it('says where a dropped endpoint went, rather than losing it silently', () => {
		// It is the only record of an address the user typed, and the migration
		// deletes the field it lived in, so a refusal that says nothing leaves
		// nothing to recover it from.
		const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			mergeSettings({
				llmProvider: 'gemini',
				transcriptionProvider: 'gemini',
				llmBaseUrl: 'http://localhost:4000',
			});

			expect(warn).toHaveBeenCalledWith(
				expect.stringContaining('http://localhost:4000'),
			);
		} finally {
			warn.mockRestore();
		}
	});

	it('keeps carrying it where nothing transcribes through the account', () => {
		// Anthropic only answers prompts, so its endpoint was never anything
		// but the chat one and adopting the stored value loses nothing.
		const merged = mergeSettings({
			llmProvider: 'anthropic',
			llmBaseUrl: 'https://claude.internal/v1',
		});

		expect(merged.anthropicBaseUrl).toBe('https://claude.internal/v1');
	});

	it('asks which engine transcribes only after that id has been made to name one', () => {
		// An engine id no registry claims - a hand-edited or downgraded
		// data.json, which is the case the reconciliation exists for - answers
		// "nothing transcribes anywhere", which is exactly the answer that lets
		// the chat URL through. Asked before the id was reconciled, the
		// migration wrote it onto the OpenAI endpoint and the reconciliation
		// then pointed transcription straight back at that field, which is the
		// host with no audio endpoint this rule exists to avoid.
		const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			const merged = mergeSettings({
				transcriptionProvider: 'no-such-engine',
				llmProvider: 'openai-compatible',
				llmBaseUrl: 'http://localhost:1234/v1',
			} as unknown as AudioRecorderSettingsInput);

			expect(merged.transcriptionProvider).toBe(
				DEFAULT_SETTINGS.transcriptionProvider,
			);
			expect(merged.whisperApiBaseUrl).toBe(
				DEFAULT_SETTINGS.whisperApiBaseUrl,
			);
		} finally {
			warn.mockRestore();
		}
	});

	it('still carries it for a vendor the reconciled engine does not share an account with', () => {
		// The reordering must not turn every unclaimed id into a refusal: once
		// the id names the shipped engine, the question is the ordinary one, and
		// an Anthropic relay is still the only address that vendor ever had.
		const merged = mergeSettings({
			transcriptionProvider: 'no-such-engine',
			llmProvider: 'anthropic',
			llmBaseUrl: 'https://claude-relay.internal/v1',
		} as unknown as AudioRecorderSettingsInput);

		expect(merged.anthropicBaseUrl).toBe(
			'https://claude-relay.internal/v1',
		);
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
		// Not adopted, but not lost either: the id stays pickable.
		expect(merged.geminiModels).toContain('gemini-2.0-flash');
		expect('llmModel' in merged).toBe(false);
	});

	it('carries onto a catalogue that answers prompts alone', () => {
		// Anthropic never transcribes, so its catalogue was only ever the chat
		// one and adopting the stored id loses nothing.
		const merged = mergeSettings({
			llmProvider: 'anthropic',
			llmModel: 'claude-3-5-sonnet',
		});

		expect(merged.llmAnthropicModel).toBe('claude-3-5-sonnet');
		// The migrated id is what a run uses, so the catalogue lists it too.
		expect(merged.llmAnthropicModels).toContain('claude-3-5-sonnet');
	});

	it('offers a Gemini chat model rather than transcribing on it', () => {
		// Gemini serves one catalogue for both jobs. A user transcribing on the
		// shipped default has never touched that field, so holding the default
		// says nothing about whether it is in use - adopting the chat id there
		// would move what transcription runs on, and what it costs, without
		// anything having been asked. It joins the catalogue instead.
		const merged = mergeSettings({
			llmProvider: 'gemini',
			llmModel: 'gemini-2.5-pro',
		});

		expect(merged.geminiModel).toBe(DEFAULT_SETTINGS.geminiModel);
		expect(merged.geminiModels).toContain('gemini-2.5-pro');
	});

	it('offers a stored Gemini chat model on the same terms', () => {
		// The dedicated llmGeminiModel field went the same way as llmModel, so
		// it is carried over by the same rule rather than by one of its own.
		const merged = mergeSettings({
			llmProvider: 'openai-compatible',
			llmGeminiModel: 'gemini-2.5-pro',
			llmGeminiModels: ['gemini-2.5-pro', 'gemini-2.0-flash'],
		});

		expect(merged.geminiModel).toBe(DEFAULT_SETTINGS.geminiModel);
		expect(merged.geminiModels).toEqual(
			expect.arrayContaining(['gemini-2.5-pro', 'gemini-2.0-flash']),
		);
		expect('llmGeminiModel' in merged).toBe(false);
		expect('llmGeminiModels' in merged).toBe(false);
	});

	it('leaves a vendor with a catalogue of its own untouched by the other', () => {
		// OpenAI keeps its chat ids apart from its Whisper ids: a catalogue
		// belongs to the engine, not to the account the two engines share, so
		// the legacy chat model reaches one of them only.
		const merged = mergeSettings({
			llmProvider: 'openai-compatible',
			llmModel: 'gpt-4o-mini',
		});

		expect(merged.llmOpenAiModel).toBe('gpt-4o-mini');
		expect(merged.whisperApiModel).toBe(DEFAULT_SETTINGS.whisperApiModel);
	});
});
