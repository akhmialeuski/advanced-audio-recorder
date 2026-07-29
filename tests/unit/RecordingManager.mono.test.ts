/**
 * Unit tests for RecordingManager mono-channel wiring: the capture
 * bridge on the MediaRecorder path, the channel mode on the PCM path,
 * and bridge release on every teardown path.
 * @module tests/unit/RecordingManager.mono.test
 */

import { RecordingManager } from 'src/recording/RecordingManager';
import { at } from '../helpers/assertions';
import {
	DEFAULT_SETTINGS,
	type AudioRecorderSettings,
} from 'src/settings/settingsSchema';
import type { App } from 'obsidian';
import {
	createDesktopRecorder,
	createRecordingMockApp,
	installRecordingMediaStubs,
	makeFakeMarkerStore,
	setDesktopPlatform,
} from './helpers/recordingManagerTestKit';

jest.mock('obsidian', () => ({
	Notice: jest.fn(),
	MarkdownView: jest.fn(),
	normalizePath: (path: string) => path.replace(/\\/g, '/'),
	Platform: {
		isMobile: false,
		isMobileApp: false,
	},
}));

jest.mock('src/recording/AudioStreamHandler', () => ({
	getAudioStreams: jest.fn(),
	getAudioSourceName: jest.fn().mockResolvedValue('TestDevice'),
	stopAllStreams: jest.fn(),
	validateSelectedDevices: jest.fn(),
}));

jest.mock('src/audio/AudioEncoder', () => ({
	encodeAudioBuffer: jest
		.fn()
		.mockResolvedValue(new Blob(['encoded'], { type: 'audio/webm' })),
	isOfflineEncodingSupported: jest.fn((format: string) =>
		['mp3', 'flac', 'aac', 'webm', 'ogg', 'mp4', 'm4a'].includes(format),
	),
}));

jest.mock('src/audio/WavEncoder', () => ({
	assembleWavFromPcmSegmentFiles: jest
		.fn()
		.mockResolvedValue(new ArrayBuffer(44)),
}));

/** Bridge doubles created by the manager, in construction order. */
interface BridgeDouble {
	stream: MediaStream;
	mode: string;
	sampleRate: number;
	monoStream: MediaStream;
	start: jest.Mock;
	release: jest.Mock;
}
const createdBridges: BridgeDouble[] = [];
/** When set, the bridge at this construction index fails to start. */
let failBridgeAtIndex = -1;

jest.mock('src/recording/MonoCaptureBridge', () => ({
	MonoCaptureBridge: jest
		.fn()
		.mockImplementation(
			(stream: MediaStream, mode: string, sampleRate: number) => {
				const index = createdBridges.length;
				const monoStream = {
					getTracks: () => [{ stop: jest.fn() }],
					isMonoBridgeOutput: true,
				} as unknown as MediaStream;
				const bridge: BridgeDouble = {
					stream,
					mode,
					sampleRate,
					monoStream,
					start: jest.fn(() => {
						if (index === failBridgeAtIndex) {
							throw new Error('bridge start failed');
						}
						return monoStream;
					}),
					release: jest.fn(),
				};
				createdBridges.push(bridge);
				return bridge;
			},
		),
}));

let pcmRecorderCtorArgs: unknown[][] = [];
jest.mock('src/recording/PcmStreamRecorder', () => ({
	PcmStreamRecorder: jest.fn().mockImplementation((...args: unknown[]) => {
		pcmRecorderCtorArgs.push(args);
		return {
			channels: 1,
			sampleRate: 44100,
			start: jest.fn().mockResolvedValue(undefined),
			stop: jest.fn().mockResolvedValue(undefined),
			pause: jest.fn(),
			resume: jest.fn(),
		};
	}),
}));

installRecordingMediaStubs();

