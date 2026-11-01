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

import type { App, TFile } from 'obsidian';
import { PLUGIN_LOG_PREFIX } from '../constants';
import { lineTimecodeRef, timecodeLinkBuilder } from '../obsidian/timecodeRefs';
import type { AudioRecorderSettings } from '../settings/settingsSchema';
import type { NoteOutput } from '../sidecar/recordingSidecarModel';
import { noteMarkdownOptions } from '../speakers/transcriptRows';
import {
	MISSING_PARTS_CALLOUT_HEAD,
	overlapsRange,
	type RecordingRange,
} from './partFailure';
import { formatTranscriptMarkdown } from './transcriptFormat';
import type { Transcript } from './TranscriptTypes';

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

/** A Markdown heading line, which ends the section a transcript lies in. */
const HEADING_LINE = /^#{1,6}\s/;

/**
 * The lines of the run's transcript in a note, by their timecode links.
 *
 * A link into the recording does not make a line part of the transcript: the
 * user's own text carries such links through Copy timestamp link, and a
 * translation is inserted below the transcript with the same links, under a
 * heading of its own. So the transcript is the section that opens at the
 * heading the run wrote it under, or at its incomplete-transcription callout,
 * and ends before the next heading. Only a note holding neither is read from
 * its first linked line.
 * @param lines - The note's lines
 * @param secondsOf - Reads a line's timecode into the recording
 * @param heading - The heading the run inserted the transcript under, '' for
 *   none
 * @returns The transcript's lines in note order, empty when none is linked
 */
