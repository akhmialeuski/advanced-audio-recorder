/**
 * Tests the watcher that notices a capture session losing its input.
 *
 * Two signals say the same thing and neither used to be listened for. The
 * platform ends a track when its device goes away, and it fires `devicechange`
 * when the device list itself changes. The first is exact and the second is
 * the backstop for a platform that does not fire the first, so the watcher
 * takes both and reports each stream at most once whichever arrived.
 * @module tests/unit/CaptureLossWatcher.test
 */

import { CaptureLossWatcher } from 'src/recording/CaptureLossWatcher';
import { DEFAULT_SETTINGS } from 'src/settings/settingsSchema';
import { validateSelectedDevices } from 'src/recording/AudioStreamHandler';
import { partial } from '../helpers/doubles';
import { at } from '../helpers/assertions';
import { flushMicrotasks } from '../helpers/async';

// The real track subscription is what this watcher is built on, so only the
// device re-check is replaced: it is the one call that would otherwise reach
// the platform's device list.
jest.mock('src/recording/AudioStreamHandler', () => ({
	...jest.requireActual('src/recording/AudioStreamHandler'),
	validateSelectedDevices: jest.fn(),
}));

/** Every `ended` handler subscribed to the streams, by stream index. */
const endedHandlers: (() => void)[] = [];

/** A stream whose single track records its subscription. */
function streamDouble(): MediaStream {
	return partial<MediaStream>({
		getTracks: () => [
			partial<MediaStreamTrack>({
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
	let onSelectedDeviceMissing: jest.Mock;

	beforeEach(() => {
		endedHandlers.length = 0;
		installMediaDevices();
		jest.mocked(validateSelectedDevices).mockResolvedValue(undefined);
		watcher = new CaptureLossWatcher();
		onStreamEnded = jest.fn();
		onSelectedDeviceMissing = jest.fn();
	});

	afterEach(() => {
		watcher.release();
	});

	/**
	 * Starts the watcher over the given number of streams.
	 * @param count - How many capture streams the session holds
	 */
	function watch(count: number): void {
		watcher.start(
			Array.from({ length: count }, () => streamDouble()),
			() => DEFAULT_SETTINGS,
			{ onStreamEnded, onSelectedDeviceMissing },
		);
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

	it('says nothing on a device change that leaves the selection intact', async () => {
		watch(1);

		at(deviceChangeHandlers, 0)();
		await flushMicrotasks();

		expect(onSelectedDeviceMissing).not.toHaveBeenCalled();
	});

	it('reports the reason when a device change loses the selected input', async () => {
		jest.mocked(validateSelectedDevices).mockRejectedValue(
			new Error('Selected audio input device is no longer available.'),
		);
		watch(1);

		at(deviceChangeHandlers, 0)();
		await flushMicrotasks();

		expect(onSelectedDeviceMissing).toHaveBeenCalledWith(
			'Selected audio input device is no longer available.',
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
