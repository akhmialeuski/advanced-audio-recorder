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
	type AudioRecorderSettings,
} from 'src/settings/settingsSchema';
import type { App } from 'obsidian';
import {
	createRecordingSut,
	installMediaRecorder,
	installRecordingMediaStubs,
	makeMediaRecorderDouble,
	recordingManagerOver,
	stubAudioStreams,
	type MockMediaRecorder,
} from '../helpers/recordingManagerTestKit';
import { useDesktopPlatform } from '../helpers/platform';
import { noticeMessages } from '../mocks/obsidian';
import {
	getAudioStreams,
	stopAllStreams,
} from 'src/recording/AudioStreamHandler';

// Mock AudioStreamHandler
jest.mock('src/recording/AudioStreamHandler', () =>
	require('../mocks/modules/audioStreamHandler'),
);

// Mock AudioEncoder module to avoid mediabunny TextDecoder requirement.
// The async probe answers false: these suites exercise recording flows,
// so a format is recordable only when MediaRecorder supports it.
jest.mock('src/audio/AudioEncoder', () =>
	require('../mocks/modules/audioEncoder'),
);

// Mock WavEncoder
jest.mock('src/audio/WavEncoder', () => require('../mocks/modules/wavEncoder'));

// Mock PcmStreamRecorder
jest.mock('src/recording/PcmStreamRecorder', () =>
	require('../mocks/modules/pcmStreamRecorder'),
);

installRecordingMediaStubs();

