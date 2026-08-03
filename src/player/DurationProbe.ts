/**
 * Resolves an initially-unknown media duration on the shared audio element.
 * Some sources load with no usable length - Infinity/NaN (common for
 * MediaRecorder WebM) or a finite 0 (some multitrack mp4 whose container
 * never got its real length stamped) - and need a probe seek to coax the
 * browser into computing the true duration.
 * @module player/DurationProbe
 */

import { DURATION_PROBE_SECONDS } from '../utils/mediaDuration';

/**
 * How long to wait for a probed stream to report its real duration
 * before giving up, so playback is not left stranded at the probe seek
 * position when the corrected duration never arrives.
 */
const DURATION_PROBE_TIMEOUT_MS = 5000;

/**
 * Probes the shared audio element for its real duration. One instance per
 * player; re-probing while a probe is active is a no-op.
 */
export class DurationProbe {
	private active = false;
	/** Detaches the in-flight probe's listener and watchdog, if any. */
	private detach: (() => void) | null = null;

	/**
	 * @param audio - The shared audio element to probe
	 * @param onResolved - Called after every probe ends (resolved or given
	 *   up), with playback restored to the start, so the caller can refresh
	 *   its markers and progress display
	 */
	constructor(
		private readonly audio: HTMLAudioElement,
		private readonly onResolved: () => void,
	) {}

	/**
	 * Resolves a duration the browser does not report up front by probing a
	 * far seek position and waiting for a real, positive value, then
	 * restoring the start. When the seek yields no usable length the
	 * watchdog gives up and the bar stays unseekable, so a truly
	 * length-less file degrades rather than hangs.
	 */
	probe(): void {
		if (this.active) {
			return;
		}
		this.active = true;
		let watchdog = 0;
		const finish = (): void => {
			this.audio.removeEventListener('durationchange', onDurationChange);
			window.clearTimeout(watchdog);
			this.active = false;
			this.detach = null;
			// Restore the start position; leaving currentTime near the probe
			// value would strand playback at the end of the file. The #t= start
			// (if any) is shown via the display hint, not by moving the shared
			// element here.
			this.audio.currentTime = 0;
			this.onResolved();
		};
		const onDurationChange = (): void => {
			// Wait for a real, positive length: a file that loaded at 0 reports a
			// finite-but-useless 0, so finishing on "finite" alone would lock in
			// the bogus zero instead of the corrected duration.
			if (
				Number.isFinite(this.audio.duration) &&
				this.audio.duration > 0
			) {
				finish();
			}
		};
		this.audio.addEventListener('durationchange', onDurationChange);
		// Give up if the corrected duration never arrives, so the probe
		// seek position is not left stranded at the end of the stream
		watchdog = window.setTimeout(() => {
			if (this.active) {
				finish();
			}
		}, DURATION_PROBE_TIMEOUT_MS);
		this.detach = () => {
			this.audio.removeEventListener('durationchange', onDurationChange);
			window.clearTimeout(watchdog);
		};
		try {
			this.audio.currentTime = DURATION_PROBE_SECONDS;
		} catch {
			// Some sources reject the probe seek; give up immediately and
			// fall back to a non-seekable display
			finish();
		}
	}

	/**
	 * Cancels an in-flight probe without touching playback. Called on
	 * player unload so the listener and watchdog never outlive the player.
	 */
	cancel(): void {
		this.detach?.();
		this.detach = null;
		this.active = false;
	}
}
