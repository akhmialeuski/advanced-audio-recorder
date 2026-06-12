/**
 * Unit tests for RecordingManager module.
 * Tests the recording lifecycle: start, stop, pause, resume.
 * @module tests/unit/RecordingManager.test
 */
/** @jest-environment jsdom */

import { RecordingManager } from '../../src/recording/RecordingManager';
import { RecordingStatus } from '../../src/types';
import {
	DEFAULT_SETTINGS,
	AudioRecorderSettings,
} from '../../src/settings/Settings';
import type { App } from 'obsidian';

// Mock obsidian module
jest.mock('obsidian', () => ({
	Notice: jest.fn(),
	MarkdownView: jest.fn(),
	normalizePath: (path: string) => path.replace(/\\/g, '/'),
	Platform: {
		isMobile: false,
		isMobileApp: false,
	},
}));

// Mock AudioStreamHandler
jest.mock('../../src/recording/AudioStreamHandler', () => ({
	getAudioStreams: jest.fn(),
	getAudioSourceName: jest.fn().mockResolvedValue('TestDevice'),
	stopAllStreams: jest.fn(),
	validateSelectedDevices: jest.fn(),
}));

// Mock AudioEncoder module to avoid mediabunny TextDecoder requirement
jest.mock('../../src/recording/AudioEncoder', () => ({
	encodeAudioBuffer: jest
		.fn()
		.mockResolvedValue(new Blob(['encoded'], { type: 'audio/webm' })),
	isOfflineEncodingSupported: jest.fn((format: string) => {
		return ['mp3', 'flac', 'aac', 'webm', 'ogg', 'mp4', 'm4a'].includes(
			format,
		);
	}),
}));

// Mock WavEncoder
jest.mock('../../src/recording/WavEncoder', () => ({
	bufferToWave: jest
		.fn()
		.mockReturnValue(new Blob(['test'], { type: 'audio/wav' })),
	assembleWavFromPcmSegments: jest.fn().mockReturnValue(new ArrayBuffer(44)),
}));

// Mock PcmStreamRecorder
let capturedPcmChunkCallback: ((data: ArrayBuffer) => void) | null = null;
jest.mock('../../src/recording/PcmStreamRecorder', () => ({
	PcmStreamRecorder: jest
		.fn()
		.mockImplementation(
			(
				_stream: MediaStream,
				_sampleRate: number,
				onChunk: (data: ArrayBuffer) => void,
			) => {
				capturedPcmChunkCallback = onChunk;
				return {
					channels: 1,
					sampleRate: 44100,
					start: jest.fn().mockResolvedValue(undefined),
					stop: jest.fn().mockResolvedValue(undefined),
					pause: jest.fn(),
					resume: jest.fn(),
				};
			},
		),
}));

