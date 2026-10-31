/**
 * The two edits of rendered transcript lines, from what the selection is to
 * what is written: the split of one line between speakers, and the merge of
 * consecutive lines into one. The split and merge dialogs are forms over
 * these, and the command line passes their choices as parameters; both run
 * exactly this, so an edit made either way reads the line, writes the note,
 * and rewrites the transcript files the same way.
 *
 * The note is written through the selection's {@link TranscriptLines}: the
 * open editor for the dialogs, so the edit is undone like any other, and the
 * note file for the command line, which has no editor to go through.
 * @module speakers/transcriptLineEdits
 */

import type { App } from 'obsidian';
import { lineTimecodeRef, timecodeLinkBuilder } from '../obsidian/timecodeRefs';
import {
	applyTranscriptEdit,
	describeTranscriptMerge,
	describeTranscriptSplit,
} from './applyTranscriptEdit';
import {
	buildMergedSegment,
	locateMergedSegments,
	mergedSpan,
	mergeSelectionProblem,
	type SelectedLineKind,
} from './transcriptMerge';
import {
	lineSpeakerOptions,
	locateRowSegments,
	NO_SPEAKER_OPTION,
	resolveLineSpeakers,
	rowTiming,
	speakerValue,
	type LineSpeakerChoice,
	type LineSpeakerOption,
	type LineSpeakerRequest,
	type LineSpeakerSources,
	type RowSpan,
	type RowTiming,
} from './transcriptRows';
import {
	afterSelection,
	buildSplitPieces,
	estimateSplitTimes,
	readSplitTimes,
	splitLineText,
	type SplitTexts,
} from './transcriptSplit';
import type { TranscriptLineSelection } from './transcriptLineSelection';
import type { TranscriptSegment } from '../transcription/TranscriptTypes';
import {
	formatTranscriptMarkdown,
	restoreWikilinks,
} from '../transcription/transcriptFormat';
import {
	nextLineSeconds,
	readTranscriptLine,
	readTranscriptSource,
	recordingDuration,
	speakerSources,
	type ReadLine,
	type TranscriptEditServices,
	type TranscriptSource,
} from './transcriptLineSource';
import { isRefusal, valueOrThrow, type Refusable } from '../utils/refusal';

/** Everything read and worked out before a split can be offered. */
export interface PreparedSplit {
	/** What the recording's sidecar and JSON transcript say. */
	source: TranscriptSource;
	/** The line's segments in the JSON transcript, when they were found. */
	span: RowSpan | null;
	/** The line's text cut at the selection. */
	texts: SplitTexts;
	/** Where the line sits on the timeline. */
	timing: RowTiming;
	/** Speaker the line shows. */
	rowSpeaker: string | undefined;
	/** What is known about the recording's speakers. */
	sources: LineSpeakerSources;
}

/**
 * Reads the recording's sidecar and JSON transcript, reads the line back
 * with the note's templates, cuts it at the selection, finds its segments in
 * the JSON transcript and works out where it sits.
 * @param app - Obsidian App
 * @param options - The edit's collaborators
 * @param context - The selection
 * @returns What the split works from, or why the selection cannot be split
 */
export async function prepareSplit(
	app: App,
	options: TranscriptEditServices,
	context: TranscriptLineSelection,
): Promise<Refusable<PreparedSplit>> {
	const { lines, note, audio, line, lineText, from, to, seconds } = context;
	const read = await readTranscriptSource(app, options, note, audio);
	if (isRefusal(read)) {
		return read;
	}
	const source = read.value;
	const row = readTranscriptLine(source, lineText);
	if (!row) {
		return {
			refusal:
				'This line does not have the shape the transcript of this recording was written in, so it cannot be split. Select text inside a transcript line.',
		};
	}
	const texts = splitLineText(lineText, row.parsed, from, to);
	if (!texts) {
		return {
			refusal:
				'The selection holds none of the spoken text of the line. Select the words that belong to another speaker.',
		};
	}
	const nextSeconds = nextLineSeconds(app, lines, note, audio, line);
	const { recorded } = source;
	const span = recorded
		? locateRowSegments(recorded.transcript, {
				seconds,
				speaker: row.speaker,
				nextSeconds,
				merge: source.options.mergeConsecutiveSpeaker,
				text: restoreWikilinks(row.text),
			})
		: null;
	const timing: RowTiming =
		recorded && span
			? rowTiming(recorded.transcript, span)
			: {
					start: seconds,
					end:
						nextSeconds ??
						(await recordingDuration(app, options, audio)),
				};
	return {
		value: {
			source,
			span,
			texts,
			timing,
			rowSpeaker: row.speaker,
			sources: speakerSources(source, [row.speaker]),
		},
	};
}

