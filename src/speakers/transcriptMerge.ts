/**
 * Pure model for merging consecutive rendered transcript lines into one - the
 * reverse of {@link speakers/transcriptSplit}. Diarization sometimes cuts one
 * person's turn into several lines, or hands a stretch of it to another
 * speaker, and the note reads more fragmented than the conversation was; the
 * user selects the lines and they become one line of one speaker.
 *
 * Everything that is not about merging as such is shared with the split in
 * {@link speakers/transcriptRows}: each line's segments are found by
 * {@link locateRowSegments}, the merged line's span is {@link rowTiming} over
 * them, the speaker choices are the same, and the transcript is rewritten by
 * {@link replaceTranscriptRow} with the one merged segment - so the note line
 * and the JSON output are written from the same segment and can never
 * disagree. No DOM or I/O; unit tested directly.
 * @module speakers/transcriptMerge
 */

import { restoreWikilinks } from '../transcription/transcriptFormat';
import type {
	Transcript,
	TranscriptSegment,
} from '../transcription/TranscriptTypes';
import {
	locateRowSegments,
	type LineSpeakerChoice,
	type RowLocation,
	type RowSpan,
	type RowTiming,
} from './transcriptRows';

/**
 * Fewest lines whose merge is asked about first. Two lines are the everyday
 * repair of a turn cut in two; merging more folds several turns - often of
 * several speakers - into one, which is worth a second look.
 */
export const MERGE_CONFIRMATION_MIN_LINES = 3;

/**
 * Whether merging this many lines is asked about before it is written.
 * @param lineCount - How many lines are merged
 */
export function mergeNeedsConfirmation(lineCount: number): boolean {
	return lineCount >= MERGE_CONFIRMATION_MIN_LINES;
}

/**
 * What the confirmation of a merge of several lines says: how many lines
 * become one, whose line it becomes, and what is lost with it.
 * @param lineCount - How many lines are merged
 * @param choice - The speaker picked for the merged line
 */
export function mergeConfirmationMessage(
	lineCount: number,
	choice: LineSpeakerChoice,
): string {
	const speaker =
		choice.kind === 'none'
			? 'without a speaker'
			: choice.kind === 'new'
				? 'spoken by a new speaker'
				: `spoken by ${choice.name}`;
	return (
		`${String(lineCount)} transcript lines become one line ${speaker}, ` +
		"starting at the first line's time. The speakers and times of the " +
		'other lines are dropped. The note can be undone with the editor, ' +
		'the transcript files cannot.'
	);
}

/**
 * What one line of a selection over several lines is to a merge: a blank
 * line between transcript lines (which the merge removes), a line of the
 * recording's transcript, or anything else - another recording's line, a
 * heading, a remark typed between the lines.
 */
export type SelectedLineKind = 'blank' | 'row' | 'other';

/**
 * Whether the selected lines are consecutive lines of one transcript: two or
 * more of its lines with nothing between them but blank lines, which is how
 * the renderer separates them.
 * @param lines - What each selected line is, in note order
 * @returns Why they cannot be merged, or null when they can
 */
export function mergeSelectionProblem(
	lines: readonly SelectedLineKind[],
): string | null {
	if (lines.includes('other')) {
		return "The selection holds a line that is not a line of this recording's transcript, so the lines are not consecutive. Select consecutive lines of one transcript.";
	}
	if (lines.filter((line) => line === 'row').length < 2) {
		return 'Select at least two consecutive transcript lines to merge.';
	}
	return null;
}

/**
 * Finds the segments behind consecutive note lines: each line's own run of
 * segments, and only when every line is found and each run starts right after
 * the one before it. A gap - segments no selected line shows, as after a line
 * was deleted by hand - means the note no longer tells which segments the
 * merge covers, and merging across it would fold an unseen turn in.
 * @param transcript - The transcript the lines were rendered from
 * @param rows - What identifies each line, in note order
 * @returns The segments from the first line's first to the last line's last,
 *   or null when they are not one unbroken run
 */
export function locateMergedSegments(
	transcript: Transcript,
	rows: readonly RowLocation[],
): RowSpan | null {
	const spans: RowSpan[] = [];
	for (const row of rows) {
		const span = locateRowSegments(transcript, row);
		const previous = spans[spans.length - 1];
		if (!span || (previous && span.first !== previous.last + 1)) {
			return null;
		}
		spans.push(span);
	}
	const first = spans[0];
	const last = spans[spans.length - 1];
	return first && last ? { first: first.first, last: last.last } : null;
}

/**
 * The spoken text of the merged line: each line's text in note order, joined
 * the way the renderer joins the segments of one speaker's turn.
 * @param texts - Each line's spoken text as the note shows it
 */
export function mergedLineText(texts: readonly string[]): string {
	return texts
		.map((text) => text.trim())
		.filter((text) => text.length > 0)
		.join(' ');
}

/**
 * The span the merged line plays over: the merged lines' timing, ending where
 * it starts when the last line's end is unknown.
 * @param timing - Where the merged lines sit
 */
export function mergedSpan(timing: RowTiming): { start: number; end: number } {
	return { start: timing.start, end: timing.end ?? timing.start };
}

/**
 * Builds the one segment the lines are merged into: the merged lines' span,
 * their joined text (with the wikilink escaping the renderer added taken back
 * off, since it is read from the note), and the speaker picked for it.
 * @param timing - Where the merged lines sit
 * @param texts - Each line's spoken text as the note shows it
 * @param speaker - Speaker of the merged line, if any
 */
export function buildMergedSegment(
	timing: RowTiming,
	texts: readonly string[],
	speaker: string | undefined,
): TranscriptSegment {
	const { start, end } = mergedSpan(timing);
	return {
		start,
		end,
		text: restoreWikilinks(mergedLineText(texts)),
		...(speaker === undefined ? {} : { speaker }),
	};
}
