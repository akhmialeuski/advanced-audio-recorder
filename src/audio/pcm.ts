/**
 * Shared 16-bit PCM primitives used by every path that produces or
 * consumes raw int16 samples (recording capture, mixing, splitting,
 * cleanup, transcription chunking).
 * @module audio/pcm
 */

/** Bytes per sample for 16-bit PCM. */
export const PCM_BYTES_PER_SAMPLE = 2;

/** Largest signed 16-bit sample value. */
export const INT16_MAX = 32767;

/** Smallest signed 16-bit sample value. */
export const INT16_MIN = -32768;

/**
 * Maps a Float32 sample (range -1..1) to a little-endian int16 value. Uses the
 * full negative rail (-32768) for negatives and 32767 for positives, matching
 * the project's int16 mapping (PcmStreamRecorder's capture worklet), rather
 * than scaling both rails by 32767.
 * @param sample - Sample in the range -1..1
 * @returns Signed 16-bit PCM value
 */
export function floatToInt16(sample: number): number {
	const clamped = Math.max(-1, Math.min(1, sample));
	return Math.round(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff);
}
