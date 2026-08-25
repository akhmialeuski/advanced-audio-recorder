/**
 * Tests the watcher that notices a capture session losing its input.
 *
 * Two signals say the same thing and neither used to be listened for. The
 * platform ends a track when its device goes away, and it fires `devicechange`
 * when the device list itself changes. Both are reduced to one fact - this
 * stream is gone - so a session has a single rule for what a loss means, and
 * each stream is reported at most once whichever signal arrived.
 * @module tests/unit/CaptureLossWatcher.test
 */

import { CaptureLossWatcher } from 'src/recording/CaptureLossWatcher';
import { DEFAULT_SETTINGS } from 'src/settings/settingsSchema';
import { missingCaptureIndexes } from 'src/recording/AudioStreamHandler';
import { partial } from '../helpers/doubles';
import { at } from '../helpers/assertions';
import { flushMicrotasks } from '../helpers/async';

// The real track subscription is what this watcher is built on, so only the
// device re-check is replaced: it is the one call that would otherwise reach
// the platform's device list.
jest.mock('src/recording/AudioStreamHandler', () => ({
	...jest.requireActual('src/recording/AudioStreamHandler'),
	missingCaptureIndexes: jest.fn(),
}));

/** Every `ended` handler subscribed to the streams, by stream index. */
const endedHandlers: (() => void)[] = [];

/**
 * A stream whose single track records its subscription.
 * @param readyState - Whether the track is still live when the watch begins
 */
function streamDouble(readyState: MediaStreamTrackState = 'live'): MediaStream {
	return partial<MediaStream>({
		getTracks: () => [
			partial<MediaStreamTrack>({
				readyState,
				addEventListener: (_event: string, handler: unknown) => {
					endedHandlers.push(handler as () => void);
				},
				removeEventListener: jest.fn(),
			}),
		],
	});
}

/** The devicechange listeners the watcher attached. */
let deviceChangeHandlers: (() => void)[] = [];
let removedDeviceChange: number;

/** Installs a mediaDevices double for the current test. */
function installMediaDevices(): void {
	deviceChangeHandlers = [];
	removedDeviceChange = 0;
	Object.defineProperty(navigator, 'mediaDevices', {
		value: {
			addEventListener: (_event: string, handler: unknown) => {
				deviceChangeHandlers.push(handler as () => void);
			},
			removeEventListener: () => {
				removedDeviceChange += 1;
			},
		},
		configurable: true,
	});
}

/** Drops mediaDevices entirely, as a platform without it would. */
function removeMediaDevices(): void {
	Object.defineProperty(navigator, 'mediaDevices', {
		value: undefined,
		configurable: true,
	});
}

