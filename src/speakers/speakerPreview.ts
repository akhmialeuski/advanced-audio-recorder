/**
 * Which stretch of a recording the rename dialog plays to identify a speaker.
 *
 * The dialog covers the note it was opened over, so "who is Speaker 2?" cannot
 * be answered by scrolling the transcript behind it. The roster stored in the
 * sidecar carries the span of each speaker's first uninterrupted turn, and this
 * module turns that span into a bounded excerpt: long enough to recognize a
 * voice when the turn is a one-word "Yeah", short enough that a ten-minute
 * monologue does not play on after the question is answered.
 *
 * Pure and side-effect free; {@link player/SpeakerPreviewPlayer} does the
 * playing.
 * @module speakers/speakerPreview
 */

import type { SpeakerEntry } from '../sidecar/recordingSidecarModel';

/**
 * Shortest excerpt a preview plays. A first turn is often a single word, and
 * half a second of audio identifies nobody, so a short turn is extended into
 * the audio that follows it - which is the same speaker still talking, or the
 * reply that names them.
 */
export const SPEAKER_PREVIEW_MIN_SECONDS = 4;

/**
 * Longest excerpt a preview plays. The user is answering "who is this?", not
 * listening to the meeting, so an opening monologue is cut off rather than
 * requiring a second press of Stop.
 */
export const SPEAKER_PREVIEW_MAX_SECONDS = 15;

/** The stretch of audio a preview plays, in seconds on the recording timeline. */
export interface SpeakerPreviewRange {
	/** Offset playback starts at. */
	start: number;
	/** Offset playback stops at (always greater than the start). */
	end: number;
}

/**
 * The excerpt to play for one roster entry, or null when the recording stores
 * no first-turn offset for it - a roster written before offsets were stored, or
 * a speaker whose entry survived from an earlier transcription that no longer
 * appears in the timeline. The dialog disables the preview button in that case
 * rather than playing from an offset it does not have.
 *
 * The span is clamped into
 * [{@link SPEAKER_PREVIEW_MIN_SECONDS}, {@link SPEAKER_PREVIEW_MAX_SECONDS}],
 * so every preview is long enough to recognize and short enough to sit through.
 * @param entry - Roster entry as stored in the recording's sidecar
 * @returns The excerpt to play, or null when the entry carries no offset
 */
export function speakerPreviewRange(
	entry: SpeakerEntry,
): SpeakerPreviewRange | null {
	if (entry.firstStart === undefined) {
		return null;
	}
	const start = Math.max(0, entry.firstStart);
	// A turn end below the start (hand-edited sidecar) degrades to a zero-length
	// turn, which the minimum below then extends - never to a backwards range.
	const turnSeconds = Math.max(0, (entry.firstEnd ?? start) - start);
	const seconds = Math.min(
		SPEAKER_PREVIEW_MAX_SECONDS,
		Math.max(SPEAKER_PREVIEW_MIN_SECONDS, turnSeconds),
	);
	return { start, end: start + seconds };
}
