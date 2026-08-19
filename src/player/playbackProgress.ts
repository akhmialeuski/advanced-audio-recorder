/**
 * Pure playback-position helper shared by the waveform and the plain seek
 * bar, so both show the same played fraction and stay consistent.
 * @module player/playbackProgress
 */

/**
 * Fraction of the file played so far, clamped to 0..1. Returns 0 when the
 * duration is unknown or non-positive, so the progress indicator never jumps
 * to a bogus position before metadata has loaded.
 * @param currentTime - Current playback position in seconds
 * @param duration - Total duration in seconds
 * @returns Played fraction in the range 0..1
 */
export function playbackProgress(
	currentTime: number,
	duration: number,
): number {
	if (!Number.isFinite(duration) || duration <= 0) {
		return 0;
	}
	// A media element reports NaN for currentTime between a source swap and
	// the first timeupdate. Dividing it through would put NaN in the fill's
	// width, which renders as no bar at all rather than as an empty one.
	if (Number.isNaN(currentTime)) {
		return 0;
	}
	return Math.min(1, Math.max(0, currentTime / duration));
}
