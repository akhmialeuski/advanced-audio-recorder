/**
 * Actions on a selection over rendered transcript lines. They belong to no
 * audio file the user has open - the recording is found through the timecode
 * link the selected line starts with - which is why they are their own list:
 * the editor menu renders it for the selection it was opened on, the palette
 * registers it over the active editor's selection, and the command line takes
 * the lines by number and the selected words as text.
 * @module actions/transcriptActions
 */

import { MarkdownView, TFile } from 'obsidian';
import type { CliData, Editor } from 'obsidian';
import { COMMAND_IDS } from '../constants';
import { lineTimecodeRef } from '../obsidian/timecodeRefs';
import { TranscriptMergeModal } from '../ui/TranscriptMergeModal';
import { TranscriptSplitModal } from '../ui/TranscriptSplitModal';
import {
	pickedChoice,
	speakerValue,
	type TranscriptEditModalOptions,
} from '../ui/transcriptLineDialog';
import {
	mergeSpeakerOptions,
	performMerge,
	performSplit,
	prepareMerge,
	prepareSplit,
	splitDefaults,
} from '../ui/transcriptLineEdits';
import {
	mergeConfirmationMessage,
	mergeNeedsConfirmation,
} from '../speakers/transcriptMerge';
import {
	formatLineTime,
	type LineSpeakerChoice,
	type LineSpeakerOption,
} from '../speakers/transcriptRows';
import { isAudioFile } from '../utils/audioFile';
import { probeMediaDurationSeconds } from '../utils/mediaDuration';
import {
	cliFlag,
	cliNumber,
	cliText,
	flagParam,
	valueParam,
} from '../obsidian/cliArgs';
import type {
	ActionFamily,
	ActionServices,
	TranscriptAction,
	TranscriptSelectionContext,
} from './PluginAction';
import { FILE_TARGET_PARAMS, namedVaultFile } from './recordingTargets';
import { editorLines, noteLines } from './transcriptLines';
import { findNoteView } from '../utils/noteViews';
import { isRefusal, type Refusable } from '../utils/refusal';

/** The lines a selection holds text on, and where it starts and ends. */
interface SelectedLines {
	/** First line holding selected text. */
	line: number;
	/** Last line holding selected text. */
	lastLine: number;
	/** Selection start column on the first line. */
	from: number;
	/** Selection end column on the last line. */
	to: number;
}

/**
 * The lines a selection holds text on. A selection over several lines is
 * trimmed of the lines at either end it holds no text of - it usually starts
 * at the end of the line above, or ends at the start of the line below, when
 * whole lines are selected - so only the lines it actually covers count.
 * @param editor - The editor holding the selection
 * @returns The lines, or null when the selection holds no text, or reaches
 *   over several lines but holds text on only one of them
 */
function selectedLines(editor: Editor): SelectedLines | null {
	const from = editor.getCursor('from');
	const to = editor.getCursor('to');
	if (from.line === to.line && from.ch !== to.ch) {
		return { line: from.line, lastLine: to.line, from: from.ch, to: to.ch };
	}
	const holdsText = (line: number, start: number, end?: number): boolean =>
		editor.getLine(line).slice(start, end).trim().length > 0;
	let line = from.line;
	let start = from.ch;
	while (line < to.line && !holdsText(line, start)) {
		line++;
		start = 0;
	}
	let lastLine = to.line;
	let end = to.ch;
	while (lastLine > line && !holdsText(lastLine, 0, end)) {
		lastLine--;
		end = editor.getLine(lastLine).length;
	}
	return line < lastLine ? { line, lastLine, from: start, to: end } : null;
}

/**
 * The selection context over the given lines, when the first one's timecode
 * link resolves to a recording.
 * @param services - Injected services
 * @param lines - The note's lines
 * @param note - The note
 * @param selected - Which lines, and where the selection starts and ends
 * @returns The context, or null when the first line is not a transcript line
 */
function selectionOver(
	services: ActionServices,
	lines: TranscriptSelectionContext['lines'],
	note: TFile,
	selected: SelectedLines,
): TranscriptSelectionContext | null {
	const lineText = lines.getLine(selected.line);
	const ref = lineTimecodeRef(services.app, note, lineText);
	if (!ref || !isAudioFile(ref.file)) {
		return null;
	}
	const lineTexts: string[] = [];
	for (let line = selected.line; line <= selected.lastLine; line++) {
		lineTexts.push(lines.getLine(line));
	}
	return {
		services,
		lines,
		note,
		audio: ref.file,
		...selected,
		lineText,
		lineTexts,
		seconds: ref.seconds,
	};
}