// Mock AudioContext and OfflineAudioContext
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(global as any).AudioContext = jest.fn().mockImplementation(() => ({
	decodeAudioData: jest.fn().mockResolvedValue({
		duration: 1,
		length: 44100,
		sampleRate: 44100,
		numberOfChannels: 1,
		getChannelData: jest.fn().mockReturnValue(new Float32Array(44100)),
	}),
	createBufferSource: jest.fn().mockImplementation(() => ({
		connect: jest.fn(),
		start: jest.fn(),
		buffer: null,
	})),
	destination: {},
	close: jest.fn().mockResolvedValue(undefined),
	sampleRate: 44100,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(global as any).OfflineAudioContext = jest.fn().mockImplementation(() => ({
	createBufferSource: jest.fn().mockImplementation(() => ({
		connect: jest.fn(),
		start: jest.fn(),
		buffer: null,
	})),
	startRendering: jest.fn().mockResolvedValue({
		length: 44100,
		sampleRate: 44100,
		getChannelData: jest.fn().mockReturnValue(new Float32Array(44100)),
	}),
	destination: {},
}));

// Mock AudioBuffer
(global as any).AudioBuffer = jest.fn().mockImplementation(() => ({
	getChannelData: jest.fn().mockReturnValue(new Float32Array(44100)),
}));

if (!Blob.prototype.arrayBuffer) {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test polyfill
	(Blob.prototype as any).arrayBuffer = function (): Promise<ArrayBuffer> {
		return Promise.resolve(new ArrayBuffer(0));
	};
}

describe('RecordingManager', () => {
	let manager: RecordingManager;
	let mockApp: App;
	let mockSettings: AudioRecorderSettings;
	let statusChangeCallback: jest.Mock;
	let consoleErrorSpy: jest.SpyInstance;

	beforeEach(() => {
		// Reset mocks
		jest.clearAllMocks();
		consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();

		// Create mock App
		mockApp = {
			vault: {
				adapter: {
					exists: jest.fn().mockResolvedValue(false),
					rename: jest.fn().mockResolvedValue(undefined),
					readBinary: jest.fn().mockResolvedValue(new ArrayBuffer(0)),
					writeBinary: jest.fn().mockResolvedValue(undefined),
					remove: jest.fn().mockResolvedValue(undefined),
				},
				createBinary: jest.fn().mockResolvedValue(undefined),
				createFolder: jest.fn().mockResolvedValue(undefined),
			},
			workspace: {
				getActiveViewOfType: jest.fn().mockReturnValue(null),
				getActiveFile: jest.fn().mockReturnValue(null),
			},
		} as unknown as App;

		// Use default settings
		mockSettings = { ...DEFAULT_SETTINGS };

		// Status change callback
		statusChangeCallback = jest.fn();

		// Create manager instance
		manager = new RecordingManager(
			mockApp,
			mockSettings,
			statusChangeCallback,
		);
	});

	afterEach(() => {
		consoleErrorSpy.mockRestore();
	});

	describe('constructor', () => {
		it('should initialize with idle status', () => {
			expect(manager.getStatus()).toBe(RecordingStatus.Idle);
		});

		it('should store the status change callback', () => {
			expect(statusChangeCallback).not.toHaveBeenCalled();
		});
	});

	describe('getStatus', () => {
		it('should return Idle initially', () => {
			expect(manager.getStatus()).toBe(RecordingStatus.Idle);
		});
	});

	describe('updateSettings', () => {
		it('should update settings reference', () => {
			const newSettings: AudioRecorderSettings = {
				...DEFAULT_SETTINGS,
				filePrefix: 'new-prefix',
			};

			manager.updateSettings(newSettings);

			// Settings are private, but we can verify through behavior
			expect(manager.getStatus()).toBe(RecordingStatus.Idle);
		});
	});

	describe('toggleRecording', () => {
		beforeEach(() => {
			// Mock MediaRecorder
			const mockMediaRecorder = {
				start: jest.fn(),
				stop: jest.fn(),
				pause: jest.fn(),
				resume: jest.fn(),
				ondataavailable: null as ((event: BlobEvent) => void) | null,
				onerror: null as ((event: Event) => void) | null,
				addEventListener: jest.fn(
					(event: string, handler: () => void) => {
						if (event === 'stop') {
							handler();
						}
					},
				),
			};

			(global as Record<string, unknown>).MediaRecorder = jest.fn(
				() => mockMediaRecorder,
			);

			(global as Record<string, unknown>).MediaRecorder.isTypeSupported =
				jest.fn().mockReturnValue(true);

			// Mock getAudioStreams
			const { getAudioStreams } = jest.requireMock(
				'../../src/recording/AudioStreamHandler',
			);
			getAudioStreams.mockResolvedValue({
				streams: [
					{
						getTracks: () => [{ stop: jest.fn() }],
					},
				],
				trackOrder: [],
			});
		});

		it('should start recording when idle', async () => {
			expect(manager.getStatus()).toBe(RecordingStatus.Idle);

			await manager.toggleRecording();

			expect(manager.getStatus()).toBe(RecordingStatus.Recording);
			expect(statusChangeCallback).toHaveBeenCalledWith(
				RecordingStatus.Recording,
				undefined,
			);
		});

		it('should stop recording when recording', async () => {
			// First start
			await manager.toggleRecording();
			expect(manager.getStatus()).toBe(RecordingStatus.Recording);

			// Then stop
			await manager.toggleRecording();
			expect(manager.getStatus()).toBe(RecordingStatus.Idle);
		});
	});

	describe('togglePauseResume', () => {
		let mockMediaRecorder: {
			start: jest.Mock;
			stop: jest.Mock;
			pause: jest.Mock;
			resume: jest.Mock;
			ondataavailable: ((event: BlobEvent) => void) | null;
			onerror: ((event: Event) => void) | null;
			addEventListener: jest.Mock;
		};

		beforeEach(() => {
			mockMediaRecorder = {
				start: jest.fn(),
				stop: jest.fn(),
				pause: jest.fn(),
				resume: jest.fn(),
				ondataavailable: null,
				onerror: null,
				addEventListener: jest.fn(
					(event: string, handler: () => void) => {
						if (event === 'stop') {
							handler();
						}
					},
				),
			};

			(global as Record<string, unknown>).MediaRecorder = jest.fn(
				() => mockMediaRecorder,
			);

			(global as Record<string, unknown>).MediaRecorder.isTypeSupported =
				jest.fn().mockReturnValue(true);

			const { getAudioStreams } = jest.requireMock(
				'../../src/recording/AudioStreamHandler',
			);
			getAudioStreams.mockResolvedValue({
				streams: [
					{
						getTracks: () => [{ stop: jest.fn() }],
					},
				],
				trackOrder: [],
			});
		});

		it('should do nothing when idle', () => {
			manager.togglePauseResume();

			expect(manager.getStatus()).toBe(RecordingStatus.Idle);
			expect(mockMediaRecorder.pause).not.toHaveBeenCalled();
		});

		it('should pause when recording', async () => {
			await manager.toggleRecording();
			expect(manager.getStatus()).toBe(RecordingStatus.Recording);

			manager.togglePauseResume();

			expect(manager.getStatus()).toBe(RecordingStatus.Paused);
			expect(statusChangeCallback).toHaveBeenCalledWith(
				RecordingStatus.Paused,
				undefined,
			);
		});

		it('should resume when paused', async () => {
			await manager.toggleRecording();
			manager.togglePauseResume(); // Pause
			expect(manager.getStatus()).toBe(RecordingStatus.Paused);

			manager.togglePauseResume(); // Resume

			expect(manager.getStatus()).toBe(RecordingStatus.Recording);
			expect(statusChangeCallback).toHaveBeenCalledWith(
				RecordingStatus.Recording,
				undefined,
			);
		});
	});

	describe('streaming chunks', () => {
		it('should write chunks as segment files on desktop', async () => {
			const { Platform } = jest.requireMock('obsidian');
			Platform.isMobile = false;
			Platform.isMobileApp = false;

			const mockMediaRecorder = {
				start: jest.fn(),
				stop: jest.fn(),
				pause: jest.fn(),
				resume: jest.fn(),
				ondataavailable: null as ((event: BlobEvent) => void) | null,
				onerror: null as ((event: Event) => void) | null,
				addEventListener: jest.fn(
					(event: string, handler: () => void) => {
						if (event === 'stop') {
							handler();
						}
					},
				),
			};

			(global as Record<string, unknown>).MediaRecorder = jest.fn(
				() => mockMediaRecorder,
			);
			(global as Record<string, unknown>).MediaRecorder.isTypeSupported =
				jest.fn().mockReturnValue(true);

			const { getAudioStreams } = jest.requireMock(
				'../../src/recording/AudioStreamHandler',
			);
			getAudioStreams.mockResolvedValue({
				streams: [
					{
						getTracks: () => [{ stop: jest.fn() }],
					},
				],
				trackOrder: [],
			});

			(mockApp.vault.adapter.readBinary as jest.Mock).mockResolvedValue(
				new Uint8Array([1, 2, 3]).buffer,
			);

			await manager.startRecording();

			const chunk = new Blob([new Uint8Array([1, 2, 3])], {
				type: 'audio/webm',
			});
			mockMediaRecorder.ondataavailable?.({ data: chunk } as BlobEvent);

			await manager.stopRecording();

			expect(mockApp.vault.adapter.writeBinary).toHaveBeenCalledWith(
				expect.stringMatching(/-part1\.webm\.tmp$/),
				expect.any(ArrayBuffer),
			);
		});

		it('should flush mobile buffer when limit reached', async () => {
			const { Platform } = jest.requireMock('obsidian');
			Platform.isMobile = true;
			Platform.isMobileApp = true;

			const mockMediaRecorder = {
				start: jest.fn(),
				stop: jest.fn(),
				pause: jest.fn(),
				resume: jest.fn(),
				ondataavailable: null as ((event: BlobEvent) => void) | null,
				onerror: null as ((event: Event) => void) | null,
				addEventListener: jest.fn(
					(event: string, handler: () => void) => {
						if (event === 'stop') {
							handler();
						}
					},
				),
			};

			(global as Record<string, unknown>).MediaRecorder = jest.fn(
				() => mockMediaRecorder,
			);
			(global as Record<string, unknown>).MediaRecorder.isTypeSupported =
				jest.fn().mockReturnValue(true);

			const { getAudioStreams } = jest.requireMock(
				'../../src/recording/AudioStreamHandler',
			);
			getAudioStreams.mockResolvedValue({
				streams: [
					{
						getTracks: () => [{ stop: jest.fn() }],
					},
				],
				trackOrder: [],
			});

			await manager.startRecording();

			const target = (
				manager as unknown as {
					chunkTargets: Array<{ bufferedBytes: number }>;
				}
			).chunkTargets[0];
			target.bufferedBytes = 50 * 1024 * 1024 - 1;

			const chunk = new Blob([new Uint8Array([1])], {
				type: 'audio/webm',
			});
			mockMediaRecorder.ondataavailable?.({ data: chunk } as BlobEvent);

			await manager.stopRecording();

			expect(mockApp.vault.createBinary).toHaveBeenCalled();
		});

		it('should buffer multiple chunks into a single segment file and clean up after finalization', async () => {
			const { Platform } = jest.requireMock('obsidian');
			Platform.isMobile = false;
			Platform.isMobileApp = false;

			const mockMediaRecorder = {
				start: jest.fn(),
				stop: jest.fn(),
				pause: jest.fn(),
				resume: jest.fn(),
				ondataavailable: null as ((event: BlobEvent) => void) | null,
				onerror: null as ((event: Event) => void) | null,
				addEventListener: jest.fn(
					(event: string, handler: () => void) => {
						if (event === 'stop') {
							handler();
						}
					},
				),
			};

			(global as Record<string, unknown>).MediaRecorder = jest.fn(
				() => mockMediaRecorder,
			);
			(global as Record<string, unknown>).MediaRecorder.isTypeSupported =
				jest.fn().mockReturnValue(true);

			const { getAudioStreams } = jest.requireMock(
				'../../src/recording/AudioStreamHandler',
			);
			getAudioStreams.mockResolvedValue({
				streams: [
					{
						getTracks: () => [{ stop: jest.fn() }],
					},
				],
				trackOrder: [],
			});

			(mockApp.vault.adapter.readBinary as jest.Mock).mockResolvedValue(
				new Uint8Array([1, 2, 3]).buffer,
			);

			await manager.startRecording();

			// Send 3 small chunks — all buffered in memory, flushed as 1 segment on stop
			for (let i = 0; i < 3; i++) {
				const chunk = new Blob([new Uint8Array([1, 2, 3])], {
					type: 'audio/webm',
				});
				mockMediaRecorder.ondataavailable?.({
					data: chunk,
				} as BlobEvent);
			}
			await Promise.resolve();

			await manager.stopRecording();

			// 1 combined segment file + 1 final file (instead of 3 + 1 before buffering)
			expect(mockApp.vault.adapter.writeBinary).toHaveBeenCalledWith(
				expect.stringMatching(/-part1\.webm\.tmp$/),
				expect.any(ArrayBuffer),
			);
			// Only 1 segment to clean up
			expect(mockApp.vault.adapter.remove).toHaveBeenCalledTimes(1);
		});

		it('should save multi-track WAV via PCM capture and merge', async () => {
			const { Platform } = jest.requireMock('obsidian');
			Platform.isMobile = false;
			Platform.isMobileApp = false;

			mockSettings = {
				...DEFAULT_SETTINGS,
				enableMultiTrack: true,
				outputMode: 'single',
				recordingFormat: 'wav',
			};
			manager = new RecordingManager(
				mockApp,
				mockSettings,
				statusChangeCallback,
			);

			(global as Record<string, unknown>).MediaRecorder = jest.fn();
			(global as Record<string, unknown>).MediaRecorder.isTypeSupported =
				jest
					.fn()
					.mockImplementation(
						(mime: string) => mime === 'audio/webm',
					);

			const { getAudioStreams } = jest.requireMock(
				'../../src/recording/AudioStreamHandler',
			);
			getAudioStreams.mockResolvedValue({
				streams: [
					{ getTracks: () => [{ stop: jest.fn() }] },
					{ getTracks: () => [{ stop: jest.fn() }] },
				],
				trackOrder: [],
			});

			await manager.startRecording();

			// Simulate PCM chunks for both tracks
			const pcmData = new Int16Array([100, -100, 200, -200]).buffer;
			capturedPcmChunkCallback?.(pcmData);

			await Promise.resolve();
			await manager.stopRecording();

			// Should have created WAV file via mergeAudioTracks path
			expect(mockApp.vault.createBinary).toHaveBeenCalledWith(
				expect.stringMatching(/multitrack-.*\.wav$/),
				expect.any(ArrayBuffer),
			);
		});
	});

	describe('write chain containment', () => {
		interface MutableTarget {
			bufferedBytes: number;
			pcmBufferedBytes: number;
			pendingWrite: Promise<void>;
		}

		/** Microtask+macrotask drain so void'ed chunk handlers settle. */
		const flushAsync = (): Promise<void> =>
			new Promise((resolve) => setTimeout(resolve, 0));

		const getWriteFailureNotices = (): unknown[][] => {
			const { Notice } = jest.requireMock('obsidian');
			return (Notice as jest.Mock).mock.calls.filter((call) =>
				String(call[0]).includes('Failed to write recording data'),
			);
		};

		const createDesktopRecorder = (): {
			ondataavailable: ((event: BlobEvent) => void) | null;
		} => {
			const { Platform } = jest.requireMock('obsidian');
			Platform.isMobile = false;
			Platform.isMobileApp = false;

			const mockMediaRecorder = {
				start: jest.fn(),
				stop: jest.fn(),
				pause: jest.fn(),
				resume: jest.fn(),
				ondataavailable: null as ((event: BlobEvent) => void) | null,
				onerror: null as ((event: Event) => void) | null,
				addEventListener: jest.fn(
					(event: string, handler: () => void) => {
						if (event === 'stop') {
							handler();
						}
					},
				),
			};
			(global as Record<string, unknown>).MediaRecorder = jest.fn(
				() => mockMediaRecorder,
			);
			(global as Record<string, unknown>).MediaRecorder.isTypeSupported =
				jest.fn().mockReturnValue(true);

			const { getAudioStreams } = jest.requireMock(
				'../../src/recording/AudioStreamHandler',
			);
			getAudioStreams.mockResolvedValue({
				streams: [{ getTracks: () => [{ stop: jest.fn() }] }],
				trackOrder: [],
			});

			return mockMediaRecorder;
		};

		const getTarget = (index: number): MutableTarget =>
			(manager as unknown as { chunkTargets: MutableTarget[] })
				.chunkTargets[index];

		it('should keep the chain alive and retry after a failed flush', async () => {
			const recorder = createDesktopRecorder();
			(mockApp.vault.adapter.readBinary as jest.Mock).mockResolvedValue(
				new Uint8Array([1, 2, 3]).buffer,
			);

			await manager.startRecording();
			const target = getTarget(0);

			const writeBinary = mockApp.vault.adapter.writeBinary as jest.Mock;
			writeBinary
				.mockRejectedValueOnce(new Error('disk full'))
				.mockRejectedValueOnce(new Error('disk full'));

			const sendChunk = (): void => {
				// Keep the buffer over the threshold so every chunk
				// triggers a flush attempt
				target.bufferedBytes = 50 * 1024 * 1024 - 1;
				recorder.ondataavailable?.({
					data: new Blob([new Uint8Array([1, 2, 3])], {
						type: 'audio/webm',
					}),
				} as BlobEvent);
			};

			sendChunk();
			await flushAsync();
			sendChunk();
			await flushAsync();

			// Two failed flushes: chain must stay resolvable, one Notice
			await expect(target.pendingWrite).resolves.toBeUndefined();
			expect(getWriteFailureNotices()).toHaveLength(1);
			expect(writeBinary).toHaveBeenCalledTimes(2);

			// Disk "recovers": the next chunk flushes the retained data
			sendChunk();
			await flushAsync();

			expect(writeBinary).toHaveBeenCalledTimes(3);
			expect(writeBinary).toHaveBeenLastCalledWith(
				expect.stringMatching(/-part1\.webm\.tmp$/),
				expect.any(ArrayBuffer),
			);

			await manager.stopRecording();
			expect(manager.getStatus()).toBe(RecordingStatus.Idle);
			expect(mockApp.vault.createBinary).toHaveBeenCalled();
		});

		it('should re-arm the failure Notice after a successful flush', async () => {
			const recorder = createDesktopRecorder();
			await manager.startRecording();
			const target = getTarget(0);

			const writeBinary = mockApp.vault.adapter.writeBinary as jest.Mock;
			const sendChunk = (): void => {
				target.bufferedBytes = 50 * 1024 * 1024 - 1;
				recorder.ondataavailable?.({
					data: new Blob([new Uint8Array([1])], {
						type: 'audio/webm',
					}),
				} as BlobEvent);
			};

			writeBinary.mockRejectedValueOnce(new Error('disk full'));
			sendChunk();
			await flushAsync();
			expect(getWriteFailureNotices()).toHaveLength(1);

			// Successful flush ends the failure streak
			sendChunk();
			await flushAsync();

			// New streak: a second Notice is allowed again
			writeBinary.mockRejectedValueOnce(new Error('disk full'));
			sendChunk();
			await flushAsync();
			expect(getWriteFailureNotices()).toHaveLength(2);

			await manager.stopRecording();
		});

		it('should contain PCM flush failures without dropping later chunks', async () => {
			const { Platform } = jest.requireMock('obsidian');
			Platform.isMobile = false;
			Platform.isMobileApp = false;

			mockSettings = { ...DEFAULT_SETTINGS, recordingFormat: 'wav' };
			manager = new RecordingManager(
				mockApp,
				mockSettings,
				statusChangeCallback,
			);

			const { getAudioStreams } = jest.requireMock(
				'../../src/recording/AudioStreamHandler',
			);
			getAudioStreams.mockResolvedValue({
				streams: [{ getTracks: () => [{ stop: jest.fn() }] }],
				trackOrder: [],
			});
			(mockApp.vault.adapter.readBinary as jest.Mock).mockResolvedValue(
				new Uint8Array([1, 2, 3, 4]).buffer,
			);

			await manager.startRecording();
			const target = getTarget(0);

			const writeBinary = mockApp.vault.adapter.writeBinary as jest.Mock;
			writeBinary.mockRejectedValueOnce(new Error('disk full'));

			const sendPcm = (): void => {
				// Keep the PCM buffer over the threshold so every chunk
				// triggers a flush attempt
				target.pcmBufferedBytes = 50 * 1024 * 1024 - 1;
				capturedPcmChunkCallback?.(new Int16Array([100, -100]).buffer);
			};

			sendPcm();
			await flushAsync();

			await expect(target.pendingWrite).resolves.toBeUndefined();
			expect(getWriteFailureNotices()).toHaveLength(1);

			sendPcm();
			await flushAsync();

			expect(writeBinary).toHaveBeenCalledTimes(2);
			expect(writeBinary).toHaveBeenLastCalledWith(
				expect.stringMatching(/-pcm-part1\.tmp$/),
				expect.any(ArrayBuffer),
			);

			await manager.stopRecording();
			expect(manager.getStatus()).toBe(RecordingStatus.Idle);
		});
	});

	describe('merged output with no audio', () => {
		it('should keep and report segment files when the merged blob is empty', async () => {
			const { Platform } = jest.requireMock('obsidian');
			Platform.isMobile = false;
			Platform.isMobileApp = false;

			mockSettings = {
				...DEFAULT_SETTINGS,
				enableMultiTrack: true,
				outputMode: 'single',
				recordingFormat: 'wav',
			};
			manager = new RecordingManager(
				mockApp,
				mockSettings,
				statusChangeCallback,
			);

			(global as Record<string, unknown>).MediaRecorder = jest.fn();
			(global as Record<string, unknown>).MediaRecorder.isTypeSupported =
				jest
					.fn()
					.mockImplementation(
						(mime: string) => mime === 'audio/webm',
					);

			const { getAudioStreams } = jest.requireMock(
				'../../src/recording/AudioStreamHandler',
			);
			getAudioStreams.mockResolvedValue({
				streams: [
					{ getTracks: () => [{ stop: jest.fn() }] },
					{ getTracks: () => [{ stop: jest.fn() }] },
				],
				trackOrder: [],
			});

			// The mixed render encodes to an empty blob: nothing to save
			const { bufferToWave } = jest.requireMock(
				'../../src/recording/WavEncoder',
			);
			bufferToWave.mockReturnValueOnce(new Blob([]));

			await manager.startRecording();

			const pcmData = new Int16Array([100, -100, 200, -200]).buffer;
			capturedPcmChunkCallback?.(pcmData);
			await Promise.resolve();

			await manager.stopRecording();

			// No final file, no cleanup of the only remaining audio copy
			expect(mockApp.vault.createBinary).not.toHaveBeenCalledWith(
				expect.stringMatching(/multitrack-.*\.wav$/),
				expect.anything(),
			);
			expect(mockApp.vault.adapter.remove).not.toHaveBeenCalled();

			const { Notice } = jest.requireMock('obsidian');
			const keptNotice = (Notice as jest.Mock).mock.calls.find((call) =>
				String(call[0]).includes('Temporary track files were kept'),
			);
			expect(keptNotice).toBeDefined();
			expect(manager.getStatus()).toBe(RecordingStatus.Idle);
		});
	});

	describe('track file base names', () => {
		const setupTwoTrackRecording = (
			trackOrder: { trackNumber: number; deviceId: string }[],
		): void => {
			const { Platform } = jest.requireMock('obsidian');
			Platform.isMobile = false;
			Platform.isMobileApp = false;

			const mockMediaRecorder = {
				start: jest.fn(),
				stop: jest.fn(),
				pause: jest.fn(),
				resume: jest.fn(),
				ondataavailable: null as ((event: BlobEvent) => void) | null,
				onerror: null as ((event: Event) => void) | null,
				addEventListener: jest.fn(
					(event: string, handler: () => void) => {
						if (event === 'stop') {
							handler();
						}
					},
				),
			};
			(global as Record<string, unknown>).MediaRecorder = jest.fn(
				() => mockMediaRecorder,
			);
			(global as Record<string, unknown>).MediaRecorder.isTypeSupported =
				jest.fn().mockReturnValue(true);

			const { getAudioStreams } = jest.requireMock(
				'../../src/recording/AudioStreamHandler',
			);
			getAudioStreams.mockResolvedValue({
				streams: [
					{ getTracks: () => [{ stop: jest.fn() }] },
					{ getTracks: () => [{ stop: jest.fn() }] },
				],
				trackOrder,
			});
		};

		const getTargets = (): { fileBaseName: string; sourceName: string }[] =>
			(
				manager as unknown as {
					chunkTargets: {
						fileBaseName: string;
						sourceName: string;
					}[];
				}
			).chunkTargets;

		it('should append track numbers when tracks share a device', async () => {
			mockSettings = {
				...DEFAULT_SETTINGS,
				enableMultiTrack: true,
				useSourceNamesForTracks: true,
				outputMode: 'multiple',
			};
			manager = new RecordingManager(
				mockApp,
				mockSettings,
				statusChangeCallback,
			);
			setupTwoTrackRecording([
				{ trackNumber: 1, deviceId: 'shared-device' },
				{ trackNumber: 2, deviceId: 'shared-device' },
			]);

			await manager.startRecording();

			const targets = getTargets();
			expect(targets).toHaveLength(2);
			expect(targets[0].sourceName).toBe('TestDevice-1');
			expect(targets[1].sourceName).toBe('TestDevice-2');
			expect(targets[0].fileBaseName).not.toBe(targets[1].fileBaseName);

			await manager.stopRecording();
		});

		it('should keep plain source names when they are unique', async () => {
			const { getAudioSourceName } = jest.requireMock(
				'../../src/recording/AudioStreamHandler',
			);
			getAudioSourceName
				.mockResolvedValueOnce('DeviceA')
				.mockResolvedValueOnce('DeviceB');

			mockSettings = {
				...DEFAULT_SETTINGS,
				enableMultiTrack: true,
				useSourceNamesForTracks: true,
				outputMode: 'multiple',
			};
			manager = new RecordingManager(
				mockApp,
				mockSettings,
				statusChangeCallback,
			);
			setupTwoTrackRecording([
				{ trackNumber: 1, deviceId: 'device-a' },
				{ trackNumber: 2, deviceId: 'device-b' },
			]);

			await manager.startRecording();

			const targets = getTargets();
			expect(targets[0].sourceName).toBe('DeviceA');
			expect(targets[1].sourceName).toBe('DeviceB');

			await manager.stopRecording();
		});
	});

	describe('stopMediaRecorder watchdog', () => {
		afterEach(() => {
			jest.useRealTimers();
		});

		it('should finish stopping when the stop event never fires', async () => {
			const { Platform } = jest.requireMock('obsidian');
			Platform.isMobile = false;
			Platform.isMobileApp = false;

			// Recorder whose stop event never arrives (dead audio subsystem)
			const mockMediaRecorder = {
				start: jest.fn(),
				stop: jest.fn(),
				pause: jest.fn(),
				resume: jest.fn(),
				state: 'recording',
				ondataavailable: null as ((event: BlobEvent) => void) | null,
				onerror: null as ((event: Event) => void) | null,
				addEventListener: jest.fn(),
			};
			(global as Record<string, unknown>).MediaRecorder = jest.fn(
				() => mockMediaRecorder,
			);
			(global as Record<string, unknown>).MediaRecorder.isTypeSupported =
				jest.fn().mockReturnValue(true);

			const { getAudioStreams } = jest.requireMock(
				'../../src/recording/AudioStreamHandler',
			);
			getAudioStreams.mockResolvedValue({
				streams: [{ getTracks: () => [{ stop: jest.fn() }] }],
				trackOrder: [],
			});

			await manager.startRecording();

			jest.useFakeTimers();
			const stopPromise = manager.stopRecording();
			await jest.advanceTimersByTimeAsync(5000);
			await stopPromise;

			expect(manager.getStatus()).toBe(RecordingStatus.Idle);
			expect(consoleErrorSpy).toHaveBeenCalledWith(
				expect.stringContaining('stop event did not arrive'),
			);
		});

		it('should resolve when stop() throws on a racing recorder', async () => {
			const { Platform } = jest.requireMock('obsidian');
			Platform.isMobile = false;
			Platform.isMobileApp = false;

			const mockMediaRecorder = {
				start: jest.fn(),
				stop: jest.fn(() => {
					throw new Error('InvalidStateError');
				}),
				pause: jest.fn(),
				resume: jest.fn(),
				state: 'recording',
				ondataavailable: null as ((event: BlobEvent) => void) | null,
				onerror: null as ((event: Event) => void) | null,
				addEventListener: jest.fn(),
			};
			(global as Record<string, unknown>).MediaRecorder = jest.fn(
				() => mockMediaRecorder,
			);
			(global as Record<string, unknown>).MediaRecorder.isTypeSupported =
				jest.fn().mockReturnValue(true);

			const { getAudioStreams } = jest.requireMock(
				'../../src/recording/AudioStreamHandler',
			);
			getAudioStreams.mockResolvedValue({
				streams: [{ getTracks: () => [{ stop: jest.fn() }] }],
				trackOrder: [],
			});

			await manager.startRecording();
			await manager.stopRecording();

			expect(manager.getStatus()).toBe(RecordingStatus.Idle);
		});
	});

	describe('cleanup', () => {
		it('should reset all internal state', () => {
			manager.cleanup();

			expect(manager.getStatus()).toBe(RecordingStatus.Idle);
		});

		it('should stop all streams', () => {
			const { stopAllStreams } = jest.requireMock(
				'../../src/recording/AudioStreamHandler',
			);

			manager.cleanup();

			expect(stopAllStreams).toHaveBeenCalled();
		});
	});

	describe('stopRecording error recovery', () => {
		let mockStopTrack: jest.Mock;

		beforeEach(() => {
			mockStopTrack = jest.fn();

			const mockMediaRecorder = {
				start: jest.fn(),
				stop: jest.fn(),
				pause: jest.fn(),
				resume: jest.fn(),
				ondataavailable: null as ((event: BlobEvent) => void) | null,
				onerror: null as ((event: Event) => void) | null,
				addEventListener: jest.fn(
					(event: string, handler: () => void) => {
						if (event === 'stop') {
							handler();
						}
					},
				),
			};

			(global as Record<string, unknown>).MediaRecorder = jest.fn(
				() => mockMediaRecorder,
			);

			(global as Record<string, unknown>).MediaRecorder.isTypeSupported =
				jest.fn().mockReturnValue(true);

			const { getAudioStreams } = jest.requireMock(
				'../../src/recording/AudioStreamHandler',
			);
			getAudioStreams.mockResolvedValue({
				streams: [
					{
						getTracks: () => [{ stop: mockStopTrack }],
					},
				],
				trackOrder: [],
			});
		});

		it('should reset status to Idle even when save fails', async () => {
			// Start recording first
			await manager.startRecording();
			expect(manager.getStatus()).toBe(RecordingStatus.Recording);

			// Mock vault to throw error during save
			(mockApp.vault.adapter.rename as jest.Mock).mockRejectedValue(
				new Error('Save failed'),
			);

			// Stop recording - should recover
			await manager.stopRecording();

			// Status should be Idle despite error
			expect(manager.getStatus()).toBe(RecordingStatus.Idle);
			expect(statusChangeCallback).toHaveBeenLastCalledWith(
				RecordingStatus.Idle,
				undefined,
			);
		});

		it('should stop streams even when save fails', async () => {
			const { stopAllStreams } = jest.requireMock(
				'../../src/recording/AudioStreamHandler',
			);

			await manager.startRecording();

			// Mock vault to throw error during save
			(mockApp.vault.adapter.rename as jest.Mock).mockRejectedValue(
				new Error('Save failed'),
			);

			await manager.stopRecording();

			// Streams should still be stopped
			expect(stopAllStreams).toHaveBeenCalled();
		});

		it('should clear all arrays after stop', async () => {
			await manager.startRecording();
			await manager.stopRecording();

			// Internal state should be cleared - verify by starting a new recording
			// If arrays weren't cleared, this would have stale data
			expect(manager.getStatus()).toBe(RecordingStatus.Idle);
		});
	});

	describe('startRecording error handling', () => {
		it('should configure MediaRecorder with bitrate from settings', async () => {
			mockSettings = {
				...DEFAULT_SETTINGS,
				bitrate: 192000,
			};
			manager = new RecordingManager(
				mockApp,
				mockSettings,
				statusChangeCallback,
			);

			const mockMediaRecorder = {
				start: jest.fn(),
				stop: jest.fn(),
				pause: jest.fn(),
				resume: jest.fn(),
				ondataavailable: null as ((event: BlobEvent) => void) | null,
				onerror: null as ((event: Event) => void) | null,
				addEventListener: jest.fn(
					(event: string, handler: () => void) => {
						if (event === 'stop') {
							handler();
						}
					},
				),
			};

			(global as Record<string, unknown>).MediaRecorder = jest.fn(
				() => mockMediaRecorder,
			);
			(global as Record<string, unknown>).MediaRecorder.isTypeSupported =
				jest.fn().mockReturnValue(true);

			const { getAudioStreams } = jest.requireMock(
				'../../src/recording/AudioStreamHandler',
			);
			getAudioStreams.mockResolvedValue({
				streams: [
					{
						getTracks: () => [{ stop: jest.fn() }],
					},
				],
				trackOrder: [],
			});

			await manager.startRecording();

			expect(global.MediaRecorder).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({
					audioBitsPerSecond: 192000,
				}),
			);
		});

		it('should handle unsupported format', async () => {
			(global as Record<string, unknown>).MediaRecorder = {
				isTypeSupported: jest.fn().mockReturnValue(false),
			};

			await manager.startRecording();

			// Should remain idle on error
			expect(manager.getStatus()).toBe(RecordingStatus.Idle);
		});

		it('should handle stream acquisition error', async () => {
			(global as Record<string, unknown>).MediaRecorder = {
				isTypeSupported: jest.fn().mockReturnValue(true),
			};

			const { getAudioStreams } = jest.requireMock(
				'../../src/recording/AudioStreamHandler',
			);
			getAudioStreams.mockRejectedValue(new Error('Permission denied'));

			await manager.startRecording();

			expect(manager.getStatus()).toBe(RecordingStatus.Idle);
		});
	});

	describe('lifecycle transitions', () => {
		beforeEach(() => {
			const mockMediaRecorder = {
				start: jest.fn(),
				stop: jest.fn(),
				pause: jest.fn(),
				resume: jest.fn(),
				ondataavailable: null as ((event: BlobEvent) => void) | null,
				onerror: null as ((event: Event) => void) | null,
				addEventListener: jest.fn(
					(event: string, handler: () => void) => {
						if (event === 'stop') {
							handler();
						}
					},
				),
			};

			(global as Record<string, unknown>).MediaRecorder = jest.fn(
				() => mockMediaRecorder,
			);

			(global as Record<string, unknown>).MediaRecorder.isTypeSupported =
				jest.fn().mockReturnValue(true);

			const { getAudioStreams } = jest.requireMock(
				'../../src/recording/AudioStreamHandler',
			);
			getAudioStreams.mockResolvedValue({
				streams: [
					{
						getTracks: () => [{ stop: jest.fn() }],
					},
				],
				trackOrder: [],
			});
		});

		it('should follow full lifecycle: idle -> recording -> paused -> recording -> idle', async () => {
			expect(manager.getStatus()).toBe(RecordingStatus.Idle);

			// Start recording
			await manager.toggleRecording();
			expect(manager.getStatus()).toBe(RecordingStatus.Recording);

			// Pause
			manager.togglePauseResume();
			expect(manager.getStatus()).toBe(RecordingStatus.Paused);

			// Resume
			manager.togglePauseResume();
			expect(manager.getStatus()).toBe(RecordingStatus.Recording);

			// Stop
			await manager.toggleRecording();
			expect(manager.getStatus()).toBe(RecordingStatus.Idle);
		});

		it('should call onStatusChange for each transition', async () => {
			await manager.toggleRecording();
			manager.togglePauseResume();
			manager.togglePauseResume();
			await manager.toggleRecording();

			// Recording, Paused, Recording, Saving(0%), Saving(20%), Saving(100%), Idle
			expect(statusChangeCallback).toHaveBeenNthCalledWith(
				1,
				RecordingStatus.Recording,
				undefined,
			);
			expect(statusChangeCallback).toHaveBeenNthCalledWith(
				2,
				RecordingStatus.Paused,
				undefined,
			);
			expect(statusChangeCallback).toHaveBeenNthCalledWith(
				3,
				RecordingStatus.Recording,
				undefined,
			);
			// Saving progress callbacks
			expect(statusChangeCallback).toHaveBeenCalledWith(
				RecordingStatus.Saving,
				expect.objectContaining({ percent: 0 }),
			);
			// Final idle
			expect(statusChangeCallback).toHaveBeenLastCalledWith(
				RecordingStatus.Idle,
				undefined,
			);
		});
	});

	describe('single mode output format handling', () => {
		/**
		 * Verifies that single-file output in multi-track mode produces
		 * the configured format via offline encoding when supported.
		 */
		it('should save single-mode multi-track recording in configured format via offline encoding', async () => {
			const { Platform } = jest.requireMock('obsidian');
			Platform.isMobile = false;
			Platform.isMobileApp = false;

			mockSettings = {
				...DEFAULT_SETTINGS,
				enableMultiTrack: true,
				outputMode: 'single',
				recordingFormat: 'webm',
			};
			manager = new RecordingManager(
				mockApp,
				mockSettings,
				statusChangeCallback,
			);

			const mockMediaRecorders = [0, 1].map(() => ({
				start: jest.fn(),
				stop: jest.fn(),
				pause: jest.fn(),
				resume: jest.fn(),
				ondataavailable: null as ((event: BlobEvent) => void) | null,
				onerror: null as ((event: Event) => void) | null,
				addEventListener: jest.fn(
					(event: string, handler: () => void) => {
						if (event === 'stop') {
							handler();
						}
					},
				),
			}));
			let recorderIndex = 0;

			(global as Record<string, unknown>).MediaRecorder = jest.fn(() => {
				const recorder =
					mockMediaRecorders[recorderIndex] ?? mockMediaRecorders[0];
				recorderIndex += 1;
				return recorder;
			});
			(global as Record<string, unknown>).MediaRecorder.isTypeSupported =
				jest.fn().mockReturnValue(true);

			const { getAudioStreams } = jest.requireMock(
				'../../src/recording/AudioStreamHandler',
			);
			getAudioStreams.mockResolvedValue({
				streams: [
					{ getTracks: () => [{ stop: jest.fn() }] },
					{ getTracks: () => [{ stop: jest.fn() }] },
				],
				trackOrder: [],
			});

			(mockApp.vault.adapter.readBinary as jest.Mock).mockResolvedValue(
				new Uint8Array([1, 2, 3]).buffer,
			);

			await manager.startRecording();

			const chunk = new Blob([new Uint8Array([1, 2, 3])], {
				type: 'audio/webm',
			});
			mockMediaRecorders.forEach((recorder) => {
				recorder.ondataavailable?.({ data: chunk } as BlobEvent);
			});

			await Promise.resolve();
			await manager.stopRecording();

			// Multi-track single output encodes to target format (webm) via offline encoding
			expect(mockApp.vault.createBinary).toHaveBeenCalledWith(
				expect.stringMatching(/multitrack-.*\.webm$/),
				expect.any(ArrayBuffer),
			);
			expect(mockApp.vault.adapter.remove).toHaveBeenCalledWith(
				expect.stringMatching(/-part\d+\.webm\.tmp$/),
			);
			// Verify proper audio mixing was used
			expect(global.OfflineAudioContext).toHaveBeenCalled();
		});

		it('should rollback merged output when cleanup of temporary partial files fails', async () => {
			const { Notice } = jest.requireMock('obsidian');

			const consoleWarnSpy = jest
				.spyOn(console, 'warn')
				.mockImplementation(() => {});

			const { Platform } = jest.requireMock('obsidian');
			Platform.isMobile = false;
			Platform.isMobileApp = false;

			mockSettings = {
				...DEFAULT_SETTINGS,
				enableMultiTrack: true,
				outputMode: 'single',
				recordingFormat: 'webm',
			};
			manager = new RecordingManager(
				mockApp,
				mockSettings,
				statusChangeCallback,
			);

			const mockMediaRecorders = [0, 1].map(() => ({
				start: jest.fn(),
				stop: jest.fn(),
				pause: jest.fn(),
				resume: jest.fn(),
				ondataavailable: null as ((event: BlobEvent) => void) | null,
				onerror: null as ((event: Event) => void) | null,
				addEventListener: jest.fn(
					(event: string, handler: () => void) => {
						if (event === 'stop') {
							handler();
						}
					},
				),
			}));
			let recorderIndex = 0;

			(global as Record<string, unknown>).MediaRecorder = jest.fn(() => {
				const recorder =
					mockMediaRecorders[recorderIndex] ?? mockMediaRecorders[0];
				recorderIndex += 1;
				return recorder;
			});
			(global as Record<string, unknown>).MediaRecorder.isTypeSupported =
				jest.fn().mockReturnValue(true);

			const { getAudioStreams } = jest.requireMock(
				'../../src/recording/AudioStreamHandler',
			);
			getAudioStreams.mockResolvedValue({
				streams: [
					{ getTracks: () => [{ stop: jest.fn() }] },
					{ getTracks: () => [{ stop: jest.fn() }] },
				],
				trackOrder: [],
			});

			(mockApp.vault.adapter.readBinary as jest.Mock).mockResolvedValue(
				new Uint8Array([1, 2, 3]).buffer,
			);
			(mockApp.vault.adapter.remove as jest.Mock).mockImplementation(
				async (path: string) => {
					if (path.includes('.tmp')) {
						throw new Error('cleanup failed');
					}
					return undefined;
				},
			);

			await manager.startRecording();

			const chunk = new Blob([new Uint8Array([1, 2, 3])], {
				type: 'audio/webm',
			});
			mockMediaRecorders.forEach((recorder) => {
				recorder.ondataavailable?.({ data: chunk } as BlobEvent);
			});

			await Promise.resolve();
			await manager.stopRecording();

			expect(mockApp.vault.createBinary).toHaveBeenCalledWith(
				expect.stringMatching(/multitrack-.*\.webm$/),
				expect.any(ArrayBuffer),
			);
			expect(mockApp.vault.adapter.remove).toHaveBeenCalledWith(
				expect.stringMatching(/multitrack-.*\.webm$/),
			);
			expect(Notice).toHaveBeenCalledWith(
				expect.stringContaining('Error stopping recording:'),
			);
			expect(consoleWarnSpy).toHaveBeenCalledWith(
				expect.stringContaining('[AudioRecorder]'),
				expect.objectContaining({
					error: expect.objectContaining({
						message: 'cleanup failed',
					}),
				}),
			);

			consoleWarnSpy.mockRestore();
		});

		/**
		 * Regression: multi-track MP4 must produce a properly mixed/encoded file
		 * via OfflineAudioContext instead of broken concatenated MP4 containers.
		 */
		it('should merge MP4 multi-track recording into target format with all tracks mixed', async () => {
			const { Platform } = jest.requireMock('obsidian');
			Platform.isMobile = false;
			Platform.isMobileApp = false;

			mockSettings = {
				...DEFAULT_SETTINGS,
				enableMultiTrack: true,
				outputMode: 'single',
				recordingFormat: 'mp4',
			};
			manager = new RecordingManager(
				mockApp,
				mockSettings,
				statusChangeCallback,
			);

			const mockMediaRecorders = [0, 1].map(() => ({
				start: jest.fn(),
				stop: jest.fn(),
				pause: jest.fn(),
				resume: jest.fn(),
				ondataavailable: null as ((event: BlobEvent) => void) | null,
				onerror: null as ((event: Event) => void) | null,
				addEventListener: jest.fn(
					(event: string, handler: () => void) => {
						if (event === 'stop') {
							handler();
						}
					},
				),
			}));
			let recorderIndex = 0;

			(global as Record<string, unknown>).MediaRecorder = jest.fn(() => {
				const recorder =
					mockMediaRecorders[recorderIndex] ?? mockMediaRecorders[0];
				recorderIndex += 1;
				return recorder;
			});
			(global as Record<string, unknown>).MediaRecorder.isTypeSupported =
				jest.fn().mockReturnValue(true);

			const { getAudioStreams } = jest.requireMock(
				'../../src/recording/AudioStreamHandler',
			);
			getAudioStreams.mockResolvedValue({
				streams: [
					{ getTracks: () => [{ stop: jest.fn() }] },
					{ getTracks: () => [{ stop: jest.fn() }] },
				],
				trackOrder: [],
			});

			(mockApp.vault.adapter.readBinary as jest.Mock).mockResolvedValue(
				new Uint8Array([1, 2, 3]).buffer,
			);

			await manager.startRecording();

			const chunk = new Blob([new Uint8Array([1, 2, 3])], {
				type: 'audio/mp4',
			});
			mockMediaRecorders.forEach((recorder) => {
				recorder.ondataavailable?.({ data: chunk } as BlobEvent);
			});

			await Promise.resolve();
			await manager.stopRecording();

			// Must produce MP4 (properly mixed via OfflineAudioContext + offline encoding)
			expect(mockApp.vault.createBinary).toHaveBeenCalledWith(
				expect.stringMatching(/multitrack-.*\.mp4$/),
				expect.any(ArrayBuffer),
			);
			// OfflineAudioContext should have been used for mixing
			expect(global.OfflineAudioContext).toHaveBeenCalled();
		});

		/**
		 * Ensures that WAV output mode uses direct PCM capture on desktop
		 * and writes files with .wav extension assembled from PCM segments.
		 */
		it('should convert to wav only when output format is wav', async () => {
			mockSettings = {
				...DEFAULT_SETTINGS,
				recordingFormat: 'wav',
			};
			manager = new RecordingManager(
				mockApp,
				mockSettings,
				statusChangeCallback,
			);

			(global as Record<string, unknown>).MediaRecorder = jest.fn();
			(global as Record<string, unknown>).MediaRecorder.isTypeSupported =
				jest
					.fn()
					.mockImplementation(
						(mime: string) => mime === 'audio/webm',
					);

			const { getAudioStreams } = jest.requireMock(
				'../../src/recording/AudioStreamHandler',
			);
			getAudioStreams.mockResolvedValue({
				streams: [
					{
						getTracks: () => [{ stop: jest.fn() }],
					},
				],
				trackOrder: [],
			});

			await manager.startRecording();

			// Simulate PCM chunk via captured callback
			const pcmData = new Int16Array([100, -100, 200, -200]).buffer;
			capturedPcmChunkCallback?.(pcmData);

			await Promise.resolve();
			await manager.stopRecording();

			expect(mockApp.vault.createBinary).toHaveBeenCalledWith(
				expect.stringMatching(/\.wav$/),
				expect.any(ArrayBuffer),
			);
			expect(mockApp.vault.adapter.rename).not.toHaveBeenCalled();
		});
	});

	describe('context-aware save location', () => {
		it('should save near active markdown file when enabled without subfolder', async () => {
			mockSettings = {
				...DEFAULT_SETTINGS,
				saveNearActiveFile: true,
				activeFileSubfolder: '',
			};
			manager = new RecordingManager(
				mockApp,
				mockSettings,
				statusChangeCallback,
			);
			(mockApp.workspace.getActiveFile as jest.Mock).mockReturnValue({
				path: 'Meetings/2026/Meeting Note.md',
			});

			const mockMediaRecorder = {
				start: jest.fn(),
				stop: jest.fn(),
				pause: jest.fn(),
				resume: jest.fn(),
				ondataavailable: null as ((event: BlobEvent) => void) | null,
				onerror: null as ((event: Event) => void) | null,
				addEventListener: jest.fn(
					(event: string, handler: () => void) => {
						if (event === 'stop') {
							handler();
						}
					},
				),
			};

			(global as Record<string, unknown>).MediaRecorder = jest.fn(
				() => mockMediaRecorder,
			);
			(global as Record<string, unknown>).MediaRecorder.isTypeSupported =
				jest.fn().mockReturnValue(true);

			const { getAudioStreams } = jest.requireMock(
				'../../src/recording/AudioStreamHandler',
			);
			getAudioStreams.mockResolvedValue({
				streams: [{ getTracks: () => [{ stop: jest.fn() }] }],
				trackOrder: [],
			});

			await manager.startRecording();

			const chunk = new Blob([new Uint8Array([1, 2, 3])], {
				type: 'audio/webm',
			});
			mockMediaRecorder.ondataavailable?.({ data: chunk } as BlobEvent);
			await Promise.resolve();

			await manager.stopRecording();

			expect(mockApp.vault.adapter.writeBinary).toHaveBeenCalledWith(
				expect.stringMatching(
					/^Meetings\/2026\/recording-Track1-.*-part1\.webm\.tmp$/,
				),
				expect.any(ArrayBuffer),
			);
		});

		it('should create active file subfolder and save recording there', async () => {
			mockSettings = {
				...DEFAULT_SETTINGS,
				saveNearActiveFile: true,
				activeFileSubfolder: 'Audio',
			};
			manager = new RecordingManager(
				mockApp,
				mockSettings,
				statusChangeCallback,
			);
			(mockApp.workspace.getActiveFile as jest.Mock).mockReturnValue({
				path: 'Meetings/2026/Meeting Note.md',
			});

			const mockMediaRecorder = {
				start: jest.fn(),
				stop: jest.fn(),
				pause: jest.fn(),
				resume: jest.fn(),
				ondataavailable: null as ((event: BlobEvent) => void) | null,
				onerror: null as ((event: Event) => void) | null,
				addEventListener: jest.fn(
					(event: string, handler: () => void) => {
						if (event === 'stop') {
							handler();
						}
					},
				),
			};

			(global as Record<string, unknown>).MediaRecorder = jest.fn(
				() => mockMediaRecorder,
			);
			(global as Record<string, unknown>).MediaRecorder.isTypeSupported =
				jest.fn().mockReturnValue(true);

			const { getAudioStreams } = jest.requireMock(
				'../../src/recording/AudioStreamHandler',
			);
			getAudioStreams.mockResolvedValue({
				streams: [{ getTracks: () => [{ stop: jest.fn() }] }],
				trackOrder: [],
			});

			await manager.startRecording();

			const chunk = new Blob([new Uint8Array([1, 2, 3])], {
				type: 'audio/webm',
			});
			mockMediaRecorder.ondataavailable?.({ data: chunk } as BlobEvent);
			await Promise.resolve();

			await manager.stopRecording();

			expect(mockApp.vault.createFolder).toHaveBeenCalledWith(
				'Meetings/2026/Audio',
			);
			expect(mockApp.vault.adapter.writeBinary).toHaveBeenCalledWith(
				expect.stringMatching(
					/^Meetings\/2026\/Audio\/recording-Track1-.*-part1\.webm\.tmp$/,
				),
				expect.any(ArrayBuffer),
			);
		});

		it('should fallback to global save folder when near-active mode is disabled', async () => {
			mockSettings = {
				...DEFAULT_SETTINGS,
				saveFolder: 'Recordings',
				saveNearActiveFile: false,
				activeFileSubfolder: 'Audio',
			};
			manager = new RecordingManager(
				mockApp,
				mockSettings,
				statusChangeCallback,
			);
			(mockApp.workspace.getActiveFile as jest.Mock).mockReturnValue({
				path: 'Meetings/2026/Meeting Note.md',
			});

			const mockMediaRecorder = {
				start: jest.fn(),
				stop: jest.fn(),
				pause: jest.fn(),
				resume: jest.fn(),
				ondataavailable: null as ((event: BlobEvent) => void) | null,
				onerror: null as ((event: Event) => void) | null,
				addEventListener: jest.fn(
					(event: string, handler: () => void) => {
						if (event === 'stop') {
							handler();
						}
					},
				),
			};

			(global as Record<string, unknown>).MediaRecorder = jest.fn(
				() => mockMediaRecorder,
			);
			(global as Record<string, unknown>).MediaRecorder.isTypeSupported =
				jest.fn().mockReturnValue(true);

			const { getAudioStreams } = jest.requireMock(
				'../../src/recording/AudioStreamHandler',
			);
			getAudioStreams.mockResolvedValue({
				streams: [{ getTracks: () => [{ stop: jest.fn() }] }],
				trackOrder: [],
			});

			await manager.startRecording();

			const chunk = new Blob([new Uint8Array([1, 2, 3])], {
				type: 'audio/webm',
			});
			mockMediaRecorder.ondataavailable?.({ data: chunk } as BlobEvent);
			await Promise.resolve();

			await manager.stopRecording();

			expect(mockApp.vault.adapter.writeBinary).toHaveBeenCalledWith(
				expect.stringMatching(
					/^Recordings\/recording-Track1-.*-part1\.webm\.tmp$/,
				),
				expect.any(ArrayBuffer),
			);
		});
	});

	describe('insertFileLinks uses basename only', () => {
		it('should insert only filename without directory path in wikilinks', async () => {
			const mockReplaceSelection = jest.fn();
			(
				mockApp.workspace.getActiveViewOfType as jest.Mock
			).mockReturnValue({
				editor: { replaceSelection: mockReplaceSelection },
			});

			const mockMediaRecorder = {
				start: jest.fn(),
				stop: jest.fn(),
				pause: jest.fn(),
				resume: jest.fn(),
				ondataavailable: null as ((event: BlobEvent) => void) | null,
				onerror: null as ((event: Event) => void) | null,
				addEventListener: jest.fn(
					(event: string, handler: () => void) => {
						if (event === 'stop') {
							handler();
						}
					},
				),
			};

			(global as Record<string, unknown>).MediaRecorder = jest.fn(
				() => mockMediaRecorder,
			);
			(global as Record<string, unknown>).MediaRecorder.isTypeSupported =
				jest.fn().mockReturnValue(true);

			const { getAudioStreams } = jest.requireMock(
				'../../src/recording/AudioStreamHandler',
			);
			getAudioStreams.mockResolvedValue({
				streams: [{ getTracks: () => [{ stop: jest.fn() }] }],
				trackOrder: [],
			});

			(mockApp.vault.adapter.readBinary as jest.Mock).mockResolvedValue(
				new Uint8Array([1, 2, 3]).buffer,
			);

			await manager.startRecording();

			const chunk = new Blob([new Uint8Array([1, 2, 3])], {
				type: 'audio/webm',
			});
			mockMediaRecorder.ondataavailable?.({ data: chunk } as BlobEvent);
			await Promise.resolve();

			await manager.stopRecording();

			expect(mockReplaceSelection).toHaveBeenCalled();
			const insertedText = mockReplaceSelection.mock
				.calls[0][0] as string;
			expect(insertedText).not.toContain('/');
			expect(insertedText).toMatch(/^!\[\[recording-.*\]\]$/);
		});

		it('should use basename when file is saved in a nested directory', async () => {
			mockSettings = {
				...DEFAULT_SETTINGS,
				saveNearActiveFile: true,
				activeFileSubfolder: 'Audio',
			};
			manager = new RecordingManager(
				mockApp,
				mockSettings,
				statusChangeCallback,
			);
			(mockApp.workspace.getActiveFile as jest.Mock).mockReturnValue({
				path: 'Projects/Notes/Daily.md',
			});

			const mockReplaceSelection = jest.fn();
			(
				mockApp.workspace.getActiveViewOfType as jest.Mock
			).mockReturnValue({
				editor: { replaceSelection: mockReplaceSelection },
			});

			const mockMediaRecorder = {
				start: jest.fn(),
				stop: jest.fn(),
				pause: jest.fn(),
				resume: jest.fn(),
				ondataavailable: null as ((event: BlobEvent) => void) | null,
				onerror: null as ((event: Event) => void) | null,
				addEventListener: jest.fn(
					(event: string, handler: () => void) => {
						if (event === 'stop') {
							handler();
						}
					},
				),
			};

			(global as Record<string, unknown>).MediaRecorder = jest.fn(
				() => mockMediaRecorder,
			);
			(global as Record<string, unknown>).MediaRecorder.isTypeSupported =
				jest.fn().mockReturnValue(true);

			const { getAudioStreams } = jest.requireMock(
				'../../src/recording/AudioStreamHandler',
			);
			getAudioStreams.mockResolvedValue({
				streams: [{ getTracks: () => [{ stop: jest.fn() }] }],
				trackOrder: [],
			});

			(mockApp.vault.adapter.readBinary as jest.Mock).mockResolvedValue(
				new Uint8Array([1, 2, 3]).buffer,
			);

			await manager.startRecording();

			const chunk = new Blob([new Uint8Array([1, 2, 3])], {
				type: 'audio/webm',
			});
			mockMediaRecorder.ondataavailable?.({ data: chunk } as BlobEvent);
			await Promise.resolve();

			await manager.stopRecording();

			expect(mockReplaceSelection).toHaveBeenCalled();
			const insertedText = mockReplaceSelection.mock
				.calls[0][0] as string;
			expect(insertedText).not.toContain('Projects/');
			expect(insertedText).not.toContain('Audio/');
			expect(insertedText).toMatch(/^!\[\[recording-.*\]\]$/);
		});
	});

	describe('insertFileLinks with insertionContext', () => {
		let mockMediaRecorder: {
			start: jest.Mock;
			stop: jest.Mock;
			pause: jest.Mock;
			resume: jest.Mock;
			ondataavailable: ((event: BlobEvent) => void) | null;
			onerror: ((event: Event) => void) | null;
			addEventListener: jest.Mock;
		};

		beforeEach(() => {
			mockMediaRecorder = {
				start: jest.fn(),
				stop: jest.fn(),
				pause: jest.fn(),
				resume: jest.fn(),
				ondataavailable: null,
				onerror: null,
				addEventListener: jest.fn(
					(event: string, handler: () => void) => {
						if (event === 'stop') {
							handler();
						}
					},
				),
			};

			(global as Record<string, unknown>).MediaRecorder = jest.fn(
				() => mockMediaRecorder,
			);
			(global as Record<string, unknown>).MediaRecorder.isTypeSupported =
				jest.fn().mockReturnValue(true);

			const { getAudioStreams } = jest.requireMock(
				'../../src/recording/AudioStreamHandler',
			);
			getAudioStreams.mockResolvedValue({
				streams: [{ getTracks: () => [{ stop: jest.fn() }] }],
				trackOrder: [],
			});

			(mockApp.vault.adapter.readBinary as jest.Mock).mockResolvedValue(
				new Uint8Array([1, 2, 3]).buffer,
			);
		});

		it('should use replaceSelection on active note when insertAtOriginalPosition is disabled', async () => {
			const mockReplaceSelection = jest.fn();
			(
				mockApp.workspace.getActiveViewOfType as jest.Mock
			).mockReturnValue({
				editor: { replaceSelection: mockReplaceSelection },
			});

			mockSettings = {
				...DEFAULT_SETTINGS,
				insertAtOriginalPosition: false,
			};
			manager = new RecordingManager(
				mockApp,
				mockSettings,
				statusChangeCallback,
			);

			await manager.startRecording();
			const chunk = new Blob([new Uint8Array([1, 2, 3])], {
				type: 'audio/webm',
			});
			mockMediaRecorder.ondataavailable?.({ data: chunk } as BlobEvent);
			await Promise.resolve();
			await manager.stopRecording();

			expect(mockReplaceSelection).toHaveBeenCalled();
		});

		it('should use replaceRange at stored position when insertAtOriginalPosition is enabled', async () => {
			const mockReplaceRange = jest.fn();
			const mockGetCursor = jest.fn().mockReturnValue({ line: 5, ch: 3 });

			// Mock getActiveViewOfType to return a view with file and editor for capture
			(
				mockApp.workspace.getActiveViewOfType as jest.Mock
			).mockReturnValue({
				file: { path: 'Notes/my-note.md' },
				editor: {
					getCursor: mockGetCursor,
					replaceRange: mockReplaceRange,
					replaceSelection: jest.fn(),
				},
			});

			// Mock getLeavesOfType for finding the stored note
			const mockLeafView = {
				file: { path: 'Notes/my-note.md' },
				editor: {
					replaceRange: mockReplaceRange,
					replaceSelection: jest.fn(),
				},
			};
			Object.setPrototypeOf(
				mockLeafView,
				jest.requireMock('obsidian').MarkdownView.prototype,
			);
			(mockApp.workspace as Record<string, unknown>).getLeavesOfType =
				jest.fn().mockReturnValue([{ view: mockLeafView }]);

			mockSettings = {
				...DEFAULT_SETTINGS,
				insertAtOriginalPosition: true,
			};
			manager = new RecordingManager(
				mockApp,
				mockSettings,
				statusChangeCallback,
			);

			await manager.startRecording();
			const chunk = new Blob([new Uint8Array([1, 2, 3])], {
				type: 'audio/webm',
			});
			mockMediaRecorder.ondataavailable?.({ data: chunk } as BlobEvent);
			await Promise.resolve();
			await manager.stopRecording();

			expect(mockReplaceRange).toHaveBeenCalledWith(
				expect.stringMatching(/^!\[\[recording-.*\]\]\n$/),
				{ line: 6, ch: 0 },
			);
		});

		it('should fallback to replaceSelection when stored note leaf is not found', async () => {
			const mockReplaceSelection = jest.fn();
			const mockGetCursor = jest.fn().mockReturnValue({ line: 2, ch: 0 });

			// During capture, return a view with file and editor
			(
				mockApp.workspace.getActiveViewOfType as jest.Mock
			).mockReturnValue({
				file: { path: 'Notes/original.md' },
				editor: {
					getCursor: mockGetCursor,
					replaceSelection: mockReplaceSelection,
				},
			});

			// No matching leaf found
			(mockApp.workspace as Record<string, unknown>).getLeavesOfType =
				jest.fn().mockReturnValue([]);

			mockSettings = {
				...DEFAULT_SETTINGS,
				insertAtOriginalPosition: true,
			};
			manager = new RecordingManager(
				mockApp,
				mockSettings,
				statusChangeCallback,
			);

			await manager.startRecording();
			const chunk = new Blob([new Uint8Array([1, 2, 3])], {
				type: 'audio/webm',
			});
			mockMediaRecorder.ondataavailable?.({ data: chunk } as BlobEvent);
			await Promise.resolve();
			await manager.stopRecording();

			// Falls back to active view replaceSelection
			expect(mockReplaceSelection).toHaveBeenCalled();
		});

		it('should clear insertionContext after stopRecording', async () => {
			const mockGetCursor = jest.fn().mockReturnValue({ line: 0, ch: 0 });
			(
				mockApp.workspace.getActiveViewOfType as jest.Mock
			).mockReturnValue({
				file: { path: 'Notes/test.md' },
				editor: {
					getCursor: mockGetCursor,
					replaceSelection: jest.fn(),
				},
			});
			(mockApp.workspace as Record<string, unknown>).getLeavesOfType =
				jest.fn().mockReturnValue([]);

			mockSettings = {
				...DEFAULT_SETTINGS,
				insertAtOriginalPosition: true,
			};
			manager = new RecordingManager(
				mockApp,
				mockSettings,
				statusChangeCallback,
			);

			await manager.startRecording();
			await manager.stopRecording();

			// Access private field to verify cleanup
			const context = (
				manager as unknown as { insertionContext: unknown }
			).insertionContext;
			expect(context).toBeNull();
		});
	});

	describe('auto-split', () => {
		interface TargetInternals {
			pendingWrite: Promise<void>;
			partPaths: string[];
			partIndex: number;
			pcmBuffers: ArrayBuffer[];
			pcmBufferedBytes: number;
			partPcmBytes: number;
		}

		interface ManagerInternals {
			chunkTargets: TargetInternals[];
			rotation: { rotationPromise: Promise<void> | null };
		}

		let mockMediaRecorder: {
			start: jest.Mock;
			stop: jest.Mock;
			pause: jest.Mock;
			resume: jest.Mock;
			state: string;
			ondataavailable: ((event: BlobEvent) => void) | null;
			onerror: ((event: Event) => void) | null;
			addEventListener: jest.Mock;
		};

		function getInternals(instance: RecordingManager): {
			chunkTargets: TargetInternals[];
			rotationPromise: Promise<void> | null;
		} {
			const internals = instance as unknown as ManagerInternals;
			return {
				chunkTargets: internals.chunkTargets,
				// Rotation state lives on the PartRotationController
				get rotationPromise(): Promise<void> | null {
					return internals.rotation.rotationPromise;
				},
			};
		}

		/**
		 * Lets the voided handleChunk continuation run to completion so
		 * rotationPromise is observable after awaiting pendingWrite.
		 */
		async function flushMicrotasks(): Promise<void> {
			for (let i = 0; i < 10; i++) {
				await Promise.resolve();
			}
		}

		function createManagerWithSettings(
			overrides: Partial<AudioRecorderSettings>,
		): void {
			mockSettings = { ...DEFAULT_SETTINGS, ...overrides };
			manager = new RecordingManager(
				mockApp,
				mockSettings,
				statusChangeCallback,
			);
		}

		function setupStreams(count: number): void {
			const { getAudioStreams } = jest.requireMock(
				'../../src/recording/AudioStreamHandler',
			);
			getAudioStreams.mockResolvedValue({
				streams: Array.from({ length: count }, () => ({
					getTracks: () => [{ stop: jest.fn() }],
				})),
				trackOrder: [],
			});
		}

		beforeEach(() => {
			const { Platform } = jest.requireMock('obsidian');
			Platform.isMobile = false;
			Platform.isMobileApp = false;

			mockMediaRecorder = {
				start: jest.fn(),
				stop: jest.fn(),
				pause: jest.fn(),
				resume: jest.fn(),
				state: 'recording',
				ondataavailable: null,
				onerror: null,
				addEventListener: jest.fn(
					(event: string, handler: () => void) => {
						if (event === 'stop') {
							handler();
						}
					},
				),
			};

			(global as Record<string, unknown>).MediaRecorder = jest.fn(
				() => mockMediaRecorder,
			);
			(global as Record<string, unknown>).MediaRecorder.isTypeSupported =
				jest.fn().mockReturnValue(true);

			setupStreams(1);

			(mockApp.vault.adapter.readBinary as jest.Mock).mockResolvedValue(
				new Uint8Array([1, 2, 3]).buffer,
			);
		});

		afterEach(() => {
			jest.useRealTimers();
		});

		it('should save PCM parts at byte boundaries and a residual part at stop', async () => {
			createManagerWithSettings({
				recordingFormat: 'wav',
				autoSplitEnabled: true,
				splitChunkMinutes: 1,
			});

			await manager.startRecording();

			// Part limit: 1 min * 60 s * 44100 Hz * 1 ch * 2 B = 5,292,000 B
			capturedPcmChunkCallback?.(new ArrayBuffer(3_000_000));
			await getInternals(manager).chunkTargets[0].pendingWrite;
			capturedPcmChunkCallback?.(new ArrayBuffer(3_000_000));
			await getInternals(manager).chunkTargets[0].pendingWrite;

			expect(mockApp.vault.createBinary).toHaveBeenCalledWith(
				expect.stringMatching(/-part1\.wav$/),
				expect.anything(),
			);
			const target = getInternals(manager).chunkTargets[0];
			expect(target.partIndex).toBe(1);
			expect(target.partPaths).toHaveLength(1);

			await manager.stopRecording();

			// The 708,000-byte carry becomes the residual second part
			expect(mockApp.vault.createBinary).toHaveBeenCalledWith(
				expect.stringMatching(/-part2\.wav$/),
				expect.anything(),
			);
		});

		it('should not split PCM recordings when auto-split is disabled', async () => {
			createManagerWithSettings({
				recordingFormat: 'wav',
				autoSplitEnabled: false,
				splitChunkMinutes: 1,
			});

			await manager.startRecording();

			capturedPcmChunkCallback?.(new ArrayBuffer(6_000_000));
			await getInternals(manager).chunkTargets[0].pendingWrite;

			const partCalls = (
				mockApp.vault.createBinary as jest.Mock
			).mock.calls.filter((call: unknown[]) =>
				/-part\d+\.wav$/.test(String(call[0])),
			);
			expect(partCalls).toHaveLength(0);
		});

		it('should use the configured suffix for PCM part files', async () => {
			createManagerWithSettings({
				recordingFormat: 'wav',
				autoSplitEnabled: true,
				splitChunkMinutes: 1,
				splitPartSuffix: 'chunk',
			});

			await manager.startRecording();

			capturedPcmChunkCallback?.(new ArrayBuffer(6_000_000));
			await getInternals(manager).chunkTargets[0].pendingWrite;

			expect(mockApp.vault.createBinary).toHaveBeenCalledWith(
				expect.stringMatching(/-chunk1\.wav$/),
				expect.anything(),
			);
		});

		it('should notify that auto-split is unavailable on mobile', async () => {
			const { Platform } = jest.requireMock('obsidian');
			Platform.isMobile = true;
			createManagerWithSettings({
				recordingFormat: 'webm',
				autoSplitEnabled: true,
				splitChunkMinutes: 1,
			});

			await manager.startRecording();

			const { Notice } = jest.requireMock('obsidian');
			expect(Notice).toHaveBeenCalledWith(
				'Auto-split is not available in the mobile app.',
			);
			await manager.stopRecording();
		});

		it('should keep the part file when segment cleanup fails', async () => {
			createManagerWithSettings({
				recordingFormat: 'wav',
				autoSplitEnabled: true,
				splitChunkMinutes: 1,
			});
			// Segment removal fails after the part file was assembled
			(mockApp.vault.adapter.remove as jest.Mock).mockRejectedValue(
				new Error('locked'),
			);

			await manager.startRecording();

			capturedPcmChunkCallback?.(new ArrayBuffer(6_000_000));
			await getInternals(manager).chunkTargets[0].pendingWrite;

			// The assembled part is kept: the removed segments would
			// otherwise be the only copy of the audio
			const target = getInternals(manager).chunkTargets[0];
			expect(target.partIndex).toBe(1);
			expect(target.partPaths).toHaveLength(1);
			const { Notice } = jest.requireMock('obsidian');
			expect(Notice).toHaveBeenCalledWith(
				expect.stringContaining(
					'Recording saved, but temporary files could not be removed',
				),
			);
			expect(manager.getStatus()).toBe(RecordingStatus.Recording);
		});

		it('should name the residual from the base name snapshotted at start', async () => {
			createManagerWithSettings({
				recordingFormat: 'wav',
				autoSplitEnabled: true,
				splitChunkMinutes: 1,
			});

			await manager.startRecording();

			capturedPcmChunkCallback?.(new ArrayBuffer(6_000_000));
			await getInternals(manager).chunkTargets[0].pendingWrite;

			// Changing the prefix mid-session must not affect this session
			manager.updateSettings({
				...mockSettings,
				filePrefix: 'changed',
			});
			await manager.stopRecording();

			const residualCall = (
				mockApp.vault.createBinary as jest.Mock
			).mock.calls.find((call: unknown[]) =>
				/-part2\.wav$/.test(String(call[0])),
			);
			expect(residualCall).toBeDefined();
			expect(String(residualCall?.[0])).toContain('recording-');
			expect(String(residualCall?.[0])).not.toContain('changed-');
		});

		it('should rotate MediaRecorder parts after the configured duration', async () => {
			jest.useFakeTimers();
			jest.setSystemTime(0);
			createManagerWithSettings({
				recordingFormat: 'webm',
				autoSplitEnabled: true,
				splitChunkMinutes: 1,
			});

			await manager.startRecording();
			expect(global.MediaRecorder).toHaveBeenCalledTimes(1);

			jest.setSystemTime(61_000);
			const chunk = new Blob([new Uint8Array([1, 2, 3])], {
				type: 'audio/webm',
			});
			mockMediaRecorder.ondataavailable?.({ data: chunk } as BlobEvent);
			await getInternals(manager).chunkTargets[0].pendingWrite;
			await flushMicrotasks();

			const rotation = getInternals(manager).rotationPromise;
			expect(rotation).not.toBeNull();
			await rotation;

			// Part finalized as a real file and recorders restarted
			expect(mockApp.vault.createBinary).toHaveBeenCalledWith(
				expect.stringMatching(/-part1\.webm$/),
				expect.anything(),
			);
			expect(global.MediaRecorder).toHaveBeenCalledTimes(2);
			expect(
				getInternals(manager).chunkTargets[0].partPaths,
			).toHaveLength(1);

			// Residual data recorded after rotation becomes the next part
			jest.setSystemTime(70_000);
			mockMediaRecorder.ondataavailable?.({ data: chunk } as BlobEvent);
			await getInternals(manager).chunkTargets[0].pendingWrite;
			await manager.stopRecording();

			expect(mockApp.vault.createBinary).toHaveBeenCalledWith(
				expect.stringMatching(/-part2\.webm$/),
				expect.anything(),
			);
		});

		it('should not count paused time toward the part duration', async () => {
			jest.useFakeTimers();
			jest.setSystemTime(0);
			createManagerWithSettings({
				recordingFormat: 'webm',
				autoSplitEnabled: true,
				splitChunkMinutes: 1,
			});

			await manager.startRecording();

			jest.setSystemTime(30_000);
			manager.togglePauseResume();
			jest.setSystemTime(130_000);
			manager.togglePauseResume();

			// Active time is 30 s + 10 s = 40 s, below the 60 s boundary
			jest.setSystemTime(140_000);
			const chunk = new Blob([new Uint8Array([1, 2, 3])], {
				type: 'audio/webm',
			});
			mockMediaRecorder.ondataavailable?.({ data: chunk } as BlobEvent);
			await getInternals(manager).chunkTargets[0].pendingWrite;
			await flushMicrotasks();
			expect(getInternals(manager).rotationPromise).toBeNull();

			// Active time reaches 30 s + 35 s = 65 s, beyond the boundary
			jest.setSystemTime(165_000);
			mockMediaRecorder.ondataavailable?.({ data: chunk } as BlobEvent);
			await getInternals(manager).chunkTargets[0].pendingWrite;
			await flushMicrotasks();

			const rotation = getInternals(manager).rotationPromise;
			expect(rotation).not.toBeNull();
			await rotation;
			expect(global.MediaRecorder).toHaveBeenCalledTimes(2);
		});

		it('should skip auto-split for merged multi-track recordings', async () => {
			setupStreams(2);
			createManagerWithSettings({
				recordingFormat: 'webm',
				autoSplitEnabled: true,
				splitChunkMinutes: 1,
				outputMode: 'single',
			});

			await manager.startRecording();

			const { Notice } = jest.requireMock('obsidian');
			expect(Notice).toHaveBeenCalledWith(
				'Auto-split is skipped for merged multi-track recordings.',
			);
		});

		it('should keep recording when part finalization fails', async () => {
			jest.useFakeTimers();
			jest.setSystemTime(0);
			createManagerWithSettings({
				recordingFormat: 'webm',
				autoSplitEnabled: true,
				splitChunkMinutes: 1,
			});
			// Fail only the final part write; segment (.tmp) writes succeed
			(mockApp.vault.createBinary as jest.Mock).mockImplementation(
				(path: string) =>
					/-part1\.webm$/.test(path)
						? Promise.reject(new Error('disk full'))
						: Promise.resolve(),
			);

			await manager.startRecording();

			jest.setSystemTime(61_000);
			const chunk = new Blob([new Uint8Array([1, 2, 3])], {
				type: 'audio/webm',
			});
			mockMediaRecorder.ondataavailable?.({ data: chunk } as BlobEvent);
			await getInternals(manager).chunkTargets[0].pendingWrite;
			await flushMicrotasks();
			await getInternals(manager).rotationPromise;

			const { Notice } = jest.requireMock('obsidian');
			expect(Notice).toHaveBeenCalledWith(
				'Failed to save recording part. Recording continues; data is kept for the next part.',
			);
			const target = getInternals(manager).chunkTargets[0];
			expect(target.partIndex).toBe(0);
			expect(target.partPaths).toHaveLength(0);
			// Recorders were restarted despite the failure
			expect(global.MediaRecorder).toHaveBeenCalledTimes(2);
			expect(manager.getStatus()).toBe(RecordingStatus.Recording);
		});

		it('should preserve buffered PCM audio when a part save fails', async () => {
			createManagerWithSettings({
				recordingFormat: 'wav',
				autoSplitEnabled: true,
				splitChunkMinutes: 1,
			});
			// Fail only the PCM segment write that backs the part assembly
			(mockApp.vault.adapter.writeBinary as jest.Mock).mockImplementation(
				(path: string) =>
					path.includes('-pcm-part')
						? Promise.reject(new Error('disk full'))
						: Promise.resolve(),
			);

			await manager.startRecording();

			// Part limit: 1 min * 60 s * 44100 Hz * 1 ch * 2 B = 5,292,000 B
			capturedPcmChunkCallback?.(new ArrayBuffer(6_000_000));
			await getInternals(manager).chunkTargets[0].pendingWrite;

			const { Notice } = jest.requireMock('obsidian');
			expect(Notice).toHaveBeenCalledWith(
				'Failed to save recording part. Recording continues; data is kept for the next part.',
			);
			const target = getInternals(manager).chunkTargets[0];
			expect(target.partIndex).toBe(0);
			expect(target.partPaths).toHaveLength(0);
			// All captured bytes stay buffered: front portion plus the
			// carry re-attached in capture order
			const bufferedBytes = target.pcmBuffers.reduce(
				(sum, buffer) => sum + buffer.byteLength,
				0,
			);
			expect(bufferedBytes).toBe(6_000_000);
			expect(target.pcmBufferedBytes).toBe(6_000_000);
			// Part accounting restarts so the save is retried one part later
			expect(target.partPcmBytes).toBe(0);

			// Disk recovers: the preserved audio must reach the final file
			(mockApp.vault.adapter.writeBinary as jest.Mock).mockResolvedValue(
				undefined,
			);
			await manager.stopRecording();

			expect(mockApp.vault.createBinary).toHaveBeenCalledWith(
				expect.stringMatching(/\.wav$/),
				expect.anything(),
			);
			const partWavCalls = (
				mockApp.vault.createBinary as jest.Mock
			).mock.calls.filter((call: unknown[]) =>
				/-part\d+\.wav$/.test(String(call[0])),
			);
			expect(partWavCalls).toHaveLength(0);
		});

		it('should restart recorders before transcoding the rotated part', async () => {
			jest.useFakeTimers();
			jest.setSystemTime(0);
			createManagerWithSettings({
				recordingFormat: 'webm',
				autoSplitEnabled: true,
				splitChunkMinutes: 1,
			});

			// Shared log capturing recorder construction vs part writes
			const callLog: string[] = [];
			(global as Record<string, unknown>).MediaRecorder = jest.fn(() => {
				callLog.push('recorder-created');
				return mockMediaRecorder;
			});
			(global as Record<string, unknown>).MediaRecorder.isTypeSupported =
				jest.fn().mockReturnValue(true);
			(mockApp.vault.createBinary as jest.Mock).mockImplementation(
				(path: string) => {
					if (/-part1\.webm$/.test(path)) {
						callLog.push('part-file-written');
					}
					return Promise.resolve();
				},
			);

			await manager.startRecording();

			jest.setSystemTime(61_000);
			const chunk = new Blob([new Uint8Array([1, 2, 3])], {
				type: 'audio/webm',
			});
			mockMediaRecorder.ondataavailable?.({ data: chunk } as BlobEvent);
			await getInternals(manager).chunkTargets[0].pendingWrite;
			await flushMicrotasks();
			await getInternals(manager).rotationPromise;

			// Restart (2nd construction) precedes the part file write so
			// the capture gap excludes the transcoding time
			expect(callLog).toEqual([
				'recorder-created',
				'recorder-created',
				'part-file-written',
			]);
		});

		it('should skip pausing recorders that are inactive during rotation', async () => {
			createManagerWithSettings({
				recordingFormat: 'webm',
				autoSplitEnabled: true,
				splitChunkMinutes: 1,
			});

			await manager.startRecording();

			// Rotation window: recorders are momentarily stopped
			mockMediaRecorder.state = 'inactive';
			expect(() => manager.togglePauseResume()).not.toThrow();
			expect(mockMediaRecorder.pause).not.toHaveBeenCalled();
			expect(manager.getStatus()).toBe(RecordingStatus.Paused);

			// Resume skips inactive recorders the same way
			expect(() => manager.togglePauseResume()).not.toThrow();
			expect(mockMediaRecorder.resume).not.toHaveBeenCalled();
			expect(manager.getStatus()).toBe(RecordingStatus.Recording);

			// Active recorders keep the normal pause path
			mockMediaRecorder.state = 'recording';
			manager.togglePauseResume();
			expect(mockMediaRecorder.pause).toHaveBeenCalledTimes(1);
			expect(manager.getStatus()).toBe(RecordingStatus.Paused);
		});

		it('should stop and salvage the session when recorder restart fails', async () => {
			jest.useFakeTimers();
			jest.setSystemTime(0);
			createManagerWithSettings({
				recordingFormat: 'webm',
				autoSplitEnabled: true,
				splitChunkMinutes: 1,
			});

			// The 2nd construction is the rotation restart; it fails as if
			// the input device disappeared mid-session
			let constructionCount = 0;
			(global as Record<string, unknown>).MediaRecorder = jest.fn(() => {
				constructionCount += 1;
				if (constructionCount === 2) {
					throw new Error('device disappeared');
				}
				return mockMediaRecorder;
			});
			(global as Record<string, unknown>).MediaRecorder.isTypeSupported =
				jest.fn().mockReturnValue(true);

			await manager.startRecording();

			jest.setSystemTime(61_000);
			const chunk = new Blob([new Uint8Array([1, 2, 3])], {
				type: 'audio/webm',
			});
			mockMediaRecorder.ondataavailable?.({ data: chunk } as BlobEvent);
			await getInternals(manager).chunkTargets[0].pendingWrite;
			await flushMicrotasks();
			await getInternals(manager).rotationPromise;

			// The internally fired stopRecording is not awaitable from the
			// outside; drain microtasks until its chain settles
			for (let i = 0; i < 20; i++) {
				if (manager.getStatus() === RecordingStatus.Idle) {
					break;
				}
				await flushMicrotasks();
			}

			const { Notice } = jest.requireMock('obsidian');
			expect(Notice).toHaveBeenCalledWith(
				'Could not restart recording after saving a part. Stopping and saving the recording.',
			);
			// Session was salvaged: the part saved before the failure is
			// kept and the session ends cleanly instead of going dead
			expect(Notice).toHaveBeenCalledWith('Recording stopped');
			expect(manager.getStatus()).toBe(RecordingStatus.Idle);
		});

		it('should keep the session output format when settings change mid-session', async () => {
			jest.useFakeTimers();
			jest.setSystemTime(0);
			createManagerWithSettings({
				recordingFormat: 'webm',
				autoSplitEnabled: true,
				splitChunkMinutes: 1,
			});

			await manager.startRecording();

			// Settings change mid-session must not leak into the session
			manager.updateSettings({ ...mockSettings, recordingFormat: 'ogg' });

			jest.setSystemTime(61_000);
			const chunk = new Blob([new Uint8Array([1, 2, 3])], {
				type: 'audio/webm',
			});
			mockMediaRecorder.ondataavailable?.({ data: chunk } as BlobEvent);
			await getInternals(manager).chunkTargets[0].pendingWrite;
			await flushMicrotasks();
			await getInternals(manager).rotationPromise;

			expect(mockApp.vault.createBinary).toHaveBeenCalledWith(
				expect.stringMatching(/-part1\.webm$/),
				expect.anything(),
			);
			const oggCalls = (
				mockApp.vault.createBinary as jest.Mock
			).mock.calls.filter((call: unknown[]) =>
				String(call[0]).endsWith('.ogg'),
			);
			expect(oggCalls).toHaveLength(0);
		});

		it('should ignore a reentrant stopRecording call', async () => {
			createManagerWithSettings({
				recordingFormat: 'webm',
				autoSplitEnabled: true,
				splitChunkMinutes: 1,
			});

			await manager.startRecording();
			const chunk = new Blob([new Uint8Array([1, 2, 3])], {
				type: 'audio/webm',
			});
			mockMediaRecorder.ondataavailable?.({ data: chunk } as BlobEvent);
			await getInternals(manager).chunkTargets[0].pendingWrite;

			// Second concurrent call must return without a second save
			const firstStop = manager.stopRecording();
			const secondStop = manager.stopRecording();
			await Promise.all([firstStop, secondStop]);

			const { Notice } = jest.requireMock('obsidian');
			const stopNotices = (Notice as jest.Mock).mock.calls.filter(
				(call: unknown[]) => call[0] === 'Recording stopped',
			);
			expect(stopNotices).toHaveLength(1);
			// Exactly one final track file write (segments end in .tmp)
			const finalWrites = (
				mockApp.vault.createBinary as jest.Mock
			).mock.calls.filter((call: unknown[]) =>
				/\.webm$/.test(String(call[0])),
			);
			expect(finalWrites).toHaveLength(1);
		});

		it('should stop cleanly while a rotation is in flight', async () => {
			jest.useFakeTimers();
			jest.setSystemTime(0);
			createManagerWithSettings({
				recordingFormat: 'webm',
				autoSplitEnabled: true,
				splitChunkMinutes: 1,
			});

			// Gate the rotation's segment flush so the stop request
			// deterministically lands while the rotation is in flight
			let releaseFlush: (() => void) | undefined;
			const flushGate = new Promise<void>((resolve) => {
				releaseFlush = resolve;
			});
			(mockApp.vault.adapter.writeBinary as jest.Mock).mockImplementation(
				(path: string) =>
					path.endsWith('.tmp') ? flushGate : Promise.resolve(),
			);

			await manager.startRecording();

			jest.setSystemTime(61_000);
			const chunk = new Blob([new Uint8Array([1, 2, 3])], {
				type: 'audio/webm',
			});
			mockMediaRecorder.ondataavailable?.({ data: chunk } as BlobEvent);
			await getInternals(manager).chunkTargets[0].pendingWrite;
			await flushMicrotasks();
			expect(getInternals(manager).rotationPromise).not.toBeNull();

			// The rotation already stopped the recorders; the stop call
			// in this window must not throw or stop them a second time
			mockMediaRecorder.state = 'inactive';
			const stopPromise = manager.stopRecording();
			releaseFlush?.();
			await stopPromise;

			// Stop won the race: capture was not restarted, the rotated
			// part was still written, and the session ended cleanly
			expect(global.MediaRecorder).toHaveBeenCalledTimes(1);
			expect(mockMediaRecorder.stop).toHaveBeenCalledTimes(1);
			expect(mockApp.vault.createBinary).toHaveBeenCalledWith(
				expect.stringMatching(/-part1\.webm$/),
				expect.anything(),
			);
			expect(manager.getStatus()).toBe(RecordingStatus.Idle);
		});
	});
});
