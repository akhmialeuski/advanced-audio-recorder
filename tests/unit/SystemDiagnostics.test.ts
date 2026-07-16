/**
 * Unit tests for SystemDiagnostics.
 * @module tests/unit/SystemDiagnostics
 */

import { SystemDiagnostics } from 'src/diagnostics/SystemDiagnostics';
import type { AudioRecorderSettings } from 'src/settings/settingsSchema';
import * as AudioCapabilityDetector from 'src/audio/AudioCapabilityDetector';
import {
	FORMAT_WEBM,
	FORMAT_OGG,
	FORMAT_MP4,
	DEFAULT_SAMPLE_RATE,
	DEFAULT_BITRATE,
} from 'src/constants';

// Deterministic encoder probing: this suite exercises the diagnostics
// wiring, not the encoders. No offline encoder is available, so a
// format is recordable only through MediaRecorder support.
jest.mock('src/audio/AudioEncoder', () => ({
	isOfflineEncodingSupported: jest.fn(() => false),
	probeOfflineEncodingSupport: jest.fn(() => Promise.resolve(false)),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSettings(
	overrides: Partial<AudioRecorderSettings> = {},
): AudioRecorderSettings {
	return {
		recordingFormat: FORMAT_WEBM,
		bitrate: DEFAULT_BITRATE,
		sampleRate: DEFAULT_SAMPLE_RATE,
		saveFolder: 'recordings',
		saveNearActiveFile: false,
		activeFileSubfolder: '',
		filePrefix: 'recording',
		startStopHotkey: '',
		pauseHotkey: '',
		resumeHotkey: '',
		audioDeviceId: 'device-1',
		enableMultiTrack: false,
		maxTracks: 2,
		outputMode: 'single',
		useSourceNamesForTracks: true,
		trackAudioSources: new Map([
			[1, { deviceId: 'dev-a', channelMode: 'source' as const }],
			[2, { deviceId: 'dev-b', channelMode: 'mono-left' as const }],
		]),
		debug: true,
		...overrides,
	};
}

function makeApp(apiVersion = '1.5.0') {
	return { apiVersion } as unknown as Parameters<
		typeof SystemDiagnostics.collectEnvironment
	>[0];
}

// ---------------------------------------------------------------------------
// collectPluginSettings
// ---------------------------------------------------------------------------

describe('SystemDiagnostics.collectPluginSettings', () => {
	it('serializes all scalar settings fields', () => {
		const settings = makeSettings();
		const result = SystemDiagnostics.collectPluginSettings(settings);

		expect(result.recordingFormat).toBe(FORMAT_WEBM);
		expect(result.bitrate).toBe(DEFAULT_BITRATE);
		expect(result.sampleRate).toBe(DEFAULT_SAMPLE_RATE);
		expect(result.saveFolder).toBe('recordings');
		expect(result.saveNearActiveFile).toBe(false);
		expect(result.activeFileSubfolder).toBe('');
		expect(result.filePrefix).toBe('recording');
		expect(result.enableMultiTrack).toBe(false);
		expect(result.maxTracks).toBe(2);
		expect(result.outputMode).toBe('single');
		expect(result.audioDeviceId).toBe('device-1');
		expect(result.debug).toBe(true);
	});

	it('serializes trackAudioSources Map to a plain Record', () => {
		const settings = makeSettings();
		const result = SystemDiagnostics.collectPluginSettings(settings);

		expect(result.trackAudioSources).toEqual({
			1: { deviceId: 'dev-a', channelMode: 'source' },
			2: { deviceId: 'dev-b', channelMode: 'mono-left' },
		});
	});

	it('handles empty trackAudioSources', () => {
		const settings = makeSettings({ trackAudioSources: new Map() });
		const result = SystemDiagnostics.collectPluginSettings(settings);

		expect(result.trackAudioSources).toEqual({});
	});
});

// ---------------------------------------------------------------------------
// collectEnvironment
// ---------------------------------------------------------------------------

describe('SystemDiagnostics.collectEnvironment', () => {
	const originalProcess = global.process;

	afterEach(() => {
		(global as unknown as { process: NodeJS.Process }).process =
			originalProcess;
	});

	it("reads the API version from obsidian's module export", () => {
		const result = SystemDiagnostics.collectEnvironment(makeApp());

		expect(result.obsidianVersion).toBe('1.12.3');
	});

	it('reads electron and node versions from process.versions', () => {
		const proc = {
			versions: { electron: '28.0.0', node: '20.11.0' },
			platform: 'win32',
			arch: 'x64',
		};
		(global as unknown as { process: typeof proc }).process = proc;

		const result = SystemDiagnostics.collectEnvironment(makeApp());

		expect(result.electronVersion).toBe('28.0.0');
		expect(result.nodeVersion).toBe('20.11.0');
		expect(result.platform).toBe('win32');
		expect(result.arch).toBe('x64');
	});

	it('uses "unknown" when process.platform is absent', () => {
		const proc = { versions: { electron: '28.0.0', node: '20.11.0' } };
		(global as unknown as { process: typeof proc }).process = proc;

		const result = SystemDiagnostics.collectEnvironment(makeApp());

		expect(result.platform).toBe('unknown');
	});

	it('returns "unknown" for electronVersion when process is undefined', () => {
		(global as unknown as { process: undefined }).process = undefined;

		const result = SystemDiagnostics.collectEnvironment(makeApp());

		expect(result.electronVersion).toBe('unknown');
		expect(result.nodeVersion).toBe('unknown');
		expect(result.arch).toBe('unknown');
	});

	it('returns "unknown" for userAgent', () => {
		const result = SystemDiagnostics.collectEnvironment(makeApp());

		expect(result.userAgent).toBe('unknown');
	});
});

// ---------------------------------------------------------------------------
// collectAudioDevices
// ---------------------------------------------------------------------------

describe('SystemDiagnostics.collectAudioDevices', () => {
	const mockEnumerate = jest.fn();

	beforeEach(() => {
		Object.defineProperty(global.navigator, 'mediaDevices', {
			value: { enumerateDevices: mockEnumerate },
			configurable: true,
		});
	});

	it('returns audioinput and audiooutput devices', async () => {
		mockEnumerate.mockResolvedValueOnce([
			{
				deviceId: 'in-1',
				label: 'Mic 1',
				groupId: 'grp-1',
				kind: 'audioinput',
			},
			{
				deviceId: 'out-1',
				label: 'Speaker 1',
				groupId: 'grp-2',
				kind: 'audiooutput',
			},
			{
				deviceId: 'vid-1',
				label: 'Camera',
				groupId: 'grp-3',
				kind: 'videoinput',
			},
		]);

		const result = await SystemDiagnostics.collectAudioDevices();

		expect(result).toHaveLength(2);
		expect(result[0]).toEqual({
			deviceId: 'in-1',
			label: 'Mic 1',
			groupId: 'grp-1',
			kind: 'audioinput',
		});
		expect(result[1]).toEqual({
			deviceId: 'out-1',
			label: 'Speaker 1',
			groupId: 'grp-2',
			kind: 'audiooutput',
		});
	});

	it('returns empty array when no audio devices exist', async () => {
		mockEnumerate.mockResolvedValueOnce([]);

		const result = await SystemDiagnostics.collectAudioDevices();

		expect(result).toEqual([]);
	});

	it('filters out videoinput devices', async () => {
		mockEnumerate.mockResolvedValueOnce([
			{
				deviceId: 'vid-1',
				label: 'Camera',
				groupId: 'g1',
				kind: 'videoinput',
			},
		]);

		const result = await SystemDiagnostics.collectAudioDevices();

		expect(result).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// collectAudioCapabilities
// ---------------------------------------------------------------------------

describe('SystemDiagnostics.collectAudioCapabilities', () => {
	// Spies are created per test: the global restoreMocks option
	// restores them after each one
	let mockDetectCapabilities: jest.SpyInstance;
	let mockDetectCodecSupport: jest.SpyInstance;

	beforeEach(() => {
		mockDetectCapabilities = jest.spyOn(
			AudioCapabilityDetector,
			'detectCapabilities',
		);
		mockDetectCodecSupport = jest.spyOn(
			AudioCapabilityDetector,
			'detectCodecSupport',
		);
		mockDetectCodecSupport.mockReturnValue([]);
	});

	it('maps detectCapabilities result to capabilities object', async () => {
		mockDetectCapabilities.mockResolvedValueOnce({
			supportedFormats: [FORMAT_WEBM, FORMAT_OGG],
			supportedSampleRates: [DEFAULT_SAMPLE_RATE, 48000],
			supportedBitrates: [DEFAULT_BITRATE, 256000],
			defaultFormat: FORMAT_WEBM,
			defaultSampleRate: DEFAULT_SAMPLE_RATE,
			defaultBitrate: DEFAULT_BITRATE,
		});

		const result = await SystemDiagnostics.collectAudioCapabilities();

		expect(result.supportedFormats).toEqual([FORMAT_WEBM, FORMAT_OGG]);
		expect(result.supportedSampleRates).toEqual([
			DEFAULT_SAMPLE_RATE,
			48000,
		]);
		expect(result.supportedBitrates).toEqual([DEFAULT_BITRATE, 256000]);
	});

	it('includes codecSupport from detectCodecSupport()', async () => {
		mockDetectCapabilities.mockResolvedValueOnce({
			supportedFormats: [],
			supportedSampleRates: [],
			supportedBitrates: [],
			defaultFormat: FORMAT_WEBM,
			defaultSampleRate: DEFAULT_SAMPLE_RATE,
			defaultBitrate: DEFAULT_BITRATE,
		});
		const fakeCodecSupport = [
			{
				mimeType: 'audio/webm',
				supported: true,
				withCodecs: [
					{
						codec: 'opus',
						mimeType: 'audio/webm;codecs=opus',
						supported: true,
					},
				],
			},
		];
		mockDetectCodecSupport.mockReturnValueOnce(fakeCodecSupport);

		const result = await SystemDiagnostics.collectAudioCapabilities();

		expect(result.codecSupport).toEqual(fakeCodecSupport);
	});

	it('reports mediaRecorderAvailable as true when MediaRecorder exists', async () => {
		mockDetectCapabilities.mockResolvedValueOnce({
			supportedFormats: [],
			supportedSampleRates: [],
			supportedBitrates: [],
			defaultFormat: FORMAT_WEBM,
			defaultSampleRate: DEFAULT_SAMPLE_RATE,
			defaultBitrate: DEFAULT_BITRATE,
		});

		// MediaRecorder appears in jsdom
		const result = await SystemDiagnostics.collectAudioCapabilities();

		expect(result.mediaRecorderAvailable).toBe(
			typeof MediaRecorder !== 'undefined',
		);
	});

	it('reports getUserMediaAvailable based on navigator.mediaDevices', async () => {
		mockDetectCapabilities.mockResolvedValueOnce({
			supportedFormats: [],
			supportedSampleRates: [],
			supportedBitrates: [],
			defaultFormat: FORMAT_WEBM,
			defaultSampleRate: DEFAULT_SAMPLE_RATE,
			defaultBitrate: DEFAULT_BITRATE,
		});

		const result = await SystemDiagnostics.collectAudioCapabilities();

		const expected =
			typeof navigator.mediaDevices !== 'undefined' &&
			typeof navigator.mediaDevices.getUserMedia === 'function';
		expect(result.getUserMediaAvailable).toBe(expected);
	});
});

describe('SystemDiagnostics.collectActiveRecordingConfig', () => {
	beforeEach(() => {
		(global as Record<string, unknown>).MediaRecorder = {
			isTypeSupported: jest.fn(
				(type: string) => type === 'audio/mp4' || type === 'audio/webm',
			),
		};
	});

	it('returns correct config for a directly supported format (mp4)', async () => {
		const settings = makeSettings({ recordingFormat: FORMAT_MP4 });
		const result =
			await SystemDiagnostics.collectActiveRecordingConfig(settings);

		expect(result.outputFormat).toBe(FORMAT_MP4);
		expect(result.recorderFormat).toBe(FORMAT_MP4);
		expect(result.mimeType).toBe('audio/mp4');
		expect(result.mimeTypeSupported).toBe(true);
		expect(result.validationResult.valid).toBe(true);
	});

	it('resolves WAV to webm intermediate when webm is supported', async () => {
		const settings = makeSettings({ recordingFormat: 'wav' });
		const result =
			await SystemDiagnostics.collectActiveRecordingConfig(settings);

		expect(result.outputFormat).toBe('wav');
		expect(result.recorderFormat).toBe(FORMAT_WEBM);
		expect(result.mimeType).toBe('audio/webm');
		expect(result.mimeTypeSupported).toBe(true);
	});

	it('resolves WAV to ogg when webm is unavailable but ogg is supported', async () => {
		(global as Record<string, unknown>).MediaRecorder = {
			isTypeSupported: jest.fn((type: string) => type === 'audio/ogg'),
		};
		const settings = makeSettings({ recordingFormat: 'wav' });
		const result =
			await SystemDiagnostics.collectActiveRecordingConfig(settings);

		expect(result.recorderFormat).toBe(FORMAT_OGG);
		expect(result.mimeTypeSupported).toBe(true);
	});

	it('reports mimeTypeSupported=false for WAV when no intermediate is available', async () => {
		(global as Record<string, unknown>).MediaRecorder = {
			isTypeSupported: jest.fn().mockReturnValue(false),
		};
		const settings = makeSettings({ recordingFormat: 'wav' });
		const result =
			await SystemDiagnostics.collectActiveRecordingConfig(settings);

		expect(result.mimeTypeSupported).toBe(false);
		expect(result.validationResult.valid).toBe(false);
	});

	it('reports the real intermediate recorder for an unencodable format', async () => {
		// ogg is not directly recordable in this mock and its encoder
		// probe fails: the recorder resolution still shows what capture
		// would use (webm), while validation reports the format as
		// unrecordable - diagnostics mirror the recording pipeline.
		const settings = makeSettings({ recordingFormat: FORMAT_OGG });
		const result =
			await SystemDiagnostics.collectActiveRecordingConfig(settings);

		expect(result.recorderFormat).toBe(FORMAT_WEBM);
		expect(result.mimeTypeSupported).toBe(true);
		expect(result.validationResult.valid).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// collect (integration)
// ---------------------------------------------------------------------------

describe('SystemDiagnostics.collect', () => {
	const mockEnumerate = jest.fn();
	let mockDetectCapabilities: jest.SpyInstance;
	let mockDetectCodecSupport: jest.SpyInstance;

	beforeEach(() => {
		mockDetectCapabilities = jest.spyOn(
			AudioCapabilityDetector,
			'detectCapabilities',
		);
		mockDetectCodecSupport = jest.spyOn(
			AudioCapabilityDetector,
			'detectCodecSupport',
		);
		Object.defineProperty(global.navigator, 'mediaDevices', {
			value: { enumerateDevices: mockEnumerate },
			configurable: true,
		});
		mockEnumerate.mockResolvedValue([]);
		mockDetectCapabilities.mockReturnValue({
			supportedFormats: [FORMAT_WEBM],
			supportedSampleRates: [DEFAULT_SAMPLE_RATE],
			supportedBitrates: [DEFAULT_BITRATE],
			defaultFormat: FORMAT_WEBM,
			defaultSampleRate: DEFAULT_SAMPLE_RATE,
			defaultBitrate: DEFAULT_BITRATE,
		});
		mockDetectCodecSupport.mockReturnValue([]);
		(global as Record<string, unknown>).MediaRecorder = {
			isTypeSupported: jest.fn((type: string) => type === 'audio/webm'),
		};
	});

	afterEach(() => {
		mockDetectCapabilities.mockReset();
		mockDetectCodecSupport.mockReset();
	});

	it('returns a complete DiagnosticsData object', async () => {
		const settings = makeSettings();
		const app = makeApp('1.6.0');

		const result = await SystemDiagnostics.collect(settings, app);

		expect(result).toHaveProperty('pluginSettings');
		expect(result).toHaveProperty('environment');
		expect(result).toHaveProperty('audioDevices');
		expect(result).toHaveProperty('audioCapabilities');
		expect(result).toHaveProperty('activeRecordingConfig');
		expect(result.environment.obsidianVersion).toBe('1.12.3');
		expect(result.pluginSettings.recordingFormat).toBe(FORMAT_WEBM);
		expect(Array.isArray(result.audioDevices)).toBe(true);
	});

	it('propagates audio devices collected asynchronously', async () => {
		mockEnumerate.mockResolvedValueOnce([
			{
				deviceId: 'in-1',
				label: 'Mic',
				groupId: 'g1',
				kind: 'audioinput',
			},
		]);

		const result = await SystemDiagnostics.collect(
			makeSettings(),
			makeApp(),
		);

		expect(result.audioDevices).toHaveLength(1);
		expect(result.audioDevices[0].deviceId).toBe('in-1');
	});

	it('activeRecordingConfig reflects current settings format', async () => {
		const settings = makeSettings({ recordingFormat: FORMAT_WEBM });
		const result = await SystemDiagnostics.collect(settings, makeApp());

		expect(result.activeRecordingConfig.outputFormat).toBe(FORMAT_WEBM);
		expect(result.activeRecordingConfig.mimeType).toBe('audio/webm');
		expect(result.activeRecordingConfig.mimeTypeSupported).toBe(true);
	});
});
