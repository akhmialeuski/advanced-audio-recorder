/**
 * Splices what a top-up brought back into a transcript a run inserted into a
 * note, placing each stretch by the timecode links the note's lines open with.
 *
 * The note is the only copy of a transcript inserted there, and the user may
 * have edited it or an LLM pass may have rewritten it since, so it is changed
 * line by line rather than rendered again: only the lines whose timecode lies
 * inside a stretch that was asked for are replaced, and every other line,
 * the user's own text included, is left exactly as it was.
 * @module transcription/noteTopUp
 */

import { MISSING_PARTS_CALLOUT_HEAD, type RecordingRange } from './partFailure';

/** What one stretch of a top-up puts into the note. */
export interface NoteStretchFill {
	/** The stretch that was asked for. */
	range: RecordingRange;
	/** The lines that came back for it, rendered; empty when none did. */
	rows: readonly string[];
}

/**
 * Reads the second a note line's timecode link points at in the recording,
 * or null for a line that carries no link into it.
 */
export type LineSeconds = (line: string) => number | null;

/** A line of the recording's transcript in the note. */
interface AnchoredLine {
	/** Zero-based line index. */
	index: number;
	/** The whole second its timecode link points at. */
	seconds: number;
}

/**
 * Whether a line belongs to a stretch. A timecode link carries whole seconds
 * while the parts are cut at fractions of one, so a line in the second a
 * stretch starts or ends in may belong to the neighbouring part. Such a line
 * is kept: replacing it would delete text a neighbour was billed for, while a
 * line doubled at the seam is visible and edited away by hand.
 * @param line - The line
 * @param range - The stretch
 */
function liesInside(line: AnchoredLine, range: RecordingRange): boolean {
	return (
		line.seconds >= range.startSeconds &&
		line.seconds + 1 <= range.endSeconds
	);
}

/**
 * Where the incomplete-transcription callout of this transcript sits: the
 * quoted block that ends right above its first line, blank lines aside, and
 * opens with the callout head. A callout anywhere else belongs to another
 * transcript, or is the user's own, and is never touched.
 * @param lines - The note's lines
 * @param firstLine - Index of the transcript's first line
 * @returns The callout's first index and the index past its end, or null
 */
function findCallout(
	lines: readonly string[],
	firstLine: number,
): { from: number; to: number } | null {
	let to = firstLine;
	while (to > 0 && lines[to - 1]?.trim() === '') {
		to--;
	}
	let from = to;
	while (from > 0 && lines[from - 1]?.startsWith('>')) {
		from--;
	}
	return from < to && lines[from]?.startsWith(MISSING_PARTS_CALLOUT_HEAD)
		? { from, to }
		: null;
}

/**
 * Replaces the stretches a top-up asked for in a note's transcript with what
 * came back for them, and brings the incomplete-transcription callout up to
 * date.
 *
 * A stretch's lines are replaced where they stood. A stretch with no line
 * left in the note takes its lines right above the first line after it, so
 * whatever the user wrote below the line before the gap stays with that line,
 * or right below the transcript's last line when the gap is its end.
 *
 * The callout is rewritten with what is still missing, and removed once
 * nothing is. A note whose callout was deleted is not given one back.
 * @param text - The note's content
 * @param secondsOf - Reads a line's timecode into the recording
 * @param fills - What each stretch takes, in any order
 * @param callout - The callout for what is still missing, or null when
 *   nothing is
 * @returns The note's new content, or null when no line of the note carries
 *   a timecode into the recording, so nothing can be placed
 */
export function spliceTranscriptNote(
	text: string,
	secondsOf: LineSeconds,
	fills: readonly NoteStretchFill[],
	callout: string | null,
): string | null {
	const lines = text.split('\n');
	const anchors: AnchoredLine[] = [];
	lines.forEach((line, index) => {
		const seconds = secondsOf(line);
		if (seconds !== null) {
			anchors.push({ index, seconds });
		}
	});
	const first = anchors[0];
	const last = anchors.at(-1);
	if (!first || !last) {
		return null;
	}
	const removed = new Set<number>();
	// Rows inserted before the original line of the key; the line count as a
	// key appends after the note's end.
	const inserted = new Map<number, string[]>();
	const insert = (before: number, rows: readonly string[]): void => {
		inserted.set(before, [...(inserted.get(before) ?? []), ...rows]);
	};
	// A rendered line is followed by a blank one, so the blank line goes with
	// it and a replaced stretch leaves no double gap behind.
	const remove = (index: number): void => {
		removed.add(index);
		if (lines[index + 1]?.trim() === '') {
			removed.add(index + 1);
		}
	};

	const warning = findCallout(lines, first.index);
	if (warning) {
		for (let index = warning.from; index < warning.to; index++) {
			removed.add(index);
		}
		if (callout === null) {
			remove(warning.to - 1);
		} else {
			insert(warning.from, callout.trimEnd().split('\n'));
		}
	}

	const ordered = [...fills].sort(
		(a, b) => a.range.startSeconds - b.range.startSeconds,
	);
	for (const { range, rows } of ordered) {
		const inside = anchors.filter((line) => liesInside(line, range));
		inside.forEach((line) => remove(line.index));
		const next =
			inside[0] ??
			anchors.find((line) => line.seconds >= range.startSeconds);
		if (next) {
			insert(
				next.index,
				rows.flatMap((row) => [row, '']),
			);
		} else {
			insert(
				last.index + 1,
				rows.flatMap((row) => ['', row]),
			);
		}
	}

	const result: string[] = [];
	lines.forEach((line, index) => {
		result.push(...(inserted.get(index) ?? []));
		if (!removed.has(index)) {
			result.push(line);
		}
	});
	result.push(...(inserted.get(lines.length) ?? []));
	return result.join('\n');
}
