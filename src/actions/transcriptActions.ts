/**
 * Actions on a selection inside a rendered transcript line. They belong to no
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
import { TranscriptSplitModal } from '../ui/TranscriptSplitModal';
import { isAudioFile } from '../utils/audioFile';
import { probeMediaDurationSeconds } from '../utils/mediaDuration';
import type {
	ActionServices,
	TranscriptAction,
	TranscriptSelectionContext,
} from './PluginAction';

/**
 * Resolves a selection into the transcript line it lies in: a non-empty
 * selection on a single line whose timecode link resolves to a recording.
 * Whether the selection covers spoken text, and whether the line has the
 * shape of a transcript line at all, needs the templates the recording's
 * sidecar stores, so the action's dialog answers that.
 * @param services - Injected services every action shares
 * @param editor - The editor holding the selection
 * @param note - The note the editor shows
 * @returns The context, or null when the selection is not in such a line
 */
export function transcriptSelectionIn(
	services: ActionServices,
	editor: Editor,
	note: TFile,
): TranscriptSelectionContext | null {
	if (!editor.somethingSelected()) {
		return null;
	}
	const from = editor.getCursor('from');
	const to = editor.getCursor('to');
	if (from.line !== to.line || from.ch === to.ch) {
		return null;
	}
	const lineText = editor.getLine(from.line);
	const ref = lineTimecodeRef(services.app, note, lineText);
	if (!ref || !isAudioFile(ref.file)) {
		return null;
	}
	return {
		services,
		editor,
		note,
		audio: ref.file,
		line: from.line,
		lineText,
		from: from.ch,
		to: to.ch,
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

/** Every action on a transcript selection, in menu order. */
export const TRANSCRIPT_ACTIONS: readonly TranscriptAction[] = [
	{
		commandId: COMMAND_IDS.splitTranscriptSelection,
		title: 'Split selection into another speaker',
		icon: 'user-plus',
		isAvailable: ({ services }: TranscriptSelectionContext): boolean =>
			services.getSettings().transcriptionEnabled,
		run: (context: TranscriptSelectionContext): void => {
			new TranscriptSplitModal(context.services.app, context, {
				getSettings: context.services.getSettings,
				sidecar: context.services.recordingSidecar,
				probeDuration: probeMediaDurationSeconds,
			}).open();
		},
	},
];
