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
	failNextPcmRecorderStop,
	makeMediaRecorderDouble,
	pcmRecorderDoubles,
	recordingManagerOver,
	stubAudioStreams,
	type MockMediaRecorder,
} from '../helpers/recordingManagerTestKit';
import { useDesktopPlatform } from '../helpers/platform';
import { at } from '../helpers/assertions';
import { flushMicrotasks, waitFor } from '../helpers/async';
import { noticeMessages } from '../mocks/obsidian';
import {
	getAudioStreams,
	stopAllStreams,
	validateSelectedDevices,
	watchStreamEndings,
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

/** Puts the environment where a WAV session captures PCM directly. */
function pcmSession(): void {
	useDesktopPlatform();
	makeMediaRecorderDouble();
	stubAudioStreams();
}

/**
 * Installs a MediaRecorder that is running and refuses to stop, plus the
 * streams it captures from.
 * @returns The capture streams, for asserting they were released
 */
function recorderThatWillNotStop(): MediaStream[] {
	makeMediaRecorderDouble({
		state: 'recording',
		stop: jest.fn(() => {
			throw new Error('InvalidStateError');
		}),
	});
	return stubAudioStreams();
}

/**
 * Makes the workspace throw when the manager reads the cursor position, the
 * last thing a start does after the recorders are already running.
 * @param app - The app double the manager was built over
 */
function failTheWorkspace(app: App): void {
	(app.workspace.getActiveViewOfType as jest.Mock).mockImplementation(() => {
		throw new Error('the workspace is gone');
	});
}

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

		it('tells the user which way the recording just went', async () => {
			await manager.toggleRecording();

			manager.togglePauseResume();
			manager.togglePauseResume();

			expect(noticeMessages()).toEqual(
				expect.arrayContaining([
					'Recording paused',
					'Recording resumed',
				]),
			);
		});

		it('says there is nothing to pause when nothing is recording', () => {
			manager.togglePauseResume();

			expect(noticeMessages()).toContain(
				'No active recording to pause or resume',
			);
		});
	});

	// WAV is captured straight from an AudioWorklet rather than through a
	// MediaRecorder, so pause and resume have to reach a different set of
	// recorders entirely. Reaching the wrong ones leaves a paused session
	// still writing samples to disk.
	describe('togglePauseResume on a WAV recording, which captures PCM', () => {
		let mockMediaRecorder: MockMediaRecorder;

		beforeEach(() => {
			useDesktopPlatform();
			mockMediaRecorder = makeMediaRecorderDouble();
			stubAudioStreams({ count: 2 });
			({
				manager,
				app: mockApp,
				settings: mockSettings,
				onStatusChange: statusChangeCallback,
			} = createRecordingSut({ settings: { recordingFormat: 'wav' } }));
		});

		it('pauses every PCM recorder of the session', async () => {
			await manager.startRecording();

			manager.togglePauseResume();

			const recorders = pcmRecorderDoubles();
			expect(recorders).toHaveLength(2);
			for (const recorder of recorders) {
				expect(recorder.pause).toHaveBeenCalledTimes(1);
			}
			expect(manager.getStatus()).toBe(RecordingStatus.Paused);
		});

		it('resumes every PCM recorder of the session', async () => {
			await manager.startRecording();

			manager.togglePauseResume();
			manager.togglePauseResume();

			for (const recorder of pcmRecorderDoubles()) {
				expect(recorder.resume).toHaveBeenCalledTimes(1);
			}
			expect(manager.getStatus()).toBe(RecordingStatus.Recording);
		});

		it('leaves the MediaRecorder path alone, which this session never built', async () => {
			await manager.startRecording();

			manager.togglePauseResume();

			expect(mockMediaRecorder.pause).not.toHaveBeenCalled();
			expect(global.MediaRecorder).not.toHaveBeenCalled();
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

		// Unload runs while the app is closing: whatever a recorder does on
		// the way out, the microphone still has to be handed back, or the
		// device stays busy until the OS notices the process is gone.
		it('releases the microphone even when a recorder refuses to stop', async () => {
			const streams = recorderThatWillNotStop();

			await manager.startRecording();
			manager.cleanup();

			expect(consoleErrorSpy).toHaveBeenCalledWith(
				expect.stringContaining('Failed to stop recorder on unload'),
				expect.any(Error),
			);
			expect(jest.mocked(stopAllStreams)).toHaveBeenCalledWith(streams);
		});

		// A recorder that already stopped itself must not be stopped again:
		// MediaRecorder throws InvalidStateError for that, which would abort
		// the rest of the unload.
		it('leaves a recorder that already stopped alone', async () => {
			const recorder = makeMediaRecorderDouble({ state: 'inactive' });
			stubAudioStreams();

			await manager.startRecording();
			manager.cleanup();

			expect(recorder.stop).not.toHaveBeenCalled();
			expect(consoleErrorSpy).not.toHaveBeenCalled();
		});

		it('reports a PCM recorder that would not release on unload', async () => {
			pcmSession();
			({ manager } = createRecordingSut({
				settings: { recordingFormat: 'wav' },
			}));

			await manager.startRecording();
			at(pcmRecorderDoubles(), 0).stop.mockRejectedValue(
				new Error('worklet gone'),
			);
			manager.cleanup();
			await flushMicrotasks();

			expect(consoleErrorSpy).toHaveBeenCalledWith(
				expect.stringContaining(
					'Failed to release PCM recorder on unload',
				),
				expect.any(Error),
			);
		});
	});

	// A start that fails partway has already taken the microphone and may
	// have built recorders; leaving either behind is what makes the next
	// attempt fail too, so the release runs whatever the teardown throws.
	describe('a start that fails after the recorders exist', () => {
		it('releases the microphone when a recorder refuses to stop', async () => {
			const streams = recorderThatWillNotStop();
			({ manager, app: mockApp } = createRecordingSut({
				settings: { insertAtOriginalPosition: true },
			}));
			failTheWorkspace(mockApp);

			await manager.startRecording();

			expect(consoleErrorSpy).toHaveBeenCalledWith(
				expect.stringContaining(
					'Failed to stop recorder after start failure',
				),
				expect.any(Error),
			);
			expect(jest.mocked(stopAllStreams)).toHaveBeenCalledWith(streams);
			expect(manager.getStatus()).toBe(RecordingStatus.Idle);
		});

		it('leaves a recorder that already stopped alone', async () => {
			const recorder = makeMediaRecorderDouble({ state: 'inactive' });
			stubAudioStreams();
			({ manager, app: mockApp } = createRecordingSut({
				settings: { insertAtOriginalPosition: true },
			}));
			failTheWorkspace(mockApp);

			await manager.startRecording();

			expect(recorder.stop).not.toHaveBeenCalled();
			expect(manager.getStatus()).toBe(RecordingStatus.Idle);
		});

		it('reports a PCM recorder that would not release', async () => {
			pcmSession();
			({ manager, app: mockApp } = createRecordingSut({
				settings: {
					recordingFormat: 'wav',
					insertAtOriginalPosition: true,
				},
			}));
			failTheWorkspace(mockApp);
			failNextPcmRecorderStop(new Error('worklet gone'));

			await manager.startRecording();
			await flushMicrotasks();

			expect(consoleErrorSpy).toHaveBeenCalledWith(
				expect.stringContaining(
					'Failed to release PCM recorder after start failure',
				),
				expect.any(Error),
			);
		});
	});

	// MediaRecorder reports a capture failure through its own error event
	// rather than by rejecting anything the manager awaited, so this is the
	// only place a mid-session hardware fault can be noticed at all.
	describe('a recorder that reports an error mid-session', () => {
		it('tells the user and leaves the session running to be stopped', async () => {
			const recorder = makeMediaRecorderDouble();
			stubAudioStreams();

			await manager.startRecording();
			recorder.onerror?.(new Event('error'));

			expect(consoleErrorSpy).toHaveBeenCalledWith(
				expect.stringContaining('Recorder error'),
				expect.any(Event),
			);
			expect(noticeMessages()).toContain(
				'Recording error occurred. Check console for details.',
			);
			expect(manager.getStatus()).toBe(RecordingStatus.Recording);
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

		// The message is what the Notice shows, so a thrown string (or
		// anything else that is not an Error) has to read as a sentence
		// rather than as "[object Object]".
		// A worklet teardown can reject with anything at all, and the Notice
		// shows the message: an unwrapped value has to read as a sentence
		// rather than as "[object Object]".
		it('names a stop failure that threw something other than an Error', async () => {
			pcmSession();
			({ manager } = createRecordingSut({
				settings: { recordingFormat: 'wav' },
			}));
			failNextPcmRecorderStop('the audio device went away');

			await manager.startRecording();
			await manager.stopRecording();

			expect(noticeMessages()).toContain(
				'Error stopping recording: the audio device went away',
			);
			expect(manager.getStatus()).toBe(RecordingStatus.Idle);
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

// The input going away used to be outside the session's model entirely: the
// status stayed Recording, the clock kept counting, and silence went to disk
// until the user opened the finished file. The session now says what happened
// the moment it happens and finalizes what it already has.
describe('an input device that disappears mid-session', () => {
	/**
	 * Ends the given capture stream, the way the platform does when its
	 * device goes away.
	 * @param streamIndex - Which of the session's streams to end
	 */
	function endStream(streamIndex: number): void {
		at(jest.mocked(watchStreamEndings).mock.calls, 0)[1](streamIndex);
	}

	beforeEach(() => {
		useDesktopPlatform();
		jest.spyOn(console, 'error').mockImplementation();
	});
	/**
	 * Starts a session over the given number of capture streams.
	 * @param streams - How many inputs the session records from
	 * @param settings - What this test needs different from the defaults
	 * @returns The manager and its collaborators, already recording
	 */
	async function startedSession(
		streams = 1,
		settings: Partial<AudioRecorderSettings> = {},
	): Promise<ReturnType<typeof createRecordingSut>> {
		makeMediaRecorderDouble();
		stubAudioStreams({ count: streams });
		const sut = createRecordingSut({ settings });
		await sut.manager.startRecording();
		return sut;
	}

	/**
	 * Installs a device list the test can announce a change on, which is the
	 * other signal a lost input arrives by.
	 * @returns The listeners the watcher attached, in order
	 */
	function watchDeviceList(): (() => void)[] {
		const listeners: (() => void)[] = [];
		Object.defineProperty(navigator, 'mediaDevices', {
			value: {
				addEventListener: (_event: string, handler: () => void) => {
					listeners.push(handler);
				},
				removeEventListener: jest.fn(),
			},
			configurable: true,
		});
		return listeners;
	}

	/**
	 * Makes the next device check report the selected input as gone, and only
	 * the next one: the mocked module keeps its implementation between tests,
	 * and a rejection left behind would fail the next session before it began.
	 */
	function loseTheSelectedDevice(): void {
		jest.mocked(validateSelectedDevices).mockRejectedValueOnce(
			new Error('Selected audio input device is no longer available.'),
		);
	}

	/**
	 * Waits for an interrupted session to finish saving.
	 * @param sut - The manager under test and its collaborators
	 */
	async function untilSaved(sut: {
		manager: { getStatus: () => RecordingStatus };
	}): Promise<void> {
		await waitFor(() => sut.manager.getStatus() === RecordingStatus.Idle, {
			message: 'the interrupted session to finish saving',
		});
	}

	// Whether the session was capturing or paused when the input went, the
	// loss is announced and what was already captured is finalized. A paused
	// session has folded its active span in, so folding it again would count
	// the time twice.
	it.each([
		{ name: 'a capturing session', pause: false },
		{ name: 'a paused session', pause: true },
	])('finalizes $name when its only input is lost', async ({ pause }) => {
		const sut = await startedSession();
		if (pause) {
			sut.manager.togglePauseResume();
		}

		endStream(0);
		await untilSaved(sut);

		expect(sut.onStatusChange).toHaveBeenCalledWith(
			RecordingStatus.Interrupted,
			undefined,
		);
		expect(noticeMessages().join(' ')).toContain('was disconnected');
	});

	it('names the lost input rather than reporting a generic failure', async () => {
		await startedSession(1, { useSourceNamesForTracks: false });

		endStream(0);
		await flushMicrotasks();

		expect(noticeMessages().join(' ')).toContain('Track1');
	});

	// Losing one interface of a multi-track session must not throw away the
	// tracks that are still capturing; the user is told which one went.
	it('keeps the other tracks recording when one of several is lost', async () => {
		const sut = await startedSession(3, {
			enableMultiTrack: true,
			useSourceNamesForTracks: false,
		});

		endStream(1);
		await flushMicrotasks();

		expect(sut.manager.getStatus()).toBe(RecordingStatus.Recording);
		expect(noticeMessages().join(' ')).toContain('Track2');
	});

	it('finalizes once the last of several tracks is lost', async () => {
		const sut = await startedSession(2, { enableMultiTrack: true });

		endStream(0);
		endStream(1);
		await untilSaved(sut);

		// Losing the last live track ends the session, and it passes through
		// the interrupted state on the way rather than looking like a stop the
		// user asked for.
		expect(sut.onStatusChange).toHaveBeenCalledWith(
			RecordingStatus.Interrupted,
			undefined,
		);
	});

	// A device that vanishes after the session already stopped has nothing to
	// interrupt, and a second Notice would report a thing that did not happen.
	it('says nothing when a stream ends after the session already stopped', async () => {
		const sut = await startedSession();
		await sut.manager.stopRecording();
		const before = noticeMessages().length;

		endStream(0);
		await flushMicrotasks();

		expect(noticeMessages()).toHaveLength(before);
	});

	// The other half of the watch: some platforms end the track, and some only
	// say the device list moved. A session whose configured input is no longer
	// in that list has lost it whichever way it was told.
	it('finalizes when the device list loses the selected input', async () => {
		const listeners = watchDeviceList();
		const sut = await startedSession();
		loseTheSelectedDevice();

		at(listeners, 0)();
		await untilSaved(sut);

		expect(noticeMessages().join(' ')).toContain('no longer available');
	});

	// One disconnection can be reported twice: the track ends and the device
	// list changes. The second report finds a session that is already
	// finalizing and has to leave it alone, or the user is told twice and the
	// stop is asked for twice.
	it('answers the second report of one loss with silence', async () => {
		const listeners = watchDeviceList();
		const sut = await startedSession();
		loseTheSelectedDevice();

		endStream(0);
		at(listeners, 0)();
		await untilSaved(sut);

		expect(
			noticeMessages().filter((message) =>
				message.includes('was disconnected'),
			),
		).toHaveLength(1);
	});

	it('takes the subscription back down when a start fails', async () => {
		const release = jest.fn();
		jest.mocked(watchStreamEndings).mockReturnValue(release);
		recorderThatWillNotStop();
		const sut = createRecordingSut({
			settings: { insertAtOriginalPosition: true },
		});
		failTheWorkspace(sut.app);

		await sut.manager.startRecording();

		expect(release).toHaveBeenCalledTimes(1);
	});
});