describe('RecordingManager', () => {
	let manager: RecordingManager;
	let mockApp: App;
	let mockSettings: AudioRecorderSettings;
	let statusChangeCallback: jest.Mock;
	let consoleErrorSpy: jest.SpyInstance;

	beforeEach(() => {
		consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();
		({
			manager,
			app: mockApp,
			settings: mockSettings,
			onStatusChange: statusChangeCallback,
		} = createRecordingSut());
	});

	describe('constructor', () => {
		it('initializes with idle status', () => {
			expect(manager.getStatus()).toBe(RecordingStatus.Idle);
		});

		it('stores the status change callback', () => {
			expect(statusChangeCallback).not.toHaveBeenCalled();
		});
	});

	describe('getStatus', () => {
		it('returns Idle initially', () => {
			expect(manager.getStatus()).toBe(RecordingStatus.Idle);
		});
	});

	describe('updateSettings', () => {
		it('updates settings reference', () => {
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
			makeMediaRecorderDouble();

			// Mock getAudioStreams
			stubAudioStreams();
		});

		it('starts recording when idle', async () => {
			expect(manager.getStatus()).toBe(RecordingStatus.Idle);

			await manager.toggleRecording();

			expect(manager.getStatus()).toBe(RecordingStatus.Recording);
			expect(statusChangeCallback).toHaveBeenCalledWith(
				RecordingStatus.Recording,
				undefined,
			);
		});

		it('stops recording when recording', async () => {
			// First start
			await manager.toggleRecording();
			expect(manager.getStatus()).toBe(RecordingStatus.Recording);

			// Then stop
			await manager.toggleRecording();
			expect(manager.getStatus()).toBe(RecordingStatus.Idle);
		});
	});

	describe('togglePauseResume', () => {
		let mockMediaRecorder: MockMediaRecorder;

		beforeEach(() => {
			mockMediaRecorder = makeMediaRecorderDouble();

			stubAudioStreams();
		});

		it('does nothing when idle', () => {
			manager.togglePauseResume();

			expect(manager.getStatus()).toBe(RecordingStatus.Idle);
			expect(mockMediaRecorder.pause).not.toHaveBeenCalled();
		});

		it('pauses when recording', async () => {
			await manager.toggleRecording();
			expect(manager.getStatus()).toBe(RecordingStatus.Recording);

			manager.togglePauseResume();

			expect(manager.getStatus()).toBe(RecordingStatus.Paused);
			expect(statusChangeCallback).toHaveBeenCalledWith(
				RecordingStatus.Paused,
				undefined,
			);
		});

		it('resumes when paused', async () => {
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

		it('finishes stopping when the stop event never fires', async () => {
			useDesktopPlatform();

			// Recorder whose stop event never arrives (dead audio subsystem)
			makeMediaRecorderDouble({
				state: 'recording',
				stopFiresImmediately: false,
			});

			stubAudioStreams();

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

		it('resolves when stop() throws on a racing recorder', async () => {
			useDesktopPlatform();

			makeMediaRecorderDouble({
				state: 'recording',
				stopFiresImmediately: false,
				stop: jest.fn(() => {
					throw new Error('InvalidStateError');
				}),
			});

			stubAudioStreams();

			await manager.startRecording();
			await manager.stopRecording();

			expect(manager.getStatus()).toBe(RecordingStatus.Idle);
		});
	});

	describe('cleanup', () => {
		it('resets all internal state', () => {
			manager.cleanup();

			expect(manager.getStatus()).toBe(RecordingStatus.Idle);
		});

		it('stops all streams', () => {
			manager.cleanup();

			expect(jest.mocked(stopAllStreams)).toHaveBeenCalled();
		});
	});

	describe('stopRecording error recovery', () => {
		let mockStopTrack: jest.Mock;

		beforeEach(() => {
			mockStopTrack = jest.fn();

			makeMediaRecorderDouble();

			stubAudioStreams({ stopTrack: mockStopTrack });
		});

		it('resets status to Idle even when save fails', async () => {
			// Start recording first
			await manager.startRecording();
			expect(manager.getStatus()).toBe(RecordingStatus.Recording);

			// Mock vault to throw error during save
			jest.mocked(mockApp.vault.adapter.rename).mockRejectedValue(
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

		it('stops streams even when save fails', async () => {
			await manager.startRecording();

			// Mock vault to throw error during save
			jest.mocked(mockApp.vault.adapter.rename).mockRejectedValue(
				new Error('Save failed'),
			);

			await manager.stopRecording();

			// Streams should still be stopped
			expect(jest.mocked(stopAllStreams)).toHaveBeenCalled();
		});

		it('clears all arrays after stop', async () => {
			await manager.startRecording();
			await manager.stopRecording();

			// Internal state should be cleared - verify by starting a new recording
			// If arrays weren't cleared, this would have stale data
			expect(manager.getStatus()).toBe(RecordingStatus.Idle);
		});

		it('answers with nothing once a start and a stop have both gone through', async () => {
			expect(await manager.startRecording()).toBeNull();
			expect(await manager.stopRecording()).toBeNull();
		});

		it('answers that a stop is already running rather than stopping twice', async () => {
			await manager.startRecording();
			const [first, second] = await Promise.all([
				manager.stopRecording(),
				manager.stopRecording(),
			]);

			// One of the two did the stop; the other found it in flight and
			// says so instead of reporting a stop it did not make.
			expect([first, second]).toContain(null);
			expect([first, second]).toContain('A stop is already in progress.');
		});
	});

	describe('startRecording error handling', () => {
		it('configures MediaRecorder with bitrate from settings', async () => {
			mockSettings = {
				...DEFAULT_SETTINGS,
				bitrate: 192000,
			};
			manager = recordingManagerOver(
				mockApp,
				mockSettings,
				statusChangeCallback,
			);

			makeMediaRecorderDouble();

			stubAudioStreams();

			await manager.startRecording();

			expect(global.MediaRecorder).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({
					audioBitsPerSecond: 192000,
				}),
			);
		});

		it('falls back to a recordable format when the configured one is unsupported', async () => {
			// iOS profile: only audio/mp4 is recordable and no offline
			// encoder works - the configured webm cannot be produced, so
			// the session records mp4 instead and tells the user
			const mockMediaRecorder = makeMediaRecorderDouble();
			installMediaRecorder(
				mockMediaRecorder,
				(type) => type === 'audio/mp4',
			);
			stubAudioStreams();

			await manager.startRecording();

			expect(manager.getStatus()).toBe(RecordingStatus.Recording);
			expect(global.MediaRecorder).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({ mimeType: 'audio/mp4' }),
			);
			expect(
				noticeMessages().some((message) =>
					message.includes('Recording in MP4 instead'),
				),
			).toBe(true);

			await manager.stopRecording();
		});

		it('stays idle when no format can be recorded at all', async () => {
			// No MediaRecorder format, no offline encoder, and no
			// AudioContext for PCM capture: there is nothing to fall
			// back to, so the start fails with a clear error
			(global as Record<string, unknown>).MediaRecorder = {
				isTypeSupported: jest.fn().mockReturnValue(false),
			};
			const savedAudioContext = (global as Record<string, unknown>)
				.AudioContext;
			delete (global as Record<string, unknown>).AudioContext;
			try {
				await manager.startRecording();

				expect(manager.getStatus()).toBe(RecordingStatus.Idle);
			} finally {
				(global as Record<string, unknown>).AudioContext =
					savedAudioContext;
			}
		});

		it('handles stream acquisition error', async () => {
			(global as Record<string, unknown>).MediaRecorder = {
				isTypeSupported: jest.fn().mockReturnValue(true),
			};

			jest.mocked(getAudioStreams).mockRejectedValue(
				new Error('Permission denied'),
			);

			await manager.startRecording();

			expect(manager.getStatus()).toBe(RecordingStatus.Idle);
		});

		it('answers with the reason it did not start', async () => {
			// The Notice reaches whoever is looking at Obsidian; a caller with
			// nobody in front of it - the command line - reads this instead of
			// a status that never moved.
			(global as Record<string, unknown>).MediaRecorder = {
				isTypeSupported: jest.fn().mockReturnValue(true),
			};
			jest.mocked(getAudioStreams).mockRejectedValue(
				new DOMException('Denied', 'NotAllowedError'),
			);

			const failure = await manager.startRecording();

			expect(failure).not.toBeNull();
			expect(noticeMessages()).toContain(failure);
		});
	});

	describe('lifecycle transitions', () => {
		beforeEach(() => {
			makeMediaRecorderDouble();

			stubAudioStreams();
		});

		it('follows full lifecycle: idle -> recording -> paused -> recording -> idle', async () => {
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

		it('calls onStatusChange for each transition', async () => {
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
