/**
 * Watches an active capture session for the disappearance of its input.
 *
 * A recording session used to be described entirely by what the user does to
 * it: start, pause, stop. Nothing described the input going away on its own,
 * so nothing handled it. A USB interface pulled out, a Bluetooth headset that
 * dropped its link, an output the operating system switched: each ends the
 * capture track, and the session carried on with its status lit, its clock
 * running, and silence going to disk. The user found out when the finished
 * file turned out to be empty, which is after the meeting.
 *
 * Two signals say the same thing. The platform ends the track, which is exact
 * and names the stream. It also fires `devicechange`, which says only that the
 * list moved and is the backstop where the first signal does not arrive. The
 * watcher takes both and reports each stream at most once, whichever came
 * first.
 * @module recording/CaptureLossWatcher
 */

import type { AudioRecorderSettings } from '../settings/settingsSchema';
import {
	validateSelectedDevices,
	watchStreamEndings,
} from './AudioStreamHandler';

/** What a session wants to hear about losing its input. */
export interface CaptureLossHandlers {
	/**
	 * One capture stream ended.
	 * @param streamIndex - Which of the session's streams was lost
	 * @param remaining - How many of them are still live
	 */
	onStreamEnded(streamIndex: number, remaining: number): void;
	/**
	 * The system device list changed and a device this session records from is
	 * no longer among them.
	 * @param reason - What the device check said is missing
	 */
	onSelectedDeviceMissing(reason: string): void;
}

/**
 * Subscribes an active session to the loss of its capture devices.
 */
export class CaptureLossWatcher {
	private detachTracks: (() => void) | null = null;
	private deviceChangeHandler: (() => void) | null = null;
	private handlers: CaptureLossHandlers | null = null;
	/** Streams already reported, so two signals for one loss report once. */
	private readonly lost = new Set<number>();
	private streamCount = 0;

	/**
	 * Starts watching one session. Releases any previous subscription first,
	 * so a second session never inherits the first one's bookkeeping.
	 * @param streams - The session's capture streams, in track order
	 * @param getSettings - Reads the live settings for the device re-check
	 * @param handlers - Where losses are reported
	 */
	start(
		streams: readonly MediaStream[],
		getSettings: () => AudioRecorderSettings,
		handlers: CaptureLossHandlers,
	): void {
		this.release();
		this.handlers = handlers;
		this.streamCount = streams.length;
		this.detachTracks = watchStreamEndings(streams, (index) => {
			this.reportStreamEnded(index);
		});
		// Absent where the platform exposes no device list at all; the track
		// subscription above is then the only signal, which is enough.
		const devices = navigator.mediaDevices as MediaDevices | undefined;
		if (!devices) {
			return;
		}
		this.deviceChangeHandler = (): void => {
			// The check is the one already used at start: it knows which
			// devices this configuration needs and says so by throwing.
			validateSelectedDevices(getSettings()).catch((error: unknown) => {
				this.handlers?.onSelectedDeviceMissing(
					error instanceof Error ? error.message : String(error),
				);
			});
		};
		devices.addEventListener('devicechange', this.deviceChangeHandler);
	}

	/**
	 * Takes every subscription back down. Runs on every path that ends a
	 * session, including the rollback of a failed start and plugin unload, and
	 * is safe to call when nothing was ever started.
	 */
	release(): void {
		this.detachTracks?.();
		this.detachTracks = null;
		const devices = navigator.mediaDevices as MediaDevices | undefined;
		if (devices && this.deviceChangeHandler) {
			devices.removeEventListener(
				'devicechange',
				this.deviceChangeHandler,
			);
		}
		this.deviceChangeHandler = null;
		this.handlers = null;
		this.lost.clear();
		this.streamCount = 0;
	}

	/**
	 * Reports one stream as lost, once.
	 * @param index - Which stream ended
	 */
	private reportStreamEnded(index: number): void {
		if (this.lost.has(index)) {
			return;
		}
		this.lost.add(index);
		this.handlers?.onStreamEnded(index, this.streamCount - this.lost.size);
	}
}
