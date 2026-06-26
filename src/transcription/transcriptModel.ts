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
 * Returns a copy of the transcript with all speaker attribution removed:
 * every segment drops its `speaker` and the speaker list is emptied, while
 * word-level timings are kept intact. Applied when diarization is not in
 * effect so no output path — note Markdown, sidecar file, or JSON — ever
 * shows a label the user did not ask for. The no-speakers transcript is the
 * single source of truth, so every consumer stays consistent.
 * @param transcript - Source transcript
 */
export function stripSpeakers(transcript: Transcript): Transcript {
	return {
		...transcript,
		segments: transcript.segments.map((segment) => {
			// Rebuild without the speaker field; preserve word-level timings.
			const stripped: TranscriptSegment = {
				start: segment.start,
				end: segment.end,
				text: segment.text,
			};
			if (segment.words) {
				stripped.words = segment.words;
			}
			return stripped;
		}),
		speakers: [],
	};
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
 * Joins all segment text into a single normalized paragraph string.
 * @param transcript - Source transcript
 */
export function plainText(transcript: Transcript): string {
	return normalizeWhitespace(
		transcript.segments.map((segment) => segment.text).join(' '),
	);
}