/** What a split is made with, as the dialog starts on it. */
export interface SplitDefaults {
	/** The speakers the selection can be given. */
	options: LineSpeakerOption[];
	/** The speakers the rest of the line can be given; null when there is none. */
	afterOptions: LineSpeakerOption[] | null;
	/** The option the selection starts on: another speaker of the line, or new. */
	selected: string;
	/** The option the rest starts on: the line's own speaker. */
	after: string;
	/** Where the selection is estimated to start and end. */
	times: { start: number; end: number };
}

/**
 * The choices a split starts on: the selection goes to the first other
 * speaker the recording shows (a new one when there is none), the rest of the
 * line stays with its own speaker, and the times are estimated from the word
 * timings, or from the text's share of the line.
 * @param prepared - What the split works from
 */
export function splitDefaults(prepared: PreparedSplit): SplitDefaults {
	const { rowSpeaker, texts } = prepared;
	const options = lineSpeakerOptions(prepared.sources);
	const other = options.find(
		(option) =>
			option.choice.kind === 'existing' &&
			option.choice.name !== rowSpeaker,
	);
	return {
		options,
		afterOptions: texts.after
			? rowSpeaker === undefined
				? [NO_SPEAKER_OPTION, ...options]
				: [...options]
			: null,
		selected: other?.value ?? 'new',
		after: speakerValue(rowSpeaker),
		times: estimateSplitTimes(prepared.timing, texts),
	};
}

/** What a split was asked to do. */
export interface SplitChoices {
	/** Who the selected words belong to. */
	selected: LineSpeakerChoice;
	/** Who the rest of the line belongs to; ignored when there is no rest. */
	after: LineSpeakerChoice;
	/** Where the selection starts, as typed. */
	start: string;
	/** Where the selection ends, as typed. */
	end: string;
}

/**
 * Renders segments as the note's transcript lines for this recording.
 * @param app - Obsidian App
 * @param context - The selection
 * @param source - The templates the note was written with
 * @param segments - The segments to render
 */
function renderLines(
	app: App,
	context: TranscriptLineSelection,
	source: TranscriptSource,
	segments: TranscriptSegment[],
): string {
	return formatTranscriptMarkdown(
		{ segments, speakers: [] },
		source.options,
		timecodeLinkBuilder(app, context.audio, context.note.path),
	);
}

/**
 * Splits the line: reads the transcript and the roster again, validates the
 * times, resolves the speakers, replaces the line with its pieces, then
 * writes the transcript files and the roster. What a form was built from is
 * not written back: a background run may have rewritten the transcript or the
 * roster since, and the old copy would undo it in every file.
 * @param app - Obsidian App
 * @param options - The edit's collaborators
 * @param context - The selection
 * @param choices - Who and when
 * @param changed - What to say when the line no longer reads as selected
 * @returns What was done, in one sentence
 * @throws With the reason, when the split cannot be made
 */
export async function performSplit(
	app: App,
	options: TranscriptEditServices,
	context: TranscriptLineSelection,
	choices: SplitChoices,
	changed: string,
): Promise<string> {
	const prepared = valueOrThrow(await prepareSplit(app, options, context));
	const { texts, timing, source } = prepared;
	const times = valueOrThrow(
		readSplitTimes(choices.start, choices.end, timing, texts),
	);
	const requests: LineSpeakerRequest[] = [
		{ choice: choices.selected, times },
	];
	if (texts.after) {
		requests.push({
			choice: choices.after,
			times: afterSelection(timing, times),
		});
	}
	const { names, added } = resolveLineSpeakers(prepared.sources, requests);
	const pieces = buildSplitPieces(timing, texts, times, {
		row: prepared.rowSpeaker,
		selected: names[0],
		after: names[1],
	});
	if (
		!(await context.lines.replaceLines(
			context.line,
			[context.lineText],
			renderLines(app, context, source, pieces),
		))
	) {
		throw new Error(changed);
	}
	const outcome = await applyTranscriptEdit(app, options.sidecar, {
		audioPath: context.audio.path,
		section: source.section,
		recorded: source.recorded,
		span: prepared.span,
		pieces,
		added,
	});
	return describeTranscriptSplit(
		outcome,
		options.getSettings().transcriptionSpeakerRenameEnabled,
	);
}

/** One selected transcript line, read back. */
export interface MergedRow extends ReadLine {
	/** Whole seconds the line's timecode link points at. */
	seconds: number;
}