/**
 * Resolves a selection into the transcript lines it lies over: a non-empty
 * selection inside one line, or over several lines, whose first line's
 * timecode link resolves to a recording. Whether the selection covers spoken
 * text, whether the lines have the shape of transcript lines at all, and
 * whether several lines are consecutive lines of that one recording, needs
 * the templates the recording's sidecar stores, so the action answers that.
 * @param services - Injected services every action shares
 * @param editor - The editor holding the selection
 * @param note - The note the editor shows
 * @returns The context, or null when the selection is not over such lines
 */
export function transcriptSelectionIn(
	services: ActionServices,
	editor: Editor,
	note: TFile,
): TranscriptSelectionContext | null {
	if (!editor.somethingSelected()) {
		return null;
	}
	const selected = selectedLines(editor);
	return selected
		? selectionOver(services, editorLines(editor), note, selected)
		: null;
}

/**
 * Builds the resolver the palette uses for transcript actions: the selection
 * of the active Markdown editor, when it lies in a transcript line.
 * @param services - Injected services every action shares
 * @returns Resolver producing the context, or null when there is none
 */
export function activeTranscriptSelection(
	services: ActionServices,
): () => TranscriptSelectionContext | null {
	return (): TranscriptSelectionContext | null => {
		const view = services.app.workspace.getActiveViewOfType(MarkdownView);
		return view?.file
			? transcriptSelectionIn(services, view.editor, view.file)
			: null;
	};
}

/**
 * The collaborators the edits share, taken from the services every action is
 * given.
 * @param context - The selection an action runs on
 */
function dialogOptions(
	context: TranscriptSelectionContext,
): TranscriptEditModalOptions {
	return {
		getSettings: context.services.getSettings,
		sidecar: context.services.recordingSidecar,
		probeDuration: probeMediaDurationSeconds,
	};
}

/** First line, by its number as an editor shows it. */
export const LINE_PARAM = 'line';
/** Last line of a range, by its number. */
export const TO_PARAM = 'to';
/** The words selected on the line. */
export const TEXT_PARAM = 'text';
/** Who the selected words, or the merged line, belong to. */
export const SPEAKER_PARAM = 'speaker';
/** Who the rest of a split line belongs to. */
export const REST_PARAM = 'rest';
/** Confirms a merge of more than two lines. */
export const CONFIRM_FLAG = 'confirm';

/** What an edit made from the command line says when the lines moved. */
const LINES_CHANGED =
	'The lines changed while the command ran. Run it again on the lines as they are now.';

/**
 * The speaker option a typed name picks: a speaker or participant by name,
 * `new` for a new speaker, `none` for no speaker where that is offered.
 * @param options - The options the dialog would offer
 * @param name - What was typed
 * @returns The choice, or the refusal naming what can be typed
 */
export function speakerChoiceNamed(
	options: readonly LineSpeakerOption[],
	name: string,
): Refusable<LineSpeakerChoice> {
	const wanted = name.toLowerCase();
	const option = options.find((candidate) =>
		candidate.choice.kind === 'existing' ||
		candidate.choice.kind === 'participant'
			? candidate.choice.name.toLowerCase() === wanted
			: candidate.value === wanted,
	);
	if (option) {
		return { value: option.choice };
	}
	const names = options.map((candidate) =>
		candidate.choice.kind === 'existing' ||
		candidate.choice.kind === 'participant'
			? candidate.choice.name
			: candidate.value,
	);
	return {
		refusal: `No speaker "${name}" to choose. Choose one of: ${names.join(', ')}.`,
	};
}

/**
 * The speaker a parameter names, or, when it names none, the one the dialog's
 * dropdown starts on - picked by its value, as the dialog picks it.
 * @param args - The arguments as typed
 * @param param - The parameter
 * @param options - The options the dialog would offer
 * @param startValue - The dropdown value the dialog starts on
 */
function typedSpeaker(
	args: CliData,
	param: string,
	options: readonly LineSpeakerOption[],
	startValue: string,
): Refusable<LineSpeakerChoice> {
	const typed = cliText(args, param);
	return typed === null
		? { value: pickedChoice(startValue) }
		: speakerChoiceNamed(options, typed);
}

/**
 * Splits a line from the command line: the dialog's choices taken as
 * parameters, the dialog's starting values where none is typed.
 * @param context - The line and the words selected on it
 * @param args - The arguments as typed
 * @returns The answer
 */
