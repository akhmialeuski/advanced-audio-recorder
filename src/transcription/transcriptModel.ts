/**
 * Pure operations over the transcript data model: sorting, normalization,
 * chunk stitching (time offsetting + concatenation), and speaker
 * collection/renaming. No DOM, network, or I/O — all logic here is unit
 * tested directly.
 * @module transcription/transcriptModel
 */

import type {
	Transcript,
	TranscriptSegment,
	TranscriptWord,
} from './TranscriptTypes';

/**
 * Collapses runs of whitespace to single spaces and trims the ends.
 * @param text - Raw text
 */
export function normalizeWhitespace(text: string): string {
	return text.replace(/\s+/g, ' ').trim();
}

/**
 * Returns the distinct speaker labels across the segments, in the order
 * they first appear.
 * @param segments - Transcript segments
 */
export function collectSpeakers(
	segments: readonly TranscriptSegment[],
): string[] {
	const seen = new Set<string>();
	const order: string[] = [];
	for (const segment of segments) {
		if (segment.speaker && !seen.has(segment.speaker)) {
			seen.add(segment.speaker);
			order.push(segment.speaker);
		}
	}
	return order;
}

/**
 * Sorts segments by start time (stable for equal starts) and normalizes
 * each segment's text whitespace. Returns a new array.
 * @param segments - Transcript segments
 */
export function normalizeSegments(
	segments: readonly TranscriptSegment[],
): TranscriptSegment[] {
	return [...segments]
		.map((segment) => ({
			...segment,
			text: normalizeWhitespace(segment.text),
		}))
		.sort((a, b) => a.start - b.start);
}

/**
 * Shifts every timestamp in a segment (and its words) by a fixed number
 * of seconds. Used to stitch chunk transcripts back onto the original
 * timeline. Returns a new segment.
 * @param segment - Segment to offset
 * @param offsetSeconds - Seconds to add to every timestamp
 */
export function offsetSegment(
	segment: TranscriptSegment,
	offsetSeconds: number,
): TranscriptSegment {
	const words: TranscriptWord[] | undefined = segment.words?.map((word) => ({
		...word,
		start: word.start + offsetSeconds,
		end: word.end + offsetSeconds,
	}));
	return {
		...segment,
		start: segment.start + offsetSeconds,
		end: segment.end + offsetSeconds,
		...(words ? { words } : {}),
	};
}

/**
 * Builds a finished Transcript from segments, normalizing and sorting
 * them and deriving the speaker list. Metadata fields are passed through.
 * @param segments - Raw segments
 * @param meta - Optional provenance/metadata
 */
export function buildTranscript(
	segments: readonly TranscriptSegment[],
	meta: Partial<Omit<Transcript, 'segments' | 'speakers'>> = {},
): Transcript {
	const normalized = normalizeSegments(segments);
	return {
		...meta,
		segments: normalized,
		speakers: collectSpeakers(normalized),
	};
}

/**
 * Stitches a series of per-chunk transcripts into one, offsetting each
 * chunk's timestamps by its start offset on the original timeline. The
 * detected language and model are taken from the first chunk that
 * provides them. Returns a fully built transcript.
 * @param chunks - Per-chunk results, each with its timeline start offset
 * @param meta - Optional provenance/metadata for the combined transcript
 */
export function stitchChunks(
	chunks: readonly { offsetSeconds: number; transcript: Transcript }[],
	meta: Partial<Omit<Transcript, 'segments' | 'speakers'>> = {},
): Transcript {
	const segments: TranscriptSegment[] = [];
	let language: string | undefined = meta.language;
	for (const { offsetSeconds, transcript } of chunks) {
		language ??= transcript.language;
		for (const segment of transcript.segments) {
			segments.push(offsetSegment(segment, offsetSeconds));
		}
	}
	return buildTranscript(segments, { ...meta, language });
}

/**
 * Renames a speaker label across all segments, returning a new transcript.
 * Used by the UI to turn provider labels ("SPEAKER_00") into names.
 * @param transcript - Source transcript
 * @param from - Existing speaker label
 * @param to - Replacement label
 */
export function renameSpeaker(
	transcript: Transcript,
	from: string,
	to: string,
): Transcript {
	const segments = transcript.segments.map((segment) =>
		segment.speaker === from ? { ...segment, speaker: to } : segment,
	);
	return {
		...transcript,
		segments,
		speakers: collectSpeakers(segments),
	};
}

/**
 * Joins all segment text into a single normalized paragraph string.
 * @param transcript - Source transcript
 */
export function plainText(transcript: Transcript): string {
	return normalizeWhitespace(
		transcript.segments.map((segment) => segment.text).join(' '),
	);
}
