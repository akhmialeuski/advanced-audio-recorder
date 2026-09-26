/**
 * Actions on a selection over rendered transcript lines. They belong to no
 * audio file the user has open - the recording is found through the timecode
 * link the selected line starts with - which is why they are their own list:
 * the editor menu renders it for the selection it was opened on, and the
 * palette registers it over the active editor's selection.
 * @module actions/transcriptActions
 */

import { MarkdownView } from 'obsidian';
import type { Editor, TFile } from 'obsidian';
import { COMMAND_IDS } from '../constants';
import { lineTimecodeRef } from '../obsidian/timecodeRefs';
import { TranscriptMergeModal } from '../ui/TranscriptMergeModal';
import { TranscriptSplitModal } from '../ui/TranscriptSplitModal';
import type { TranscriptEditModalOptions } from '../ui/transcriptLineDialog';
import { isAudioFile } from '../utils/audioFile';
import { probeMediaDurationSeconds } from '../utils/mediaDuration';
import type {
	ActionServices,
	TranscriptAction,
	TranscriptSelectionContext,
} from './PluginAction';

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
 * Resolves a selection into the transcript lines it lies over: a non-empty
 * selection inside one line, or over several lines, whose first line's
 * timecode link resolves to a recording. Whether the selection covers spoken
 * text, whether the lines have the shape of transcript lines at all, and
 * whether several lines are consecutive lines of that one recording, needs
 * the templates the recording's sidecar stores, so the action's dialog
 * answers that.
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
	if (!selected) {
		return null;
	}
	const lineText = editor.getLine(selected.line);
	const ref = lineTimecodeRef(services.app, note, lineText);
	if (!ref || !isAudioFile(ref.file)) {
		return null;
	}
	const lineTexts: string[] = [];
	for (let line = selected.line; line <= selected.lastLine; line++) {
		lineTexts.push(editor.getLine(line));
	}
	return {
		services,
		editor,
		note,
		audio: ref.file,
		...selected,
		lineText,
		lineTexts,
		seconds: ref.seconds,
	};
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
 * The collaborators the dialogs of the transcript actions share, taken from
 * the services every action is given.
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
	},
];
