/**
 * Unit tests for what the RecordingManager reports while a session is
 * running: the input level the VU meter draws, the bytes captured so far,
 * and the pause-aware elapsed time.
 *
 * These three are read on an interval by the status bar and the recording
 * banner, so a wrong answer is not an error anyone sees - it is a meter that
 * sits at zero, or a clock that keeps counting through a pause.
 * @module tests/unit/RecordingManager.liveStats.test
 */

import { RecordingStatus } from 'src/types';
import { InputLevelMonitor } from 'src/recording/InputLevelMonitor';
import {
	createDesktopRecorder,
	createRecordingSut,
	installMediaRecorderFactory,
	installRecordingMediaStubs,
	stubAudioStreams,
} from '../helpers/recordingManagerTestKit';
import { useDesktopPlatform } from '../helpers/platform';
import { at } from '../helpers/assertions';
import type { MockInputLevelMonitor } from '../mocks/modules/inputLevelMonitor';

jest.mock('src/recording/AudioStreamHandler', () =>
	require('../mocks/modules/audioStreamHandler'),
);
jest.mock('src/audio/AudioEncoder', () =>
	require('../mocks/modules/audioEncoder'),
);
jest.mock('src/audio/WavEncoder', () => require('../mocks/modules/wavEncoder'));
jest.mock('src/recording/PcmStreamRecorder', () =>
	require('../mocks/modules/pcmStreamRecorder'),
);
jest.mock('src/recording/InputLevelMonitor', () =>
	require('../mocks/modules/inputLevelMonitor'),
);

installRecordingMediaStubs();

/** The level monitor the manager built, asserting it built one. */
function monitor(): MockInputLevelMonitor {
	return at(
		jest.mocked(InputLevelMonitor).mock.instances,
		0,
		'level monitor',
	) as unknown as MockInputLevelMonitor;
}

describe('the input level the meter draws', () => {
	beforeEach(() => {
		useDesktopPlatform();
		createDesktopRecorder();
	});

	it('reads zero before anything is being recorded', () => {
		const { manager } = createRecordingSut({
			settings: { showInputLevelMeter: true },
		});

		expect(manager.getInputLevel()).toBe(0);
	});

	it('reports what the monitor is reading mid-recording', async () => {
		const { manager } = createRecordingSut({
			settings: { showInputLevelMeter: true },
		});

		await manager.startRecording();
		monitor().getLevel.mockReturnValue(0.42);

		expect(manager.getInputLevel()).toBe(0.42);
	});

	// One meter for a multi-track session, and it stands for the primary
	// input: metering track two would draw a level for audio the user is not
	// watching. Two streams on purpose - a single-stream session cannot tell
	// "the first" from "whichever one".
	it('meters the first stream, which is the one the meter stands for', async () => {
		const streams = stubAudioStreams({ count: 2 });
		const { manager } = createRecordingSut({
			settings: { showInputLevelMeter: true, enableMultiTrack: true },
		});

		await manager.startRecording();

		expect(monitor().start).toHaveBeenCalledTimes(1);
		expect(monitor().start).toHaveBeenCalledWith(at(streams, 0));
	});

	it('starts no monitor at all when the meter is switched off', async () => {
		const { manager } = createRecordingSut({
			settings: { showInputLevelMeter: false },
		});

		await manager.startRecording();

		expect(InputLevelMonitor).not.toHaveBeenCalled();
		expect(manager.getInputLevel()).toBe(0);
	});

	it('releases the monitor and falls back to zero once stopped', async () => {
		const { manager } = createRecordingSut({
			settings: { showInputLevelMeter: true },
		});

		await manager.startRecording();
		const started = monitor();
		started.getLevel.mockReturnValue(0.9);
		await manager.stopRecording();

		expect(started.stop).toHaveBeenCalledTimes(1);
		expect(manager.getInputLevel()).toBe(0);
	});
});

