/**
 * Lookup of the open MarkdownView showing a given note, and of the editor a
 * note can be written through. Transcript output, the note inserter and
 * profile notes all write to or read from one specific note, never whatever
 * happens to be active, so they share this one lookup rather than each
 * scanning the workspace leaves.
 *
 * This module is the only place that reads `MarkdownView.editor`. A Markdown
 * view keeps its editor in Reading view, where it is hidden: a write to it
 * raises no error and never reaches the note, and its cursor is one the user
 * cannot see. So the editor is handed out only for a view in editing mode,
 * and a caller that gets none writes the note through the vault instead. The
 * `local/no-markdown-view-editor` lint rule keeps every other module to that.
 * @module utils/noteViews
 */

import { MarkdownView } from 'obsidian';
import type { App, Editor, TFile } from 'obsidian';

/**
 * The editor of a view the user is editing in, or null in Reading view,
 * whose hidden editor takes a write without the note ever receiving it.
 * @param view - The Markdown view
 * @returns Its editor when the view is in editing mode
 */
export function editorOf(view: MarkdownView): Editor | null {
	return view.getMode() === 'source' ? view.editor : null;
}

/**
 * The open Markdown views showing a note, in pane order.
 * @param app - Obsidian App
 * @param notePath - Vault path of the note
 */
function noteViews(app: App, notePath: string): MarkdownView[] {
	if (!notePath) {
		return [];
	}
	return app.workspace
		.getLeavesOfType('markdown')
		.map((leaf) => leaf.view)
		.filter(
			(candidate): candidate is MarkdownView =>
				candidate instanceof MarkdownView &&
				candidate.file?.path === notePath,
		);
}

/**
 * Finds the open Markdown view for a specific note path, in either view
 * mode, or null when that note is not open in a Markdown leaf. For reading
 * what the view holds; a write goes through {@link findNoteEditor}.
 * @param app - Obsidian App
 * @param notePath - Vault path of the target note
 * @returns The view showing the note, or null when it is not open
 */
export function findNoteView(app: App, notePath: string): MarkdownView | null {
	return noteViews(app, notePath)[0] ?? null;
}

/**
 * Finds the editor a specific note is being edited in, or null when the note
 * is not open or is open in Reading view only; the note is then written
 * through the vault. Targets the note the caller captured - not whatever
 * happens to be active when an async run finishes - so output never lands in
 * an unrelated file the user switched to mid-run. A note open in two panes
 * answers with the one in editing mode.
 * @param app - Obsidian App
 * @param notePath - Vault path of the target note
 * @returns The editor holding the note, or null when none is editing it
 */
export function findNoteEditor(app: App, notePath: string): Editor | null {
	for (const view of noteViews(app, notePath)) {
		const editor = editorOf(view);
		if (editor) {
			return editor;
		}
	}
	return null;
}

/** The active note, and its editor when it is being edited. */
export interface ActiveNote {
	/** The view showing it. */
	view: MarkdownView;
	/** The note, or null for a view that holds no file yet. */
	file: TFile | null;
	/** Its editor, or null in Reading view, which has no cursor to act at. */
	editor: Editor | null;
}

/**
 * The active Markdown note and the editor it is being edited in.
 * @param app - Obsidian App
 * @returns The note, or null when the active view is not a Markdown one
 */
export function activeNote(app: App): ActiveNote | null {
	const view = app.workspace.getActiveViewOfType(MarkdownView);
	return view ? { view, file: view.file, editor: editorOf(view) } : null;
}