describe('RecordingManager mono channel wiring', () => {
	let manager: RecordingManager;
	let mockApp: App;
	let mockSettings: AudioRecorderSettings;
	let consoleErrorSpy: jest.SpyInstance;

	beforeEach(() => {
		jest.clearAllMocks();
		createdBridges.length = 0;
		failBridgeAtIndex = -1;
		pcmRecorderCtorArgs = [];
		consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();
		setDesktopPlatform();
		mockApp = createRecordingMockApp();
		mockSettings = { ...DEFAULT_SETTINGS };
		manager = new RecordingManager(
			mockApp,
			mockSettings,
			jest.fn(),
			makeFakeMarkerStore().store,
		);
	});

	afterEach(() => {
		consoleErrorSpy.mockRestore();
	});

	it('records without a bridge in the source mode', async () => {
		createDesktopRecorder();
		mockSettings.recordingChannels = 'source';

		await manager.startRecording();

		expect(createdBridges).toHaveLength(0);
		await manager.stopRecording();
	});

	it('bridges the stream and records the mono output in a mono mode', async () => {
		createDesktopRecorder();
		mockSettings.recordingChannels = 'mono-left';
		mockSettings.sampleRate = 48000;

		await manager.startRecording();

		expect(createdBridges).toHaveLength(1);
		const bridge = at(createdBridges, 0);
		expect(bridge.mode).toBe('mono-left');
		expect(bridge.sampleRate).toBe(48000);
		// The MediaRecorder consumes the bridged stream, not the raw one
		const recorderCtor = global.MediaRecorder as unknown as jest.Mock;
		expect(recorderCtor.mock.calls[0][0]).toBe(bridge.monoStream);

		await manager.stopRecording();
		expect(bridge.release).toHaveBeenCalled();
	});

	it('applies each track its own channel mode in multi-track sessions', async () => {
		createDesktopRecorder();
		const { getAudioStreams } = jest.requireMock(
			'src/recording/AudioStreamHandler',
		);
		const streamA = { getTracks: () => [{ stop: jest.fn() }] };
		const streamB = { getTracks: () => [{ stop: jest.fn() }] };
		getAudioStreams.mockResolvedValue({
			streams: [streamA, streamB],
			trackOrder: [
				{ trackNumber: 1, deviceId: 'a', channelMode: 'mono-left' },
				{ trackNumber: 2, deviceId: 'b', channelMode: 'mono-mix' },
			],
		});
		mockSettings.trackAudioSources = new Map([
			[1, { deviceId: 'a', channelMode: 'mono-left' as const }],
			[2, { deviceId: 'b', channelMode: 'mono-mix' as const }],
		]);
		mockSettings.outputMode = 'multiple';

		await manager.startRecording();

		expect(createdBridges).toHaveLength(2);
		expect(at(createdBridges, 0).stream).toBe(streamA);
		expect(at(createdBridges, 0).mode).toBe('mono-left');
		expect(at(createdBridges, 1).stream).toBe(streamB);
		expect(at(createdBridges, 1).mode).toBe('mono-mix');

		await manager.stopRecording();
		expect(at(createdBridges, 0).release).toHaveBeenCalled();
		expect(at(createdBridges, 1).release).toHaveBeenCalled();
	});

	it('does not reread a changed track mode after stream acquisition', async () => {
		createDesktopRecorder();
		const { getAudioStreams } = jest.requireMock(
			'src/recording/AudioStreamHandler',
		);
		const stream = { getTracks: () => [{ stop: jest.fn() }] };
		mockSettings.trackAudioSources = new Map([
			[
				1,
				{
					deviceId: 'device-before',
					channelMode: 'mono-left' as const,
				},
			],
		]);
		getAudioStreams.mockImplementation(async () => {
			// Simulate a settings edit while getUserMedia/permission was pending.
			mockSettings.trackAudioSources.set(1, {
				deviceId: 'device-after',
				channelMode: 'mono-right',
			});
			return {
				streams: [stream],
				trackOrder: [
					{
						trackNumber: 1,
						deviceId: 'device-before',
						channelMode: 'mono-left',
					},
				],
			};
		});

		await manager.startRecording();

		expect(createdBridges).toHaveLength(1);
		expect(at(createdBridges, 0).stream).toBe(stream);
		expect(at(createdBridges, 0).mode).toBe('mono-left');
		await manager.stopRecording();
	});

	it('bridges only the mono tracks of a mixed multi-track session', async () => {
		createDesktopRecorder();
		const { getAudioStreams } = jest.requireMock(
			'src/recording/AudioStreamHandler',
		);
		const streamA = { getTracks: () => [{ stop: jest.fn() }] };
		const streamB = { getTracks: () => [{ stop: jest.fn() }] };
		getAudioStreams.mockResolvedValue({
			streams: [streamA, streamB],
			trackOrder: [
				{ trackNumber: 1, deviceId: 'a', channelMode: 'mono-left' },
				{ trackNumber: 2, deviceId: 'b', channelMode: 'source' },
			],
		});
		// Track 1: microphone hard-panned left; track 2: a genuine
		// stereo source (e.g. system loopback) that must stay untouched
		mockSettings.trackAudioSources = new Map([
			[1, { deviceId: 'a', channelMode: 'mono-left' as const }],
			[2, { deviceId: 'b', channelMode: 'source' as const }],
		]);

		await manager.startRecording();

		expect(createdBridges).toHaveLength(1);
		expect(at(createdBridges, 0).stream).toBe(streamA);
		expect(at(createdBridges, 0).mode).toBe('mono-left');
		// The source-mode track records its raw stream; the mono track
		// records its bridged stream
		const recorderCtor = global.MediaRecorder as unknown as jest.Mock;
		expect(recorderCtor.mock.calls[0][0]).toBe(
			at(createdBridges, 0).monoStream,
		);
		expect(recorderCtor.mock.calls[1][0]).toBe(streamB);

		await manager.stopRecording();
	});

	it('ignores the global channel setting for multi-track sessions', async () => {
		createDesktopRecorder();
		const { getAudioStreams } = jest.requireMock(
			'src/recording/AudioStreamHandler',
		);
		getAudioStreams.mockResolvedValue({
			streams: [{ getTracks: () => [{ stop: jest.fn() }] }],
			trackOrder: [
				{ trackNumber: 1, deviceId: 'a', channelMode: 'source' },
			],
		});
		// The global mono setting must not leak into a multi-track
		// session whose track asks for the source layout
		mockSettings.recordingChannels = 'mono-mix';
		mockSettings.trackAudioSources = new Map([
			[1, { deviceId: 'a', channelMode: 'source' as const }],
		]);

		await manager.startRecording();

		expect(createdBridges).toHaveLength(0);
		await manager.stopRecording();
	});

	it('releases already-started bridges when a later bridge fails to start', async () => {
		createDesktopRecorder();
		const { getAudioStreams, stopAllStreams } = jest.requireMock(
			'src/recording/AudioStreamHandler',
		);
		getAudioStreams.mockResolvedValue({
			streams: [
				{ getTracks: () => [{ stop: jest.fn() }] },
				{ getTracks: () => [{ stop: jest.fn() }] },
			],
			trackOrder: [],
		});
		mockSettings.recordingChannels = 'mono-mix';
		failBridgeAtIndex = 1;

		await manager.startRecording();

		expect(createdBridges).toHaveLength(2);
		expect(at(createdBridges, 0).release).toHaveBeenCalled();
		expect(at(createdBridges, 1).release).toHaveBeenCalled();
		expect(stopAllStreams).toHaveBeenCalled();
	});

	it('releases bridges on unload cleanup', async () => {
		createDesktopRecorder();
		mockSettings.recordingChannels = 'mono-right';

		await manager.startRecording();
		manager.cleanup();

		expect(at(createdBridges, 0).release).toHaveBeenCalled();
	});

	it('passes the channel mode to the PCM recorders instead of bridging', async () => {
		createDesktopRecorder();
		mockSettings.recordingFormat = 'wav';
		mockSettings.recordingChannels = 'mono-left';

		await manager.startRecording();

		expect(createdBridges).toHaveLength(0);
		expect(pcmRecorderCtorArgs).toHaveLength(1);
		expect(at(pcmRecorderCtorArgs, 0)[3]).toBe('mono-left');

		await manager.stopRecording();
	});

	it('passes per-track modes to the PCM recorders in multi-track WAV sessions', async () => {
		createDesktopRecorder();
		const { getAudioStreams } = jest.requireMock(
			'src/recording/AudioStreamHandler',
		);
		getAudioStreams.mockResolvedValue({
			streams: [
				{ getTracks: () => [{ stop: jest.fn() }] },
				{ getTracks: () => [{ stop: jest.fn() }] },
			],
			trackOrder: [
				{ trackNumber: 1, deviceId: 'a', channelMode: 'mono-right' },
				{ trackNumber: 2, deviceId: 'b', channelMode: 'source' },
			],
		});
		mockSettings.recordingFormat = 'wav';
		mockSettings.trackAudioSources = new Map([
			[1, { deviceId: 'a', channelMode: 'mono-right' as const }],
			[2, { deviceId: 'b', channelMode: 'source' as const }],
		]);

		await manager.startRecording();

		expect(createdBridges).toHaveLength(0);
		expect(pcmRecorderCtorArgs).toHaveLength(2);
		expect(at(pcmRecorderCtorArgs, 0)[3]).toBe('mono-right');
		expect(at(pcmRecorderCtorArgs, 1)[3]).toBe('source');

		await manager.stopRecording();
	});

	it('normalizes an invalid stored channel mode to source', async () => {
		createDesktopRecorder();
		(mockSettings as { recordingChannels: string }).recordingChannels =
			'not-a-mode';

		await manager.startRecording();

		expect(createdBridges).toHaveLength(0);
		await manager.stopRecording();
	});
});
