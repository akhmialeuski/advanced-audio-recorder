/**
 */

/**
 * Unit tests for Settings module.
 * @module tests/unit/Settings.test
 */

import {
	type AudioRecorderSettings,
	type AudioRecorderSettingsInput,
	DEFAULT_SETTINGS,
	type OutputMode,
	type TrackAudioSources,
} from 'src/settings/settingsSchema';
import {
	mergeSettings,
	mergeSettingsAsync,
} from 'src/settings/settingsSerialization';
import { MODEL_SEED_GENERATION } from 'src/constants';
import { fullyPopulatedSettings } from '../helpers/settingsFixtures';

describe('Settings', () => {
	describe('DEFAULT_SETTINGS', () => {
		it.each([
			{ key: 'recordingFormat', value: 'webm' },
			{ key: 'saveFolder', value: '' },
			{ key: 'saveNearActiveFile', value: false },
			{ key: 'activeFileSubfolder', value: '' },
			{ key: 'filePrefix', value: 'recording' },
			{ key: 'startStopHotkey', value: '' },
			{ key: 'pauseHotkey', value: '' },
			{ key: 'resumeHotkey', value: '' },
			{ key: 'audioDeviceId', value: '' },
			{ key: 'sampleRate', value: 44100 },
			{ key: 'bitrate', value: 128000 },
			{ key: 'recordingChannels', value: 'source' },
			{ key: 'enableMultiTrack', value: false },
			{ key: 'maxTracks', value: 2 },
			{ key: 'outputMode', value: 'single' },
			{ key: 'useSourceNamesForTracks', value: true },
			{ key: 'debug', value: false },
			{ key: 'insertAtOriginalPosition', value: false },
			{ key: 'autoSplitEnabled', value: false },
			{ key: 'splitChunkMinutes', value: 15 },
			{ key: 'splitPartSuffix', value: 'part' },
			{ key: 'deleteSourceAfterSplit', value: false },
		] satisfies { key: keyof AudioRecorderSettings; value: unknown }[])(
			'defaults $key to $value',
			({ key, value }) => {
				expect(DEFAULT_SETTINGS[key]).toBe(value);
			},
		);

		it('starts with no track audio sources configured', () => {
			expect(DEFAULT_SETTINGS.trackAudioSources).toBeInstanceOf(Map);
			expect(DEFAULT_SETTINGS.trackAudioSources.size).toBe(0);
		});

		it('should be a complete AudioRecorderSettings object', () => {
			const expectedKeys: (keyof AudioRecorderSettings)[] = [
				'recordingFormat',
				'saveFolder',
				'saveNearActiveFile',
				'activeFileSubfolder',
				'filePrefix',
				'startStopHotkey',
				'pauseHotkey',
				'resumeHotkey',
				'audioDeviceId',
				'sampleRate',
				'bitrate',
				'enableMultiTrack',
				'maxTracks',
				'outputMode',
				'useSourceNamesForTracks',
				'trackAudioSources',
				'debug',
				'insertAtOriginalPosition',
				'deleteSourceAfterConversion',
				'conversionLinkAction',
				'autoSplitEnabled',
				'splitChunkMinutes',
				'splitPartSuffix',
				'deleteSourceAfterSplit',
			];

			expectedKeys.forEach((key) => {
				expect(DEFAULT_SETTINGS).toHaveProperty(key);
			});
		});

		it('seeds one selected default chapter guidance profile', () => {
			const profiles =
				DEFAULT_SETTINGS.transcriptionChapterPromptProfiles;
			expect(profiles).toHaveLength(1);
			expect(profiles[0]?.name).toBe('Default');
			expect(profiles[0]?.prompt.length).toBeGreaterThan(0);
			// The selection points at the seeded profile so guidance applies
			// out of the box, and the id is a stable literal (not a uuid).
			expect(DEFAULT_SETTINGS.transcriptionChapterPromptProfileId).toBe(
				profiles[0]?.id,
			);
		});
	});

	describe('mergeSettings', () => {
		it('should return default settings when given empty object', () => {
			const result = mergeSettings({});
			expect(result).toEqual(DEFAULT_SETTINGS);
		});

		it('should override specific settings while keeping defaults', () => {
			const partial: Partial<AudioRecorderSettings> = {
				recordingFormat: 'ogg',
				sampleRate: 48000,
			};

			const result = mergeSettings(partial);

			expect(result.recordingFormat).toBe('ogg');
			expect(result.sampleRate).toBe(48000);
			expect(result.filePrefix).toBe(DEFAULT_SETTINGS.filePrefix);
			expect(result.debug).toBe(DEFAULT_SETTINGS.debug);
		});

		it.each([
			{ name: 'source', stored: 'source', expected: 'source' },
			{ name: 'mono-left', stored: 'mono-left', expected: 'mono-left' },
			{
				name: 'mono-right',
				stored: 'mono-right',
				expected: 'mono-right',
			},
			{ name: 'mono-mix', stored: 'mono-mix', expected: 'mono-mix' },
			{
				name: 'an unknown mode, normalised',
				stored: 'stereo-wide',
				expected: 'source',
			},
			{
				name: 'an empty string, normalised',
				stored: '',
				expected: 'source',
			},
		])(
			'reads a stored channel mode of $name as $expected',
			({ stored, expected }) => {
				const result = mergeSettings({
					recordingChannels:
						stored as AudioRecorderSettings['recordingChannels'],
				});

				expect(result.recordingChannels).toBe(expected);
			},
		);

		it('should merge track audio sources', () => {
			const trackSources: TrackAudioSources = new Map([
				[1, { deviceId: 'device-id-1', channelMode: 'source' }],
				[2, { deviceId: 'device-id-2', channelMode: 'source' }],
			]);

			const result = mergeSettings({ trackAudioSources: trackSources });

			expect(result.trackAudioSources.get(1)?.deviceId).toBe(
				'device-id-1',
			);
			expect(result.trackAudioSources.get(2)?.deviceId).toBe(
				'device-id-2',
			);
		});

		it('should normalize serialized track audio sources into a Map', () => {
			const result = mergeSettings({
				trackAudioSources: { 1: 'device-id-1', 2: 'device-id-2' },
			});

			expect(result.trackAudioSources).toBeInstanceOf(Map);
			expect(result.trackAudioSources.get(1)?.deviceId).toBe(
				'device-id-1',
			);
			expect(result.trackAudioSources.get(2)?.deviceId).toBe(
				'device-id-2',
			);
		});

		it('should default legacy string track sources to the source channel mode', () => {
			const result = mergeSettings({
				trackAudioSources: { 1: 'device-id-1' },
			});

			expect(result.trackAudioSources.get(1)?.channelMode).toBe('source');
		});

		it('should keep a stored per-track channel mode', () => {
			const result = mergeSettings({
				trackAudioSources: {
					1: { deviceId: 'device-id-1', channelMode: 'mono-left' },
				},
			});

			expect(result.trackAudioSources.get(1)?.channelMode).toBe(
				'mono-left',
			);
		});

		it('should normalize a missing or invalid per-track channel mode', () => {
			const result = mergeSettings({
				trackAudioSources: {
					1: { deviceId: 'device-id-1' },
					2: { deviceId: 'device-id-2', channelMode: 'quad' },
				},
			});

			expect(result.trackAudioSources.get(1)?.channelMode).toBe('source');
			expect(result.trackAudioSources.get(2)?.channelMode).toBe('source');
		});

		it('should normalize channel modes of Map-form track sources', () => {
			// A Map built by pre-channel-mode plugin code lacks the field
			const legacyMap = new Map([
				[1, { deviceId: 'device-id-1', channelMode: 'source' }],
			]) as unknown as AudioRecorderSettings['trackAudioSources'];

			const result = mergeSettings({ trackAudioSources: legacyMap });

			expect(result.trackAudioSources.get(1)?.channelMode).toBe('source');
		});

		it('should handle output mode changes', () => {
			const modes: OutputMode[] = ['single', 'multiple'];

			modes.forEach((mode) => {
				const result = mergeSettings({ outputMode: mode });
				expect(result.outputMode).toBe(mode);
			});
		});

		it('should preserve all user settings when fully specified', () => {
			const fullSettings = fullyPopulatedSettings();

			const result = mergeSettings(fullSettings);

			// The flat device fields are platform-scoped now: they migrate
			// into the desktop branch and stay mirrored as the active values.
			expect(result).toEqual({
				...fullSettings,
				perPlatform: {
					desktop: {
						audioDeviceId: fullSettings.audioDeviceId,
						recordingChannels: fullSettings.recordingChannels,
						trackAudioSources: fullSettings.trackAudioSources,
					},
					mobile: {
						audioDeviceId: '',
						recordingChannels: 'source',
						trackAudioSources: new Map(),
					},
				},
			});
		});

		it('should not modify the default settings object', () => {
			const originalDefaults = { ...DEFAULT_SETTINGS };

			mergeSettings({ recordingFormat: 'wav' });

			expect(DEFAULT_SETTINGS).toEqual(originalDefaults);
		});

		it('migrates a legacy llmApiKey/llmModel onto the Anthropic vendor fields', () => {
			// Pre-rework data held one flat key and model for the stored provider.
			const legacy = {
				llmProvider: 'anthropic',
				chaptersLlmProvider: 'anthropic',
				advancedLlmProvider: 'anthropic',
				llmApiKey: 'ak-legacy',
				llmModel: 'claude-legacy',
			} as unknown as AudioRecorderSettingsInput;

			const result = mergeSettings(legacy);

			expect(result.anthropicApiKey).toBe('ak-legacy');
			expect(result.llmAnthropicModel).toBe('claude-legacy');
			// The superseded flat fields must not linger in the merged object.
			const record = result as unknown as Record<string, unknown>;
			expect(record.llmApiKey).toBeUndefined();
			expect(record.llmModel).toBeUndefined();
		});

		it('maps a legacy OpenAI llmApiKey onto the shared Whisper/OpenAI key', () => {
			const result = mergeSettings({
				llmProvider: 'openai-compatible',
				llmApiKey: 'sk-legacy',
				llmModel: 'gpt-legacy',
			});

			expect(result.whisperApiKey).toBe('sk-legacy');
			expect(result.llmOpenAiModel).toBe('gpt-legacy');
		});

		it('does not overwrite a vendor key that is already set', () => {
			const result = mergeSettings({
				llmProvider: 'gemini',
				geminiApiKey: 'gm-current',
				llmApiKey: 'gm-legacy',
			});

			expect(result.geminiApiKey).toBe('gm-current');
		});

		it('migrates a legacy single dictionary into one seeded General profile', () => {
			// Pre-profiles data held one flat dictionary string.
			const legacy = {
				transcriptionDictionary: 'Foo\nBar',
			} as unknown as AudioRecorderSettingsInput;

			const result = mergeSettings(legacy);

			expect(result.transcriptionDictionaryProfiles).toHaveLength(1);
			const profile = result.transcriptionDictionaryProfiles[0];
			expect(profile?.name).toBe('General');
			expect(profile?.terms).toBe('Foo\nBar');
			expect(result.transcriptionDictionaryProfileId).toBe(profile?.id);
			// The superseded flat field must not linger in the merged object.
			const record = result as unknown as Record<string, unknown>;
			expect(record.transcriptionDictionary).toBeUndefined();
		});

		it('does not seed a profile from an empty legacy dictionary', () => {
			const result = mergeSettings({
				transcriptionDictionary: '   \n\t',
			});

			expect(result.transcriptionDictionaryProfiles).toEqual([]);
			expect(result.transcriptionDictionaryProfileId).toBe('');
		});

		it('leaves existing profiles untouched when a legacy dictionary is present', () => {
			const result = mergeSettings({
				transcriptionDictionary: 'Legacy',
				transcriptionDictionaryProfiles: [
					{ id: 'keep', name: 'Kept', terms: 'X' },
				],
				transcriptionDictionaryProfileId: 'keep',
			});

			expect(result.transcriptionDictionaryProfiles).toEqual([
				{ id: 'keep', name: 'Kept', terms: 'X' },
			]);
			expect(result.transcriptionDictionaryProfileId).toBe('keep');
			const record = result as unknown as Record<string, unknown>;
			expect(record.transcriptionDictionary).toBeUndefined();
		});

		it('ignores a non-string legacy dictionary instead of throwing on load', () => {
			// A hand-edited or corrupted data.json can hold a non-string where
			// the old schema expected text. Reading it as a string would throw on
			// .trim() and, through the load-time fallback, reset every setting.
			const corrupt = {
				transcriptionDictionary: 123,
			} as unknown as AudioRecorderSettingsInput;

			const result = mergeSettings(corrupt);

			expect(result.transcriptionDictionaryProfiles).toEqual([]);
			const record = result as unknown as Record<string, unknown>;
			expect(record.transcriptionDictionary).toBeUndefined();
		});

		it('ignores a non-string legacy LLM key and model instead of throwing', () => {
			const corrupt = {
				llmProvider: 'gemini',
				llmApiKey: 42,
				llmModel: { nested: true },
			} as unknown as AudioRecorderSettingsInput;

			const result = mergeSettings(corrupt);

			// Nothing is migrated from the malformed fields, and they are dropped.
			expect(result.geminiApiKey).toBe('');
			const record = result as unknown as Record<string, unknown>;
			expect(record.llmApiKey).toBeUndefined();
			expect(record.llmModel).toBeUndefined();
		});

		it('skips the LLM migration for an unknown stored provider without throwing', () => {
			// An unrecognized provider id names no vendor descriptor; the
			// migration must not dereference the absent descriptor and crash the
			// whole load.
			const corrupt = {
				llmProvider: 'no-such-vendor',
				llmApiKey: 'k',
				llmModel: 'm',
				filePrefix: 'kept',
			} as unknown as AudioRecorderSettingsInput;

			const result = mergeSettings(corrupt);

			// The rest of the config still loads, and the superseded flat fields
			// are dropped rather than persisted again.
			expect(result.filePrefix).toBe('kept');
			const record = result as unknown as Record<string, unknown>;
			expect(record.llmApiKey).toBeUndefined();
			expect(record.llmModel).toBeUndefined();
		});

		it('points every job at an engine that exists', () => {
			// The three fields naming a job's engine are read from disk, which
			// is not type-checked, and every reader resolves the id against a
			// registry that has no entry for one no vendor claims. Answered at
			// the field rather than inside the transcribe dialog.
			const corrupt = {
				llmProvider: 'no-such-vendor',
				chaptersLlmProvider: 'also-gone',
				advancedLlmProvider: 'gemini',
			} as unknown as AudioRecorderSettingsInput;

			const result = mergeSettings(corrupt);

			expect(result.llmProvider).toBe(DEFAULT_SETTINGS.llmProvider);
			expect(result.chaptersLlmProvider).toBe(
				DEFAULT_SETTINGS.chaptersLlmProvider,
			);
			// A claimed id is a deliberate choice and is left alone.
			expect(result.advancedLlmProvider).toBe('gemini');
		});

		it('points transcription at an engine that exists', () => {
			const corrupt = {
				transcriptionProvider: 'no-such-engine',
			} as unknown as AudioRecorderSettingsInput;

			const result = mergeSettings(corrupt);

			expect(result.transcriptionProvider).toBe(
				DEFAULT_SETTINGS.transcriptionProvider,
			);
		});

		it('inherits a job engine from a stored provider only while it exists', () => {
			// A config saved before the jobs picked their own engine keeps the
			// behaviour it had by starting all three on the one it named - but
			// only where that one names an engine at all.
			const result = mergeSettings({
				llmProvider: 'anthropic',
			});

			expect(result.chaptersLlmProvider).toBe('anthropic');
			expect(result.advancedLlmProvider).toBe('anthropic');
		});

		it('enables the advanced master switch on upgrade for a config with a dictionary profile', () => {
			// A release that had profiles but not the advanced switch stored no
			// flag; without the migration it would merge to the false default and
			// silently stop biasing the selected profile.
			const result = mergeSettings({
				transcriptionDictionaryProfiles: [
					{ id: 'p1', name: 'Standup', terms: 'gRPC' },
				],
				transcriptionDictionaryProfileId: 'p1',
			});

			expect(result.transcriptionAdvancedSettingsEnabled).toBe(true);
			expect(result.transcriptionDictionaryProfileId).toBe('p1');
		});

		it('enables the advanced master switch when migrating a legacy flat dictionary', () => {
			// The legacy string is seeded into a profile, so the biasing it drove
			// before the switch existed must keep working after the upgrade.
			const result = mergeSettings({
				transcriptionDictionary: 'Foo\nBar',
			});

			expect(result.transcriptionAdvancedSettingsEnabled).toBe(true);
			expect(result.transcriptionDictionaryProfiles).toHaveLength(1);
		});

		it('respects a stored advanced master switch left off', () => {
			// A config that already stored the flag made a deliberate choice; the
			// migration must not flip it on just because a profile exists.
			const result = mergeSettings({
				transcriptionAdvancedSettingsEnabled: false,
				transcriptionDictionaryProfiles: [
					{ id: 'p1', name: 'Standup', terms: 'gRPC' },
				],
				transcriptionDictionaryProfileId: 'p1',
			});

			expect(result.transcriptionAdvancedSettingsEnabled).toBe(false);
		});

		it('leaves the advanced master switch off for a fresh install', () => {
			const result = mergeSettings({});

			expect(result.transcriptionAdvancedSettingsEnabled).toBe(false);
		});

		it('should handle boolean settings correctly', () => {
			const result1 = mergeSettings({ debug: true });
			const result2 = mergeSettings({ enableMultiTrack: true });

			expect(result1.debug).toBe(true);
			expect(result2.enableMultiTrack).toBe(true);
		});

		it('should handle numeric settings correctly', () => {
			const result = mergeSettings({
				sampleRate: 96000,
				bitrate: 320000,
				maxTracks: 8,
			});

			expect(result.sampleRate).toBe(96000);
			expect(result.bitrate).toBe(320000);
			expect(result.maxTracks).toBe(8);
		});

		describe('model catalogues and their selection', () => {
			// The catalogue is the picker: a run uses the selected id and the
			// settings show the list it came from, so an id held outside its
			// list is a selection nobody can see or change.
			it('takes a selection missing from its catalogue into the list', () => {
				const result = mergeSettings({
					whisperApiModel: 'whisper-custom',
					whisperApiModels: ['whisper-1'],
					modelSeedGeneration: MODEL_SEED_GENERATION,
				});

				expect(result.whisperApiModel).toBe('whisper-custom');
				expect(result.whisperApiModels).toContain('whisper-custom');
			});

			it('picks the first saved id when nothing is selected', () => {
				const result = mergeSettings({
					deepgramModel: '',
					deepgramModels: ['nova-3', 'nova-2'],
					modelSeedGeneration: MODEL_SEED_GENERATION,
				});

				expect(result.deepgramModel).toBe('nova-3');
			});

			it('leaves an emptied catalogue empty rather than inventing an id', () => {
				// An empty catalogue is a state the list itself offers, and a
				// run refuses it by name; guessing an id here would run the
				// wrong model instead.
				const result = mergeSettings({
					geminiModel: '',
					geminiModels: [],
					modelSeedGeneration: MODEL_SEED_GENERATION,
				});

				expect(result.geminiModel).toBe('');
				expect(result.geminiModels).toEqual([]);
			});

			it('trims a hand-edited selection to the id it names', () => {
				const result = mergeSettings({
					llmAnthropicModel: '  claude-sonnet-5  ',
					llmAnthropicModels: ['claude-sonnet-5'],
					modelSeedGeneration: MODEL_SEED_GENERATION,
				});

				expect(result.llmAnthropicModel).toBe('claude-sonnet-5');
				expect(result.llmAnthropicModels).toEqual(['claude-sonnet-5']);
			});
		});
	});

	describe('Type definitions', () => {
		it('OutputMode should only accept valid values', () => {
			const validModes: OutputMode[] = ['single', 'multiple'];
			expect(validModes).toHaveLength(2);
		});

		it('TrackAudioSources should map numbers to device IDs', () => {
			const sources: TrackAudioSources = new Map([
				[1, { deviceId: 'device-1', channelMode: 'source' }],
				[2, { deviceId: 'device-2', channelMode: 'source' }],
				[3, { deviceId: 'device-3', channelMode: 'source' }],
			]);

			expect(sources.size).toBe(3);
			expect(sources.get(1)?.deviceId).toBe('device-1');
		});
	});
});

