/**
 */

/**
 * Unit tests for Settings module.
 * @module tests/unit/Settings.test
 */

import {
	AudioRecorderSettings,
	AudioRecorderSettingsInput,
	DEFAULT_SETTINGS,
	OutputMode,
	TrackAudioSources,
} from 'src/settings/settingsSchema';
import {
	mergeSettings,
	mergeSettingsAsync,
} from 'src/settings/settingsSerialization';

describe('Settings', () => {
	describe('DEFAULT_SETTINGS', () => {
		it('should have correct default recording format', () => {
			expect(DEFAULT_SETTINGS.recordingFormat).toBe('webm');
		});

		it('should have empty save folder by default', () => {
			expect(DEFAULT_SETTINGS.saveFolder).toBe('');
		});

		it('should have save-near-active-file mode disabled by default', () => {
			expect(DEFAULT_SETTINGS.saveNearActiveFile).toBe(false);
		});

		it('should have empty active file subfolder by default', () => {
			expect(DEFAULT_SETTINGS.activeFileSubfolder).toBe('');
		});

		it('should have default file prefix', () => {
			expect(DEFAULT_SETTINGS.filePrefix).toBe('recording');
		});

		it('should have empty hotkeys by default', () => {
			expect(DEFAULT_SETTINGS.startStopHotkey).toBe('');
			expect(DEFAULT_SETTINGS.pauseHotkey).toBe('');
			expect(DEFAULT_SETTINGS.resumeHotkey).toBe('');
		});

		it('should have empty audio device ID', () => {
			expect(DEFAULT_SETTINGS.audioDeviceId).toBe('');
		});

		it('should have default sample rate of 44100', () => {
			expect(DEFAULT_SETTINGS.sampleRate).toBe(44100);
		});

		it('should have default bitrate of 128000', () => {
			expect(DEFAULT_SETTINGS.bitrate).toBe(128000);
		});

		it('should have multi-track disabled by default', () => {
			expect(DEFAULT_SETTINGS.enableMultiTrack).toBe(false);
		});

		it('should have max tracks set to 2 by default', () => {
			expect(DEFAULT_SETTINGS.maxTracks).toBe(2);
		});

		it('should have single output mode by default', () => {
			expect(DEFAULT_SETTINGS.outputMode).toBe('single');
		});

		it('should use source names for tracks by default', () => {
			expect(DEFAULT_SETTINGS.useSourceNamesForTracks).toBe(true);
		});

		it('should have empty track audio sources', () => {
			expect(DEFAULT_SETTINGS.trackAudioSources).toBeInstanceOf(Map);
			expect(DEFAULT_SETTINGS.trackAudioSources.size).toBe(0);
		});

		it('should have debug mode disabled by default', () => {
			expect(DEFAULT_SETTINGS.debug).toBe(false);
		});

		it('should have insert at original position disabled by default', () => {
			expect(DEFAULT_SETTINGS.insertAtOriginalPosition).toBe(false);
		});

		it('should have auto-split disabled by default', () => {
			expect(DEFAULT_SETTINGS.autoSplitEnabled).toBe(false);
		});

		it('should have 15-minute split parts by default', () => {
			expect(DEFAULT_SETTINGS.splitChunkMinutes).toBe(15);
		});

		it('should have "part" as the default split suffix', () => {
			expect(DEFAULT_SETTINGS.splitPartSuffix).toBe('part');
		});

		it('should have delete source after split disabled by default', () => {
			expect(DEFAULT_SETTINGS.deleteSourceAfterSplit).toBe(false);
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

		it('should keep a valid stored recording channel mode', () => {
			const result = mergeSettings({ recordingChannels: 'mono-left' });

			expect(result.recordingChannels).toBe('mono-left');
		});

		it('should normalize an unknown recording channel mode to source', () => {
			const result = mergeSettings({
				recordingChannels:
					'stereo-wide' as AudioRecorderSettings['recordingChannels'],
			});

			expect(result.recordingChannels).toBe('source');
		});

		it('should merge track audio sources', () => {
			const trackSources: TrackAudioSources = new Map([
				[1, { deviceId: 'device-id-1' }],
				[2, { deviceId: 'device-id-2' }],
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
				[1, { deviceId: 'device-id-1' }],
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
			const fullSettings: Omit<AudioRecorderSettings, 'perPlatform'> = {
				recordingFormat: 'mp3',
				saveFolder: '/recordings',
				saveNearActiveFile: true,
				activeFileSubfolder: 'Audio',
				filePrefix: 'audio',
				startStopHotkey: 'Ctrl+R',
				pauseHotkey: 'Ctrl+P',
				resumeHotkey: 'Ctrl+E',
				audioDeviceId: 'test-device',
				sampleRate: 22050,
				recordingChannels: 'mono-left',
				bitrate: 64000,
				enableMultiTrack: true,
				maxTracks: 4,
				outputMode: 'multiple',
				useSourceNamesForTracks: false,
				trackAudioSources: new Map([
					[1, { deviceId: 'dev1', channelMode: 'source' as const }],
					[
						2,
						{ deviceId: 'dev2', channelMode: 'mono-left' as const },
					],
				]),
				debug: true,
				insertAtOriginalPosition: true,
				deleteSourceAfterConversion: false,
				conversionLinkAction: 'after',
				autoSplitEnabled: true,
				splitChunkMinutes: 30,
				splitPartSuffix: 'chunk',
				deleteSourceAfterSplit: true,
				enhancedPlayerEnabled: true,
				playerShowWaveform: false,
				playerEnableMarkers: false,
				transcriptionEnabled: true,
				transcribeOnSave: true,
				transcriptionShowCostEstimates: true,
				transcriptionProvider: 'local-whisper',
				transcriptionLanguage: 'ru',
				transcriptionDiarize: true,
				transcriptionWordTimestamps: true,
				transcriptionDictionaryProfiles: [
					{ id: 'p1', name: 'General', terms: 'Foo\nBar' },
				],
				transcriptionDictionaryProfileId: 'p1',
				transcriptionSpeakerRenameEnabled: false,
				transcriptionAutoChaptersEnabled: true,
				transcriptionAutoChaptersOnTranscribe: true,
				transcriptionChapterPromptProfiles: [
					{
						id: 'c1',
						name: 'Agenda',
						prompt: 'Split by agenda item.',
					},
				],
				transcriptionChapterPromptProfileId: 'c1',
				transcriptionSpeakerProfiles: [],
				transcriptionChunkMb: 10,
				transcriptionTimeoutMinutes: 15,
				whisperApiBaseUrl: 'https://api.groq.com/openai/v1',
				whisperApiKey: 'sk-test',
				whisperApiModel: 'whisper-large-v3',
				whisperApiModels: ['whisper-large-v3', 'whisper-1'],
				deepgramBaseUrl: 'https://api.deepgram.com/v1',
				deepgramApiKey: 'dg-test',
				deepgramModel: 'nova-3',
				deepgramModels: ['nova-3', 'nova-2'],
				geminiBaseUrl: 'https://generativelanguage.googleapis.com',
				geminiApiKey: 'gm-test',
				geminiModel: 'gemini-2.5-flash',
				geminiModels: ['gemini-2.5-flash', 'gemini-2.5-pro'],
				localWhisperBinaryPath: '/usr/bin/whisper',
				localWhisperModelPath: '/models/ggml.bin',
				localWhisperExtraArgs: '-t 4',
				transcriptDestination: 'both',
				transcriptFileFormat: 'srt',
				transcriptIncludeTimestamps: false,
				transcriptTimestampLinks: false,
				transcriptIncludeSpeakers: false,
				transcriptMergeConsecutiveSpeaker: false,
				transcriptTimestampFormat: '({time})',
				transcriptSpeakerFormat: '{speaker}:',
				transcriptLineFormat: '{speaker} {timestamp} {text}',
				transcriptHeading: '# T',
				llmPostProcessEnabled: true,
				llmPostProcessTask: 'summary',
				llmCleanupPrompt: 'cleanup base',
				llmSummaryPrompt: 'summary base',
				llmCustomInstruction: 'do it',
				llmProvider: 'anthropic',
				llmBaseUrl: 'https://api.anthropic.com/v1',
				anthropicApiKey: 'ak-test',
				llmOpenAiModel: 'gpt-4o',
				llmOpenAiModels: ['gpt-4o', 'gpt-4o-mini'],
				llmAnthropicModel: 'claude-opus-4-8',
				llmAnthropicModels: ['claude-opus-4-8', 'claude-sonnet-4-6'],
				llmGeminiModel: 'gemini-2.5-flash',
				llmGeminiModels: ['gemini-2.5-flash', 'gemini-2.5-pro'],
				llmMaxTokens: 2048,
				inputNoiseSuppression: false,
				inputEchoCancellation: false,
				inputAutoGainControl: false,
				showInputLevelMeter: false,
				detectSilentChannelOnSave: false,
				showRecordingStats: false,
				mobileRecordingBanner: false,
				cleanupHighPassEnabled: false,
				cleanupHighPassHz: 100,
				cleanupNoiseGateEnabled: true,
				cleanupNoiseGateThresholdDb: -45,
				cleanupLevelingEnabled: true,
				cleanupLevelingMakeupDb: 9,
			};

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
			} as unknown as AudioRecorderSettingsInput);

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
			} as unknown as AudioRecorderSettingsInput);

			expect(result.transcriptionDictionaryProfiles).toEqual([
				{ id: 'keep', name: 'Kept', terms: 'X' },
			]);
			expect(result.transcriptionDictionaryProfileId).toBe('keep');
			const record = result as unknown as Record<string, unknown>;
			expect(record.transcriptionDictionary).toBeUndefined();
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
	});

	describe('Type definitions', () => {
		it('OutputMode should only accept valid values', () => {
			const validModes: OutputMode[] = ['single', 'multiple'];
			expect(validModes).toHaveLength(2);
		});

		it('TrackAudioSources should map numbers to device IDs', () => {
			const sources: TrackAudioSources = new Map([
				[1, { deviceId: 'device-1' }],
				[2, { deviceId: 'device-2' }],
				[3, { deviceId: 'device-3' }],
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
		jest.clearAllMocks();
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
