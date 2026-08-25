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
 * list moved and is the backstop where the first signal does not arrive. Both
 * are reduced to one fact - this stream is gone - so the session has a single
 * rule for what a loss means, and each stream is reported at most once
 * whichever signal came first.
 * @module recording/CaptureLossWatcher
 */

import { PLUGIN_LOG_PREFIX } from '../constants';
import type { AudioRecorderSettings } from '../settings/settingsSchema';
import {
	missingCaptureIndexes,
	watchStreamEndings,
} from './AudioStreamHandler';

/**
 * One capture stream is gone.
 * @param streamIndex - Which of the session's streams was lost
 * @param remaining - How many of them are still live
 */
export type CaptureLossHandler = (
	streamIndex: number,
	remaining: number,
) => void;

/**
 * Subscribes an active session to the loss of its capture devices.
 */
export class CaptureLossWatcher {
	private detachTracks: (() => void) | null = null;
	private deviceChangeHandler: (() => void) | null = null;
	private onStreamEnded: CaptureLossHandler | null = null;
	/** Streams already reported, so two signals for one loss report once. */
	private readonly lost = new Set<number>();
	private streamCount = 0;

	/**
	 * Starts watching one session. Releases any previous subscription first,
	 * so a second session never inherits the first one's bookkeeping.
	 * @param streams - The session's capture streams, in track order
	 * @param getSettings - Reads the live settings for the device re-check
	 * @param onStreamEnded - Where losses are reported
	 */
	start(
		streams: readonly MediaStream[],
		getSettings: () => AudioRecorderSettings,
		onStreamEnded: CaptureLossHandler,
	): void {
		this.release();
		this.onStreamEnded = onStreamEnded;
		this.streamCount = streams.length;
		this.detachTracks = watchStreamEndings(streams, (index) => {
			this.reportStreamEnded(index);
		});
		this.reportStreamsAlreadyEnded(streams);
		// Absent where the platform exposes no device list at all; the track
		// subscription above is then the only signal, which is enough.
		const devices = navigator.mediaDevices as MediaDevices | undefined;
		if (!devices) {
			return;
		}
		this.deviceChangeHandler = (): void => {
			void this.reportMissingDevices(getSettings());
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
		this.onStreamEnded = null;
		this.lost.clear();
		this.streamCount = 0;
	}

	/**
	 * Reports whatever the device list says this session has already lost.
	 *
	 * Reported per stream, exactly as a track ending is, because they are the
	 * same event seen two ways: one interface pulled out of a multi-track rig
	 * costs that track and not the interview, whichever signal noticed.
	 *
	 * A check that could not run says nothing about the devices. Reading its
	 * own failure as a lost input - which a rejected `enumerateDevices` used
	 * to be - ends a session that is recording perfectly well.
	 * @param settings - Live settings naming the configured inputs
	 */
	private async reportMissingDevices(
		settings: AudioRecorderSettings,
	): Promise<void> {
		let missing: number[];
		try {
			missing = await missingCaptureIndexes(settings);
		} catch (error) {
			console.warn(
				`${PLUGIN_LOG_PREFIX} Could not re-check the capture devices:`,
				error,
			);
			return;
		}
		for (const index of missing) {
			this.reportStreamEnded(index);
		}
	}

	/**
	 * Reports the streams that were already dead when the watch began.
	 *
	 * Subscribing is not enough on its own. A device pulled out while the
	 * recorders were still being built ends its track before anything is
	 * listening, and that event does not come again, so the session would run
	 * on with an input that is already gone. The state answers where the event
	 * has been and gone.
	 * @param streams - The session's capture streams, in track order
	 */
	private reportStreamsAlreadyEnded(streams: readonly MediaStream[]): void {
		streams.forEach((stream, index) => {
			const ended = stream
				.getTracks()
				.some((track) => track.readyState === 'ended');
			if (ended) {
				this.reportStreamEnded(index);
			}
		});
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
		this.onStreamEnded?.(index, this.streamCount - this.lost.size);
	}
}
