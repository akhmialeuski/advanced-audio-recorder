/**
 * Unit tests for the one writer of an engine's configuration: which fields it
 * moves, the catalogue invariant it holds whatever the change was, and the
 * store each engine gets from it.
 * @module tests/unit/engineSettings.test
 */

import {
	DEFAULT_SETTINGS,
	type AudioRecorderSettings,
} from 'src/settings/settingsSchema';
import {
	ENGINES,
	ENGINE_IDS,
	ENGINE_ORDER,
	accountOf,
} from 'src/providers/providers';
import {
	applyEngineSettings,
	engineFieldOf,
	engineSettingsStore,
	readEngineSettings,
	reconcileEngineSettings,
} from 'src/providers/engineSettings';

describe('engine settings', () => {
	let settings: AudioRecorderSettings;

	beforeEach(() => {
		settings = { ...DEFAULT_SETTINGS };
	});

	describe('applyEngineSettings', () => {
		it('writes an engine through the fields its own descriptor names', () => {
			applyEngineSettings(settings, ENGINE_IDS.ANTHROPIC, {
				baseUrl: 'https://proxy.example/v1',
				apiKey: 'sk-ant-test',
				maxTokens: 8000,
			});

			expect(settings.anthropicBaseUrl).toBe('https://proxy.example/v1');
			expect(settings.anthropicApiKey).toBe('sk-ant-test');
			expect(settings.llmAnthropicMaxTokens).toBe(8000);
		});

		it('leaves alone what the engine has no field for', () => {
			// The local engine runs a binary against a file on disk: it has no
			// account, no catalogue, and no answer to bound. A patch naming one
			// is a question this engine has no field for, not a write that has
			// to land somewhere.
			applyEngineSettings(settings, ENGINE_IDS.LOCAL_WHISPER, {
				baseUrl: 'https://nowhere.example',
				apiKey: 'leaked',
				model: 'gpt-5.6-sol',
				maxTokens: 1234,
			});

			expect(settings).toEqual(DEFAULT_SETTINGS);
			expect(settings.whisperApiKey).toBe('');
			expect(settings.anthropicApiKey).toBe('');
			expect(settings.llmOpenAiModel).toBe(
				DEFAULT_SETTINGS.llmOpenAiModel,
			);
		});

		it('shares one account between the two engines reached through it', () => {
			// The Whisper API and the OpenAI chat models are two catalogues over
			// one account: a key entered on either page is the same key.
			applyEngineSettings(settings, ENGINE_IDS.WHISPER_API, {
				apiKey: 'sk-openai',
			});

			const openAiLlm = readEngineSettings(
				settings,
				ENGINE_IDS.OPENAI_LLM,
			);
			expect(openAiLlm.apiKey).toBe('sk-openai');
		});

		it('puts a selection the catalogue does not list into it', () => {
			applyEngineSettings(settings, ENGINE_IDS.WHISPER_API, {
				models: ['whisper-1'],
				model: 'whisper-large-v3',
			});

			// An id held outside its list is a selection the user can neither
			// see nor change, so the list is made to offer it.
			expect(settings.whisperApiModels).toEqual([
				'whisper-large-v3',
				'whisper-1',
			]);
			expect(settings.whisperApiModel).toBe('whisper-large-v3');
		});

		it('adopts the first saved id when nothing is picked', () => {
			applyEngineSettings(settings, ENGINE_IDS.DEEPGRAM, {
				models: ['nova-3', 'nova-2-meeting'],
				model: '',
			});

			expect(settings.deepgramModel).toBe('nova-3');
		});

		it('keeps showing the id in use when the list is emptied under it', () => {
			// The invariant runs one way only: an id in use is one the list
			// offers. Emptying the list around a live selection therefore keeps
			// that selection visible rather than silently unconfiguring the
			// engine - clearing it is what deleting that id does.
			applyEngineSettings(settings, ENGINE_IDS.DEEPGRAM, { models: [] });

			expect(settings.deepgramModels).toEqual([
				DEFAULT_SETTINGS.deepgramModel,
			]);
			expect(settings.deepgramModel).toBe(DEFAULT_SETTINGS.deepgramModel);
		});

		it('leaves an engine naming no model when neither half is set', () => {
			// Both halves gone is an engine that is genuinely unconfigured, and
			// a run against it is refused by name rather than sent as a request
			// naming no model.
			applyEngineSettings(settings, ENGINE_IDS.DEEPGRAM, {
				models: [],
				model: '',
			});

			expect(settings.deepgramModel).toBe('');
			expect(settings.deepgramModels).toEqual([]);
		});

		it('trims a selection rather than holding one the list cannot match', () => {
			applyEngineSettings(settings, ENGINE_IDS.GEMINI, {
				models: ['gemini-3.5-flash'],
				model: '  gemini-3.5-flash  ',
			});

			expect(settings.geminiModel).toBe('gemini-3.5-flash');
			expect(settings.geminiModels).toEqual(['gemini-3.5-flash']);
		});
	});

	describe('reconcileEngineSettings', () => {
		it('restores the invariant of every catalogue at once', () => {
			settings.whisperApiModels = ['whisper-1'];
			settings.whisperApiModel = 'hand-edited';
			settings.geminiModels = [];
			settings.geminiModel = 'gone';

			reconcileEngineSettings(settings);

			expect(settings.whisperApiModels).toContain('hand-edited');
			expect(settings.whisperApiModel).toBe('hand-edited');
			// An emptied list has nothing to fall back to.
			expect(settings.geminiModels).toEqual(['gone']);
			expect(settings.geminiModel).toBe('gone');
		});

		it('leaves a consistent config untouched', () => {
			const before = { ...settings };

			reconcileEngineSettings(settings);

			expect(settings).toEqual(before);
		});
	});

	describe('engineFieldOf', () => {
		it('claims every settings key the registry declares', () => {
			// Derived from the registry rather than listed here, so a field
			// added to an engine is routed through that engine without a second
			// declaration going stale.
			for (const id of ENGINE_ORDER) {
				const engine = ENGINES[id];
				const account = accountOf(engine);
				const keys = [
					account?.baseUrlKey,
					account?.apiKeyKey,
					engine.models?.modelKey,
					engine.models?.modelsKey,
					engine.maxTokens?.key,
					engine.uploadChunk?.key,
				];
				for (const key of keys) {
					if (key === undefined || key === null) {
						continue;
					}
					expect(engineFieldOf(key)).toBeDefined();
				}
			}
		});

		it('claims nothing that belongs to no engine', () => {
			expect(engineFieldOf('transcriptionLanguage')).toBeUndefined();
			expect(engineFieldOf('llmProvider')).toBeUndefined();
		});

		it('names the field a key is, not merely the engine', () => {
			expect(engineFieldOf('llmAnthropicMaxTokens')).toEqual({
				engine: ENGINE_IDS.ANTHROPIC,
				field: 'maxTokens',
			});
			expect(engineFieldOf('transcriptionChunkMb')).toEqual({
				engine: ENGINE_IDS.WHISPER_API,
				field: 'uploadChunkMb',
			});
		});
	});

	describe('engineSettingsStore', () => {
		let persist: jest.Mock;

		const storeFor = (
			id: (typeof ENGINE_IDS)[keyof typeof ENGINE_IDS],
		): ReturnType<typeof engineSettingsStore> =>
			engineSettingsStore(
				id,
				() => settings,
				persist as () => Promise<void>,
			);

		beforeEach(() => {
			persist = jest.fn().mockResolvedValue(undefined);
		});

		it('reads the live settings rather than the ones it was built with', async () => {
			// A config reloaded from disk replaces the settings object whole,
			// so a store holding a reference would write into the copy nothing
			// else reads any more.
			const store = storeFor(ENGINE_IDS.ANTHROPIC);
			settings = { ...DEFAULT_SETTINGS, anthropicApiKey: 'reloaded' };

			expect(store.read().apiKey).toBe('reloaded');

			await store.save({ maxTokens: 4000 });

			expect(settings.llmAnthropicMaxTokens).toBe(4000);
		});

		it('saves an added id and puts it to work in one write', async () => {
			const store = storeFor(ENGINE_IDS.WHISPER_API);

			await store.addModel('whisper-large-v3-turbo');

			expect(settings.whisperApiModels).toContain(
				'whisper-large-v3-turbo',
			);
			expect(settings.whisperApiModel).toBe('whisper-large-v3-turbo');
			expect(persist).toHaveBeenCalledTimes(1);
		});

		it('moves the selection off an id it drops', async () => {
			settings.whisperApiModels = ['whisper-1', 'whisper-large-v3'];
			settings.whisperApiModel = 'whisper-1';
			const store = storeFor(ENGINE_IDS.WHISPER_API);

			await store.removeModel('whisper-1');

			expect(settings.whisperApiModels).toEqual(['whisper-large-v3']);
			// Never left naming an id the catalogue no longer offers.
			expect(settings.whisperApiModel).toBe('whisper-large-v3');
		});

		it('leaves the selection alone when another id is dropped', async () => {
			settings.whisperApiModels = ['whisper-1', 'whisper-large-v3'];
			settings.whisperApiModel = 'whisper-1';
			const store = storeFor(ENGINE_IDS.WHISPER_API);

			await store.removeModel('whisper-large-v3');

			expect(settings.whisperApiModel).toBe('whisper-1');
		});

		it('drops the last id and leaves the engine naming none', async () => {
			settings.whisperApiModels = ['whisper-1'];
			settings.whisperApiModel = 'whisper-1';
			const store = storeFor(ENGINE_IDS.WHISPER_API);

			await store.removeModel('whisper-1');

			expect(settings.whisperApiModels).toEqual([]);
			expect(settings.whisperApiModel).toBe('');
		});

		it('puts a saved id to work', async () => {
			settings.deepgramModels = ['nova-3', 'nova-2-meeting'];
			settings.deepgramModel = 'nova-3';
			const store = storeFor(ENGINE_IDS.DEEPGRAM);

			await store.selectModel('nova-2-meeting');

			expect(settings.deepgramModel).toBe('nova-2-meeting');
			expect(persist).toHaveBeenCalledTimes(1);
		});

		it('gives every engine the same store, its own fields aside', () => {
			// One implementation, bound per engine: nothing here branches on
			// which engine it holds, which is what keeps them from drifting.
			for (const id of ENGINE_ORDER) {
				const store = storeFor(id);
				expect(store.engine.id).toBe(id);
				expect(typeof store.addModel).toBe('function');
				expect(typeof store.removeModel).toBe('function');
				expect(typeof store.selectModel).toBe('function');
			}
		});
	});
});
