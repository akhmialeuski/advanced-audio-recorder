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

			expect(mockApp.vault.createBinary).toHaveBeenCalledWith(
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
			expect(mockApp.vault.createBinary).toHaveBeenCalledWith(
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

			expect(mockApp.vault.createBinary).toHaveBeenCalledWith(
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
			expect(mockApp.vault.createBinary).toHaveBeenCalledWith(
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

			expect(mockApp.vault.createBinary).toHaveBeenCalledWith(
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
});