describe('the bytes captured so far', () => {
	beforeEach(() => {
		useDesktopPlatform();
	});

	it('starts at zero', () => {
		const { manager } = createRecordingSut();

		expect(manager.getRecordedBytes()).toBe(0);
	});

	it('counts every chunk the recorder delivered', async () => {
		const recorder = createDesktopRecorder();
		const { manager } = createRecordingSut();

		await manager.startRecording();
		recorder.ondataavailable?.({
			data: new Blob([new Uint8Array(120)], { type: 'audio/webm' }),
		} as BlobEvent);
		recorder.ondataavailable?.({
			data: new Blob([new Uint8Array(80)], { type: 'audio/webm' }),
		} as BlobEvent);

		expect(manager.getRecordedBytes()).toBe(200);
	});
});

describe('the elapsed time the clock shows', () => {
	beforeEach(() => {
		useDesktopPlatform();
		createDesktopRecorder();
		jest.useFakeTimers();
		jest.setSystemTime(0);
	});

	afterEach(() => {
		jest.useRealTimers();
	});

	it('reads zero while nothing is being recorded', () => {
		const { manager } = createRecordingSut();

		expect(manager.getElapsedMs()).toBe(0);
	});

	it('counts the time since the recording started', async () => {
		const { manager } = createRecordingSut();

		await manager.startRecording();
		jest.setSystemTime(30_000);

		expect(manager.getElapsedMs()).toBe(30_000);
	});

	// The clock is what the user reads to decide the take is long enough, so
	// it has to agree with the audio: a paused minute is not recorded.
	it('freezes while the recording is paused', async () => {
		const { manager } = createRecordingSut();

		await manager.startRecording();
		jest.setSystemTime(30_000);
		manager.togglePauseResume();
		jest.setSystemTime(90_000);

		expect(manager.getStatus()).toBe(RecordingStatus.Paused);
		expect(manager.getElapsedMs()).toBe(30_000);
	});

	it('resumes counting from where it froze', async () => {
		const { manager } = createRecordingSut();

		await manager.startRecording();
		jest.setSystemTime(30_000);
		manager.togglePauseResume();
		jest.setSystemTime(90_000);
		manager.togglePauseResume();
		jest.setSystemTime(100_000);

		expect(manager.getElapsedMs()).toBe(40_000);
	});

	it('reads zero again once the recording is stopped', async () => {
		const { manager } = createRecordingSut();

		await manager.startRecording();
		jest.setSystemTime(30_000);
		await manager.stopRecording();

		expect(manager.getElapsedMs()).toBe(0);
	});
});

// The meter is started before the recorders are built, so every failure below
// that point used to leave its AudioContext open: the rollback listed the
// resources it released by name and the meter was not among them. Chromium
// caps the live contexts per document, so a user whose start fails regularly
// loses the meter altogether until Obsidian restarts.
describe('a start that fails after the meter is already running', () => {
	beforeEach(() => {
		useDesktopPlatform();
		jest.spyOn(console, 'error').mockImplementation();
		installMediaRecorderFactory(() => {
			throw new Error('mimeType is not supported');
		});
		stubAudioStreams();
	});

	it('releases the monitor when building the recorders throws', async () => {
		const { manager } = createRecordingSut({
			settings: { showInputLevelMeter: true },
		});

		await manager.startRecording();

		expect(monitor().stop).toHaveBeenCalledTimes(1);
		expect(manager.getInputLevel()).toBe(0);
	});

	it('leaves nothing running after three failed starts in a row', async () => {
		const { manager } = createRecordingSut({
			settings: { showInputLevelMeter: true },
		});

		await manager.startRecording();
		await manager.startRecording();
		await manager.startRecording();

		const built = jest.mocked(InputLevelMonitor).mock
			.instances as unknown as MockInputLevelMonitor[];
		expect(built).toHaveLength(3);
		for (const instance of built) {
			expect(instance.stop).toHaveBeenCalledTimes(1);
		}
	});
});
