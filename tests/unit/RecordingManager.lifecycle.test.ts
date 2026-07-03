/**
 * Unit tests for RecordingManager lifecycle behavior: construction,
 * status reporting, settings updates, start/stop/pause/resume
 * transitions, and error handling around start and stop.
 * @module tests/unit/RecordingManager.lifecycle.test
 */

import { RecordingManager } from 'src/recording/RecordingManager';
import { RecordingStatus } from 'src/types';
import {
	DEFAULT_SETTINGS,
	AudioRecorderSettings,
} from 'src/settings/settingsSchema';
import type { App } from 'obsidian';
import {
	createRecordingMockApp,
	installRecordingMediaStubs,
} from './helpers/recordingManagerTestKit';

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
jest.mock('src/recording/AudioStreamHandler', () => ({
	getAudioStreams: jest.fn(),
	getAudioSourceName: jest.fn().mockResolvedValue('TestDevice'),
	stopAllStreams: jest.fn(),
	validateSelectedDevices: jest.fn(),
}));

// Mock AudioEncoder module to avoid mediabunny TextDecoder requirement
jest.mock('src/audio/AudioEncoder', () => ({
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
jest.mock('src/audio/WavEncoder', () => ({
	assembleWavFromPcmSegmentFiles: jest
		.fn()
		.mockResolvedValue(new ArrayBuffer(44)),
}));

// Mock PcmStreamRecorder
jest.mock('src/recording/PcmStreamRecorder', () => ({
	PcmStreamRecorder: jest.fn().mockImplementation(() => ({
		channels: 1,
		sampleRate: 44100,
		start: jest.fn().mockResolvedValue(undefined),
		stop: jest.fn().mockResolvedValue(undefined),
		pause: jest.fn(),
		resume: jest.fn(),
	})),
}));

installRecordingMediaStubs();

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
		mockApp = createRecordingMockApp();

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
				'src/recording/AudioStreamHandler',
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
				'src/recording/AudioStreamHandler',
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
				'src/recording/AudioStreamHandler',
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
				'src/recording/AudioStreamHandler',
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
				'src/recording/AudioStreamHandler',
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
				'src/recording/AudioStreamHandler',
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
				'src/recording/AudioStreamHandler',
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
				'src/recording/AudioStreamHandler',
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
				'src/recording/AudioStreamHandler',
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
				'src/recording/AudioStreamHandler',
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
});
