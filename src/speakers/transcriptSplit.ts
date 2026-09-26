/**
 * Pure model for splitting one rendered transcript line between speakers.
 *
 * Diarization sometimes hands two people's words to one speaker - they talk
 * over each other, or the engine simply guesses wrong - and the timestamps of
 * such a turn are off with it. The user selects the part of the line that
 * belongs to someone else, and this module answers what is particular to the
 * split: which text lies before, inside and after the selection, where the
 * selection most likely starts and ends on the timeline, whether entered times
 * can split the line, and the pieces the line becomes. Finding the line's
 * segments, the speaker picks and the rewritten transcript are shared with the
 * merge, in {@link speakers/transcriptRows}.
 *
 * Every piece is carried as a transcript segment, so the note lines are
 * rendered by the very renderer that wrote the transcript and the JSON output
 * is rewritten from the same pieces. No DOM or I/O; unit tested directly.
 * @module speakers/transcriptSplit
 */

import {
	restoreWikilinks,
	type ParsedTranscriptLine,
} from '../transcription/transcriptFormat';
import type { TranscriptSegment } from '../transcription/TranscriptTypes';
import { parseTimecode } from '../utils/TimeUtils';
import {
	formatLineTime,
	type RowTiming,
	type TimelineSpan,
} from './transcriptRows';

/** The spoken text of a line cut at the selection, each part trimmed. */
export interface SplitTexts {
	/** Text before the selection ('' when the selection starts the text). */
	before: string;
	/** The selected text. */
	selected: string;
	/** Text after the selection ('' when the selection ends the text). */
	after: string;
}

/**
 * Cuts a line's spoken text at the selection. A selection reaching into the
 * timestamp or the speaker label is clamped to the text, so selecting "from
 * here to the end" generously still means the text.
 * @param line - The rendered line
 * @param parsed - Where its parts sit
 * @param from - Selection start column
 * @param to - Selection end column
 * @returns The three parts, or null when no spoken text is selected
 */
export function splitLineText(
	line: string,
	parsed: ParsedTranscriptLine,
	from: number,
	to: number,
): SplitTexts | null {
	const start = Math.min(Math.max(from, parsed.textStart), parsed.textEnd);
	const end = Math.min(Math.max(to, parsed.textStart), parsed.textEnd);
	const selected = line.slice(start, end).trim();
	if (selected.length === 0) {
		return null;
	}
	return {
		before: line.slice(parsed.textStart, start).trim(),
		selected,
		after: line.slice(end, parsed.textEnd).trim(),
	};
}

/** Number of whitespace-separated words in a text. */
function wordCount(text: string): number {
	return text.split(/\s+/).filter((word) => word.length > 0).length;
}

/**
 * Where the selection most likely starts and ends, offered as the dialog's
 * starting point. With word timings that match the line word for word, the
 * selection's first and last words say it exactly; otherwise the line's span
 * is shared out by the length of each part, the way speech spreads over time.
 * A part that is empty takes the line's own bound, and a line whose end is
 * unknown can only offer its start.
 * @param timing - Where the line sits
 * @param texts - The line cut at the selection
 */
export function estimateSplitTimes(
	timing: RowTiming,
	texts: SplitTexts,
): TimelineSpan {
	const before = wordCount(texts.before);
	const selected = wordCount(texts.selected);
	const words = timing.words;
	if (words && words.length === before + selected + wordCount(texts.after)) {
		const spoken = words.slice(before, before + selected);
		const lastEnd = Math.max(...spoken.map((word) => word.end));
		return {
			start: texts.before
				? Math.min(...spoken.map((word) => word.start))
				: timing.start,
			end: texts.after ? lastEnd : (timing.end ?? lastEnd),
		};
	}
	if (timing.end === null || timing.end <= timing.start) {
		return { start: timing.start, end: timing.start };
	}
	const duration = timing.end - timing.start;
	const beforeLength = texts.before.length;
	const selectedLength = texts.selected.length;
	const total = beforeLength + selectedLength + texts.after.length;
	const at = (chars: number): number =>
		timing.start + (duration * chars) / total;
	return {
		start: at(beforeLength),
		end: texts.after ? at(beforeLength + selectedLength) : timing.end,
	};
}