describe('CaptureLossWatcher', () => {
	let watcher: CaptureLossWatcher;
	let onStreamEnded: jest.Mock;

	beforeEach(() => {
		endedHandlers.length = 0;
		installMediaDevices();
		jest.mocked(missingCaptureIndexes).mockResolvedValue([]);
		watcher = new CaptureLossWatcher();
		onStreamEnded = jest.fn();
	});

	afterEach(() => {
		watcher.release();
	});

	/**
	 * Starts the watcher over the given streams.
	 * @param streams - The session's capture streams
	 */
	function watchStreams(streams: MediaStream[]): void {
		watcher.start(streams, () => DEFAULT_SETTINGS, onStreamEnded);
	}

	/**
	 * Starts the watcher over the given number of live streams.
	 * @param count - How many capture streams the session holds
	 */
	function watch(count: number): void {
		watchStreams(Array.from({ length: count }, () => streamDouble()));
	}

	/**
	 * Announces a device change and lets the check that follows it settle.
	 */
	async function announceDeviceChange(): Promise<void> {
		at(deviceChangeHandlers, 0)();
		await flushMicrotasks();
	}

	it('reports how many streams are still live when one ends', () => {
		watch(3);

		at(endedHandlers, 1)();

		expect(onStreamEnded).toHaveBeenCalledWith(1, 2);
	});

	it('reports no survivors when the only stream ends', () => {
		watch(1);

		at(endedHandlers, 0)();

		expect(onStreamEnded).toHaveBeenCalledWith(0, 0);
	});

	// A track can end and then have its device re-enumerated, and both
	// signals point at the same stream; counting it twice would report more
	// losses than the session has streams.
	it('reports one stream at most once', () => {
		watch(2);

		at(endedHandlers, 0)();
		at(endedHandlers, 0)();

		expect(onStreamEnded).toHaveBeenCalledTimes(1);
	});

	// A device pulled out while the recorders were still being built ends its
	// track before anything is listening, and that event does not come again.
	// Subscribing alone would leave the session running on a dead input, which
	// is the defect the whole watcher exists to remove.
	it('reports a stream whose track had already ended', () => {
		watchStreams([streamDouble('ended')]);

		expect(onStreamEnded).toHaveBeenCalledWith(0, 0);
	});

	it('leaves a session whose tracks are all live alone', () => {
		watch(2);

		expect(onStreamEnded).not.toHaveBeenCalled();
	});

	it('says nothing on a device change that leaves the selection intact', async () => {
		watch(1);

		await announceDeviceChange();

		expect(onStreamEnded).not.toHaveBeenCalled();
	});

	// The device list and the track events describe the same loss, so they are
	// reported the same way. Answering the device path with a session-wide
	// stop instead made one signal contradict the other about a multi-track
	// session, and whichever fired first decided.
	it('reports the stream the device list says is gone', async () => {
		jest.mocked(missingCaptureIndexes).mockResolvedValue([1]);
		watch(3);

		await announceDeviceChange();

		expect(onStreamEnded).toHaveBeenCalledWith(1, 2);
	});

	it('reports every stream a single device change lost', async () => {
		jest.mocked(missingCaptureIndexes).mockResolvedValue([0, 2]);
		watch(3);

		await announceDeviceChange();

		expect(onStreamEnded.mock.calls).toEqual([
			[0, 2],
			[2, 1],
		]);
	});

	// A check that could not run says nothing about the devices. Reading its
	// own failure as a lost input ends a session that is recording perfectly
	// well - and enumerateDevices rejects for reasons of its own.
	it('leaves the session alone when the device check itself fails', async () => {
		jest.spyOn(console, 'warn').mockImplementation();
		jest.mocked(missingCaptureIndexes).mockRejectedValue(
			new Error('enumeration failed'),
		);
		watch(1);

		await announceDeviceChange();

		expect(onStreamEnded).not.toHaveBeenCalled();
		expect(console.warn).toHaveBeenCalledWith(
			expect.stringContaining('re-check the capture devices'),
			expect.any(Error),
		);
	});

	// The device list keeps changing after the session is gone, and a handler
	// left attached would answer for a manager that has already torn down.
	it('stops listening to the device list once released', () => {
		watch(1);

		watcher.release();

		expect(removedDeviceChange).toBe(1);
	});

	it('reports nothing after release', () => {
		watch(1);
		watcher.release();

		at(endedHandlers, 0)();

		expect(onStreamEnded).not.toHaveBeenCalled();
	});

	it('starts a second session without carrying the first one over', () => {
		watch(1);
		at(endedHandlers, 0)();
		onStreamEnded.mockClear();

		watch(1);
		at(endedHandlers, 1)();

		expect(onStreamEnded).toHaveBeenCalledWith(0, 0);
	});

	// Not every platform exposes the device list, and a session there still
	// has to watch its tracks.
	it('watches the tracks where the platform exposes no device list', () => {
		removeMediaDevices();

		watch(1);
		at(endedHandlers, 0)();

		expect(onStreamEnded).toHaveBeenCalledWith(0, 0);
		expect(() => {
			watcher.release();
		}).not.toThrow();
	});
});