async function splitFromCli(
	context: TranscriptSelectionContext,
	args: CliData,
): Promise<string> {
	const { app } = context.services;
	const options = dialogOptions(context);
	const prepared = await prepareSplit(app, options, context);
	if (isRefusal(prepared)) {
		return prepared.refusal;
	}
	const defaults = splitDefaults(prepared.value);
	const selected = typedSpeaker(
		args,
		SPEAKER_PARAM,
		defaults.options,
		defaults.selected,
	);
	if (isRefusal(selected)) {
		return selected.refusal;
	}
	// Nothing follows the selection when it runs to the end of the line, and
	// then there is no rest for a speaker to be picked for.
	const after: Refusable<LineSpeakerChoice> = defaults.afterOptions
		? typedSpeaker(args, REST_PARAM, defaults.afterOptions, defaults.after)
		: { value: { kind: 'none' } };
	if (isRefusal(after)) {
		return after.refusal;
	}
	return performSplit(
		app,
		options,
		context,
		{
			selected: selected.value,
			after: after.value,
			start:
				cliText(args, 'start') ?? formatLineTime(defaults.times.start),
			end: cliText(args, 'end') ?? formatLineTime(defaults.times.end),
		},
		LINES_CHANGED,
	);
}

/**
 * Merges lines from the command line, asking for `confirm` where the dialog
 * asks for a confirmation.
 * @param context - The lines
 * @param args - The arguments as typed
 * @returns The answer
 */
async function mergeFromCli(
	context: TranscriptSelectionContext,
	args: CliData,
): Promise<string> {
	const { app } = context.services;
	const options = dialogOptions(context);
	const prepared = await prepareMerge(app, options, context);
	if (isRefusal(prepared)) {
		return prepared.refusal;
	}
	const { rows } = prepared.value;
	const choice = typedSpeaker(
		args,
		SPEAKER_PARAM,
		mergeSpeakerOptions(prepared.value),
		speakerValue(rows[0]?.speaker),
	);
	if (isRefusal(choice)) {
		return choice.refusal;
	}
	if (mergeNeedsConfirmation(rows.length) && !cliFlag(args, CONFIRM_FLAG)) {
		return `${mergeConfirmationMessage(rows.length, choice.value)} Add ${CONFIRM_FLAG} to merge them.`;
	}
	return performMerge(app, options, context, choice.value, LINES_CHANGED);
}

/** Every action on a transcript selection, in menu order. */
export const TRANSCRIPT_ACTIONS: readonly TranscriptAction[] = [
	{
		commandId: COMMAND_IDS.splitTranscriptSelection,
		title: 'Split selection into another speaker',
		icon: 'user-plus',
		isAvailable: ({
			services,
			line,
			lastLine,
		}: TranscriptSelectionContext): boolean =>
			services.getSettings().transcriptionEnabled && line === lastLine,
		run: (context: TranscriptSelectionContext): void => {
			new TranscriptSplitModal(
				context.services.app,
				context,
				dialogOptions(context),
			).open();
		},
		cli: {
			name: 'split-line',
			description:
				'Give words of one transcript line to another speaker, splitting the line.',
			params: {
				[TEXT_PARAM]: valueParam(
					'<words>',
					'The words of the line that belong to someone else. Defaults to the whole line.',
				),
				[SPEAKER_PARAM]: valueParam(
					'<name>|new',
					'Who said them. Defaults to the first other speaker.',
				),
				[REST_PARAM]: valueParam(
					'<name>|new|none',
					'Who said the rest of the line. Defaults to its own speaker; none only for a line that has none.',
				),
				start: valueParam(
					'<m:ss>',
					'Where the words start. Estimated by default.',
				),
				end: valueParam(
					'<m:ss>',
					'Where the words end. Estimated by default.',
				),
			},
			opensDialog: true,
			unavailable: ({ services }): string =>
				services.getSettings().transcriptionEnabled
					? `A split works on one line: leave out ${TO_PARAM}.`
					: 'Transcription is switched off in settings.',
			execute: splitFromCli,
		},
	},
	{
		commandId: COMMAND_IDS.mergeTranscriptLines,
		title: 'Merge selected lines into one',
		icon: 'merge',
		isAvailable: ({
			services,
			line,
			lastLine,
		}: TranscriptSelectionContext): boolean =>
			services.getSettings().transcriptionEnabled && lastLine > line,
		run: (context: TranscriptSelectionContext): void => {
			new TranscriptMergeModal(
				context.services.app,
				context,
				dialogOptions(context),
			).open();
		},
		cli: {
			name: 'merge-lines',
			description:
				'Merge consecutive transcript lines into one line of one speaker.',
			params: {
				[SPEAKER_PARAM]: valueParam(
					'<name>|new|none',
					'Who said the merged line. Defaults to the speaker of the first; none only where a line has none.',
				),
				[CONFIRM_FLAG]: flagParam(
					'Confirm merging more than two lines.',
				),
			},
			opensDialog: true,
			unavailable: ({ services }): string =>
				services.getSettings().transcriptionEnabled
					? `A merge needs two lines or more: name the last one with ${TO_PARAM}=<line>.`
					: 'Transcription is switched off in settings.',
			execute: mergeFromCli,
		},
	},
];