describe('mergeSettingsAsync', () => {
	const mockEnumerateDevices = jest.fn();
	const mockGetUserMedia = jest.fn();

	beforeEach(() => {
		Object.defineProperty(global, 'navigator', {
			value: {
				mediaDevices: {
					enumerateDevices: mockEnumerateDevices,
					getUserMedia: mockGetUserMedia,
				},
			},
			writable: true,
		});
	});

	it('should auto-select default device when audioDeviceId is empty', async () => {
		const devices: MediaDeviceInfo[] = [
			{
				deviceId: 'default',
				label: 'Default - Microphone',
				kind: 'audioinput',
				groupId: 'group1',
				toJSON: () => ({}),
			},
		] as MediaDeviceInfo[];

		mockGetUserMedia.mockResolvedValue({ getTracks: () => [] });
		mockEnumerateDevices.mockResolvedValue(devices);

		const result = await mergeSettingsAsync({});

		expect(result.audioDeviceId).toBe('default');
	});

	it('should auto-select default device when audioDeviceId is whitespace', async () => {
		const devices: MediaDeviceInfo[] = [
			{
				deviceId: 'default',
				label: 'Default - Microphone',
				kind: 'audioinput',
				groupId: 'group1',
				toJSON: () => ({}),
			},
		] as MediaDeviceInfo[];

		mockGetUserMedia.mockResolvedValue({ getTracks: () => [] });
		mockEnumerateDevices.mockResolvedValue(devices);

		const result = await mergeSettingsAsync({ audioDeviceId: '   ' });

		expect(result.audioDeviceId).toBe('default');
	});

	it('should keep existing device ID when already set', async () => {
		const devices: MediaDeviceInfo[] = [
			{
				deviceId: 'default',
				label: 'Default - Microphone',
				kind: 'audioinput',
				groupId: 'group1',
				toJSON: () => ({}),
			},
		] as MediaDeviceInfo[];

		mockGetUserMedia.mockResolvedValue({ getTracks: () => [] });
		mockEnumerateDevices.mockResolvedValue(devices);

		const result = await mergeSettingsAsync({
			audioDeviceId: 'my-custom-device',
		});

		expect(result.audioDeviceId).toBe('my-custom-device');
	});

	it('should leave audioDeviceId empty when no default device available', async () => {
		mockGetUserMedia.mockRejectedValue(new Error('Permission denied'));

		const result = await mergeSettingsAsync({});

		expect(result.audioDeviceId).toBe('');
	});

	it('should preserve other settings while auto-selecting device', async () => {
		const devices: MediaDeviceInfo[] = [
			{
				deviceId: 'default',
				label: 'Default - Microphone',
				kind: 'audioinput',
				groupId: 'group1',
				toJSON: () => ({}),
			},
		] as MediaDeviceInfo[];

		mockGetUserMedia.mockResolvedValue({ getTracks: () => [] });
		mockEnumerateDevices.mockResolvedValue(devices);

		const result = await mergeSettingsAsync({
			recordingFormat: 'wav',
			sampleRate: 48000,
		});

		expect(result.audioDeviceId).toBe('default');
		expect(result.recordingFormat).toBe('wav');
		expect(result.sampleRate).toBe(48000);
		expect(result.filePrefix).toBe(DEFAULT_SETTINGS.filePrefix);
	});
});