/** Everything read and worked out before a merge can be offered. */
export interface PreparedMerge {
	/** What the recording's sidecar and JSON transcript say. */
	source: TranscriptSource;
	/** The selected transcript lines, in note order. */
	rows: MergedRow[];
	/** The lines' segments in the JSON transcript, when they were found. */
	span: RowSpan | null;
	/** Where the merged lines sit on the timeline. */
	timing: RowTiming;
	/** What is known about the recording's speakers. */
	sources: LineSpeakerSources;
}

/**
 * Reads the recording's sidecar and JSON transcript, reads every selected
 * line back with the note's templates, checks that they are consecutive
 * lines of this recording, finds their segments in the JSON transcript and
 * works out where they sit.
 * @param app - Obsidian App
 * @param options - The edit's collaborators
 * @param context - The selection
 * @returns What the merge works from, or why the lines cannot be merged
 */
export async function prepareMerge(
	app: App,
	options: TranscriptEditServices,
	context: TranscriptLineSelection,
): Promise<Refusable<PreparedMerge>> {
	const { lines, note, audio, lastLine, lineTexts } = context;
	const read = await readTranscriptSource(app, options, note, audio);
	if (isRefusal(read)) {
		return read;
	}
	const source = read.value;
	const kinds: SelectedLineKind[] = [];
	const rows: MergedRow[] = [];
	for (const text of lineTexts) {
		if (text.trim().length === 0) {
			kinds.push('blank');
			continue;
		}
		const ref = lineTimecodeRef(app, note, text);
		const row =
			ref?.file.path === audio.path
				? readTranscriptLine(source, text)
				: null;
		if (!ref || !row) {
			kinds.push('other');
			continue;
		}
		kinds.push('row');
		rows.push({ ...row, seconds: ref.seconds });
	}
	const problem = mergeSelectionProblem(kinds);
	if (problem) {
		return { refusal: problem };
	}
	const lastNext = nextLineSeconds(app, lines, note, audio, lastLine);
	const { recorded } = source;
	const span = recorded
		? locateMergedSegments(
				recorded.transcript,
				rows.map((row, index) => ({
					seconds: row.seconds,
					speaker: row.speaker,
					nextSeconds: rows[index + 1]?.seconds ?? lastNext,
					merge: source.options.mergeConsecutiveSpeaker,
					text: restoreWikilinks(row.text),
				})),
			)
		: null;
	const timing: RowTiming =
		recorded && span
			? rowTiming(recorded.transcript, span)
			: {
					// The first selected line is the one the selection was
					// resolved through, so its link is this one.
					start: context.seconds,
					end:
						lastNext ??
						(await recordingDuration(app, options, audio)),
				};
	return {
		value: {
			source,
			rows,
			span,
			timing,
			sources: speakerSources(
				source,
				rows.map((row) => row.speaker),
			),
		},
	};
}

/**
 * The speakers a merged line can be given: every speaker the recording
 * shows, and no speaker when one of the lines shows none.
 * @param prepared - What the merge works from
 */
export function mergeSpeakerOptions(
	prepared: PreparedMerge,
): LineSpeakerOption[] {
	const options = lineSpeakerOptions(prepared.sources);
	return prepared.rows.some((row) => row.speaker === undefined)
		? [NO_SPEAKER_OPTION, ...options]
		: options;
}

/**
 * Merges the lines: reads the transcript and the roster again, resolves the
 * speaker, replaces the lines with the merged one, then writes the transcript
 * files and the roster.
 * @param app - Obsidian App
 * @param options - The edit's collaborators
 * @param context - The selection
 * @param choice - Who the merged line belongs to
 * @param changed - What to say when the lines no longer read as selected
 * @returns What was done, in one sentence
 * @throws With the reason, when the merge cannot be made
 */
export async function performMerge(
	app: App,
	options: TranscriptEditServices,
	context: TranscriptLineSelection,
	choice: LineSpeakerChoice,
	changed: string,
): Promise<string> {
	const prepared = valueOrThrow(await prepareMerge(app, options, context));
	const { rows, timing, source } = prepared;
	const { names, added } = resolveLineSpeakers(prepared.sources, [
		{ choice, times: mergedSpan(timing) },
	]);
	const merged = buildMergedSegment(
		timing,
		rows.map((row) => row.text),
		names[0],
	);
	if (
		!(await context.lines.replaceLines(
			context.line,
			context.lineTexts,
			renderLines(app, context, source, [merged]),
		))
	) {
		throw new Error(changed);
	}
	const outcome = await applyTranscriptEdit(app, options.sidecar, {
		audioPath: context.audio.path,
		section: source.section,
		recorded: source.recorded,
		span: prepared.span,
		pieces: [merged],
		added,
	});
	return describeTranscriptMerge(
		rows.length,
		outcome,
		options.getSettings().transcriptionSpeakerRenameEnabled,
	);
}