/**
 * The columns of the typed words on a line, which is the selection the
 * dialog would have been opened on.
 * @param lineText - The line
 * @param text - The words typed, or null for the whole line
 * @returns The columns, or the refusal
 */
function columnsOf(
	lineText: string,
	text: string | null,
): Refusable<{ from: number; to: number }> {
	if (text === null) {
		return { value: { from: 0, to: lineText.length } };
	}
	const from = lineText.indexOf(text);
	if (from < 0) {
		return { refusal: `The line does not hold "${text}".` };
	}
	if (lineText.indexOf(text, from + 1) >= 0) {
		return {
			refusal: `"${text}" appears more than once on the line; quote more of it.`,
		};
	}
	return { value: { from, to: from + text.length } };
}

/**
 * The selection the command line names: lines of a note by number, and the
 * words of the first one. The note's lines are read once, here, from its
 * editor where it is open, and written back by the edit only where they
 * still read the same.
 * @param services - Injected services
 * @param args - The arguments as typed
 * @returns The selection, or the refusal
 */
async function namedSelection(
	services: ActionServices,
	args: CliData,
): Promise<Refusable<TranscriptSelectionContext[]>> {
	const { app } = services;
	const named = namedVaultFile(app, args);
	if (isRefusal(named)) {
		return named;
	}
	const note = named.value ?? app.workspace.getActiveFile();
	if (!(note instanceof TFile) || note.extension !== 'md') {
		return {
			refusal:
				'Name the note of the transcript with file=<name> or path=<vault path>, or open it in Obsidian.',
		};
	}
	// An open note is edited where it is open: the line numbers are the ones
	// its editor shows, including what is not saved yet, and the edit can be
	// undone there. A note that is not open is edited on disk.
	const view = findNoteView(app, note.path);
	const lines = view
		? editorLines(view.editor)
		: noteLines(app, note, await app.vault.read(note));
	const range = { min: 1, max: lines.lineCount(), integer: true };
	const first = cliNumber(args, LINE_PARAM, range);
	if (isRefusal(first)) {
		return first;
	}
	if (first.value === null) {
		return {
			refusal: `Name the line with ${LINE_PARAM}=<number>, as the editor numbers it.`,
		};
	}
	const last = cliNumber(args, TO_PARAM, range);
	if (isRefusal(last)) {
		return last;
	}
	const lastLine = (last.value ?? first.value) - 1;
	const line = first.value - 1;
	if (lastLine < line) {
		return { refusal: `${TO_PARAM}= comes before ${LINE_PARAM}=.` };
	}
	const columns =
		lastLine === line
			? columnsOf(lines.getLine(line), cliText(args, TEXT_PARAM))
			: { value: { from: 0, to: lines.getLine(lastLine).length } };
	if (isRefusal(columns)) {
		return columns;
	}
	const context = selectionOver(services, lines, note, {
		line,
		lastLine,
		...columns.value,
	});
	return context
		? { value: [context] }
		: {
				refusal: `Line ${String(first.value)} of ${note.path} carries no timecode link to a recording.`,
			};
}

/**
 * The transcript actions as a family: the palette acts on the active
 * editor's selection, the command line on the lines it names.
 * @param services - Injected services every action shares
 * @returns The family
 */
export function transcriptActionFamily(
	services: ActionServices,
): ActionFamily<TranscriptSelectionContext> {
	const active = activeTranscriptSelection(services);
	return {
		actions: TRANSCRIPT_ACTIONS,
		activeTargets: () => {
			const context = active();
			return context ? [context] : [];
		},
		cliTarget: {
			params: {
				...FILE_TARGET_PARAMS,
				[LINE_PARAM]: valueParam(
					'<number>',
					'The transcript line, numbered as the editor numbers lines.',
				),
				[TO_PARAM]: valueParam(
					'<number>',
					'The last line of a range of lines.',
				),
			},
			resolve: (args) => namedSelection(services, args),
		},
		describe: (context) =>
			`line ${String(context.line + 1)} of ${context.note.path}`,
	};
}
