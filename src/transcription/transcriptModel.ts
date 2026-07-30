/**
 * Pure operations over the transcript data model: sorting, normalization,
 * chunk stitching (time offsetting + concatenation), and speaker
 * collection/renaming. No DOM, network, or I/O - all logic here is unit
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

/** The timeline span of one speaker turn, in seconds. */
export interface SpeakerTurn {
	/** Offset the turn starts at. */
	start: number;
	/** Offset the turn ends at, never before the start. */
	end: number;
}

/**
 * Returns, per speaker, the span of their first uninterrupted turn: from the
 * first segment they are attributed with through the last consecutive segment
 * still theirs. This is what the rename dialog plays to answer "who is Speaker
 * 2?" without uncovering the note behind it, so it deliberately spans the whole
 * opening turn rather than one segment - engines cut a single sentence into
 * several segments, and half a sentence identifies nobody.
 *
 * Segments are read in the order given (a built transcript is sorted by start),
 * and a segment without a speaker ends the run in progress, so a later turn by
 * the same speaker never merges into their first one across a gap.
 * @param segments - Transcript segments, in timeline order
 * @returns Each speaker's first turn, keyed by label
 */
export function collectFirstTurns(
	segments: readonly TranscriptSegment[],
): Map<string, SpeakerTurn> {
	const turns = new Map<string, SpeakerTurn>();
	/** Speaker of the run in progress, or null between runs. */
	let runSpeaker: string | null = null;
	/**
	 * The recorded turn the run in progress extends, or null when this run is
	 * a later one by a speaker whose first turn is already recorded.
	 */
	let openTurn: SpeakerTurn | null = null;
	for (const segment of segments) {
		const speaker = segment.speaker;
		if (!speaker) {
			runSpeaker = null;
			openTurn = null;
			continue;
		}
		const start = Math.max(0, segment.start);
		const end = Math.max(start, segment.end);
		if (speaker === runSpeaker) {
			// Same run continuing: extend it in place (the object is the one
			// stored in the map, so the recorded turn grows with it).
			if (openTurn) {
				openTurn.end = Math.max(openTurn.end, end);
			}
			continue;
		}
		runSpeaker = speaker;
		// A speaker's first turn is the only one worth recording; later runs
		// open no turn, so the recorded span stays the opening one.
		openTurn = turns.get(speaker) ? null : { start, end };
		if (openTurn) {
			turns.set(speaker, openTurn);
		}
	}
	return turns;
}

/**
 * Returns a copy of the transcript with all speaker attribution removed:
 * every segment drops its `speaker` and the speaker list is emptied, while
 * word-level timings are kept intact. Applied when diarization is not in
 * effect so no output path - note Markdown, sidecar file, or JSON - ever
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
 * Returns a copy of the transcript with speaker labels renamed through the
 * given mapping: every segment whose speaker has a mapped name gets that
 * name, unmapped speakers keep their label, and the speaker list is
 * re-derived. Applied once on the canonical transcript so every output path
 * - note Markdown, sidecar file, or JSON - renders the same names.
 * @param transcript - Source transcript
 * @param names - Mapping from original label to display name
 */
export function renameSpeakers(
	transcript: Transcript,
	names: Record<string, string>,
): Transcript {
	if (Object.keys(names).length === 0) {
		return transcript;
	}
	const segments = transcript.segments.map((segment) => {
		const mapped = segment.speaker ? names[segment.speaker] : undefined;
		return mapped ? { ...segment, speaker: mapped } : segment;
	});
	return {
		...transcript,
		segments,
		speakers: collectSpeakers(segments),
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