function transcriptAnchors(
	lines: readonly string[],
	secondsOf: LineSeconds,
	heading: string,
): AnchoredLine[] {
	const anchors = lines.flatMap((line, index) => {
		const seconds = secondsOf(line);
		return seconds === null ? [] : [{ index, seconds }];
	});
	const sectionFrom = (start: number): AnchoredLine[] => {
		const end = lines.findIndex(
			(line, index) => index > start && HEADING_LINE.test(line),
		);
		return anchors.filter(
			(line) => line.index > start && (end === -1 || line.index < end),
		);
	};
	const opener = heading.trim();
	const starts = lines.flatMap((line, index) =>
		(opener !== '' && line.trim() === opener) ||
		line.startsWith(MISSING_PARTS_CALLOUT_HEAD)
			? [index]
			: [],
	);
	if (starts.length === 0) {
		const first = anchors[0];
		return first ? sectionFrom(first.index - 1) : [];
	}
	for (const start of starts) {
		const section = sectionFrom(start);
		if (section.length > 0) {
			return section;
		}
	}
	return [];
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
 * @param heading - The heading the run inserted the transcript under, '' for
 *   none
 * @param fills - What each stretch takes, in any order
 * @param callout - The callout for what is still missing, or null when
 *   nothing is
 * @returns The note's new content, or null when no line of the transcript
 *   carries a timecode into the recording, so nothing can be placed
 */
export function spliceTranscriptNote(
	text: string,
	secondsOf: LineSeconds,
	heading: string,
	fills: readonly NoteStretchFill[],
	callout: string | null,
): string | null {
	const lines = text.split('\n');
	const anchors = transcriptAnchors(lines, secondsOf, heading);
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

/** A note a run inserted the transcript into, as the sidecar recorded it. */
export interface RecordedNote {
	/** The note. */
	file: TFile;
	/** What the sidecar recorded about the insert. */
	output: NoteOutput;
}

/** The notes of a run, split by whether a top-up can write into them. */
export interface RunNotes {
	/** Notes holding lines of the recording, which a top-up fills in. */
	placeable: RecordedNote[];
	/** Notes with no line of the recording left to place by. */
	unplaceable: RecordedNote[];
}

/** What a top-up brought back, as the notes are filled in with it. */
export interface NoteTopUpAnswer {
	/** The segments that came back for the stretches that were sent. */
	recovered: Transcript;
	/** The stretches that were asked for. */
	ranges: readonly RecordingRange[];
	/** The stretches that failed again. */
	failedAgain: readonly RecordingRange[];
	/** The callout for what is still missing, or null when nothing is. */
	callout: string | null;
}

/**
 * Fills in the notes a run inserted a recording's transcript into with what
 * a top-up brought back.
 */
export class TranscriptNoteTopUp {
	/**
	 * @param app - Obsidian App, for reading and writing the notes
	 * @param audio - The recording being topped up
	 * @param settings - Plugin settings, for what a note's record leaves out
	 */
	constructor(
		private readonly app: App,
		private readonly audio: TFile,
		private readonly settings: AudioRecorderSettings,
	) {}

	/**
	 * The notes the run that lost the parts inserted the transcript into.
	 *
	 * A run records its failed parts before its notes, so a note written at
	 * or after that moment is one of its own. A note an older run wrote holds
	 * other text in those stretches, possibly edited since, and is left alone.
	 * @param outputs - The notes the sidecar recorded
	 * @param recordedAt - When the failed parts were recorded
	 * @returns The run's notes, split by whether they can be written into
	 */
	async notesOfRun(
		outputs: readonly NoteOutput[],
		recordedAt: string,
	): Promise<RunNotes> {
		const notes: RunNotes = { placeable: [], unplaceable: [] };
		for (const output of outputs) {
			const file =
				output.writtenAt >= recordedAt
					? this.app.vault.getFileByPath(output.path)
					: null;
			if (!file) {
				continue;
			}
			const text = await this.app.vault.cachedRead(file);
			if (
				transcriptAnchors(
					text.split('\n'),
					this.lineSeconds(file),
					output.heading,
				).length > 0
			) {
				notes.placeable.push({ file, output });
			} else {
				notes.unplaceable.push({ file, output });
			}
		}
		return notes;
	}

	/**
	 * Splices the answer into one note, against the content `vault.process`
	 * supplies, so an edit made while the top-up ran is never written over.
	 * A note that cannot be written is warned about rather than thrown, as
	 * the engine has already been paid for the answer.
	 * @param note - The note
	 * @param answer - What the top-up brought back
	 * @returns Whether the note changed
	 */
	async write(note: RecordedNote, answer: NoteTopUpAnswer): Promise<boolean> {
		const fills = this.fills(note, answer);
		const secondsOf = this.lineSeconds(note.file);
		let changed = false;
		try {
			await this.app.vault.process(note.file, (data) => {
				const spliced = spliceTranscriptNote(
					data,
					secondsOf,
					note.output.heading,
					fills,
					answer.callout,
				);
				changed = spliced !== null && spliced !== data;
				return spliced ?? data;
			});
		} catch (error) {
			console.warn(
				`${PLUGIN_LOG_PREFIX} Failed to top up ${note.file.path}:`,
				error,
			);
			return false;
		}
		return changed;
	}

	/**
	 * Reads the second a line of the note points at in this recording.
	 * @param note - The note the line is in
	 */
	private lineSeconds(note: TFile): LineSeconds {
		return (line) => {
			const ref = lineTimecodeRef(this.app, note, line);
			return ref?.file.path === this.audio.path ? ref.seconds : null;
		};
	}

	/**
	 * Renders what came back for each stretch the way the note's lines were
	 * written. A segment reaching over two stretches is rendered once, in the
	 * first. A stretch that failed again and brought nothing back takes no
	 * fill, so it keeps what it held, as the transcript file keeps it.
	 * @param note - The note
	 * @param answer - What the top-up brought back
	 * @returns What each stretch takes
	 */
	private fills(
		note: RecordedNote,
		answer: NoteTopUpAnswer,
	): NoteStretchFill[] {
		const options = {
			...noteMarkdownOptions(note.output.templates, this.settings),
			// The record keeps no speaker switch, and the run strips the
			// labels when diarization is off, so the current switch decides
			// exactly as it did for the rest of the note.
			includeSpeakers: this.settings.transcriptIncludeSpeakers,
		};
		const links = timecodeLinkBuilder(this.app, this.audio, note.file.path);
		const placed = new Set<object>();
		return [...answer.ranges]
			.sort((a, b) => a.startSeconds - b.startSeconds)
			.flatMap((range) => {
				const segments = answer.recovered.segments.filter(
					(segment) =>
						!placed.has(segment) && overlapsRange(segment, range),
				);
				segments.forEach((segment) => placed.add(segment));
				const failedAgain = answer.failedAgain.some((failed) =>
					overlapsRange(
						{ start: failed.startSeconds, end: failed.endSeconds },
						range,
					),
				);
				if (segments.length === 0 && failedAgain) {
					return [];
				}
				const rows =
					segments.length === 0
						? []
						: formatTranscriptMarkdown(
								{ ...answer.recovered, segments },
								options,
								links,
							).split('\n\n');
				return [{ range, rows }];
			});
	}
}