/**
 * Reads the entered times and checks them against the line.
 * @param start - Text of the start field
 * @param end - Text of the end field
 * @param timing - Where the line sits
 * @param texts - The line cut at the selection
 * @returns The times, or why they cannot split this line
 */
export function readSplitTimes(
	start: string,
	end: string,
	timing: RowTiming,
	texts: SplitTexts,
): TimelineSpan | string {
	const times = { start: parseTimecode(start), end: parseTimecode(end) };
	if (times.start === null || times.end === null) {
		return 'Enter the start and the end as a timecode, for example 1:23 or 1:23.5.';
	}
	const read = { start: times.start, end: times.end };
	return splitTimesProblem(read, timing, texts) ?? read;
}

/**
 * Why the times cannot split this line, or null when they can. The part before
 * the selection has to keep some time, as has the part after it when the
 * line's end is known; the selection itself has to run forward.
 * @param times - Where the selection is said to be spoken
 * @param timing - Where the line sits
 * @param texts - The line cut at the selection
 */
export function splitTimesProblem(
	times: TimelineSpan,
	timing: RowTiming,
	texts: SplitTexts,
): string | null {
	const { start, end } = times;
	if (end <= start) {
		return 'The end of the selection has to come after its start.';
	}
	if (texts.before && start <= timing.start) {
		return `The selection has to start after the line does, at ${formatLineTime(timing.start)}.`;
	}
	if (texts.after && timing.end !== null && end >= timing.end) {
		return `The selection has to end before the line does, at ${formatLineTime(timing.end)}.`;
	}
	return null;
}

/** The speakers the parts of a split line are shown under. */
export interface SplitPieceSpeakers {
	/** Speaker the line showed, which the text before the selection keeps. */
	row: string | undefined;
	/** Speaker of the selection. */
	selected: string | undefined;
	/** Speaker of the text after the selection. */
	after: string | undefined;
}

/**
 * Where the text after the selection is spoken: from the selection's end to
 * the line's, or nowhere past the selection when the line's end is unknown.
 * @param timing - Where the line sits
 * @param times - Where the selection is spoken
 */
export function afterSelection(
	timing: RowTiming,
	times: TimelineSpan,
): TimelineSpan {
	return {
		start: times.end,
		end: Math.max(times.end, timing.end ?? times.end),
	};
}

/**
 * Builds the pieces a line splits into, as transcript segments: the text
 * before the selection keeps the line's start and speaker and ends where the
 * selection starts, the selection spans the entered times, and the text after
 * it runs from there to the line's end. Texts are read from the note, so the
 * wikilink escaping the renderer added is taken back off.
 * @param timing - Where the line sits
 * @param texts - The line cut at the selection
 * @param times - Where the selection is spoken
 * @param speakers - Who each part is given to
 */
export function buildSplitPieces(
	timing: RowTiming,
	texts: SplitTexts,
	times: TimelineSpan,
	speakers: SplitPieceSpeakers,
): TranscriptSegment[] {
	const piece = (
		start: number,
		end: number,
		text: string,
		speaker: string | undefined,
	): TranscriptSegment => ({
		start,
		end,
		text: restoreWikilinks(text),
		...(speaker === undefined ? {} : { speaker }),
	});
	const pieces: TranscriptSegment[] = [];
	if (texts.before) {
		pieces.push(
			piece(timing.start, times.start, texts.before, speakers.row),
		);
	}
	pieces.push(
		piece(times.start, times.end, texts.selected, speakers.selected),
	);
	if (texts.after) {
		const after = afterSelection(timing, times);
		pieces.push(piece(after.start, after.end, texts.after, speakers.after));
	}
	return pieces;
}
