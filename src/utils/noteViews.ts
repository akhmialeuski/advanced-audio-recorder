/**
 * Lookup of the open MarkdownView showing a given note. Transcript output,
 * the note inserter and profile notes all write to or read from one specific
 * note, never whatever happens to be active, so they share this one lookup
 * rather than each scanning the workspace leaves.
 * @module utils/noteViews
 */

import { MarkdownView } from 'obsidian';
import type { App } from 'obsidian';

/**
 * Finds the open, editable Markdown view for a specific note path, or null
 * when that note is not open in a Markdown leaf. Targets the note the
 * caller captured - not whatever happens to be active when an async run
 * finishes - so output never lands in an unrelated file the user switched to
 * mid-run. A profile note is read through it too, since its editor holds text
 * not yet saved to disk.
 * @param app - Obsidian App
 * @param notePath - Vault path of the target note
 * @returns The view showing the note, or null when it is not open
 */
export function findNoteView(app: App, notePath: string): MarkdownView | null {
	if (!notePath) {
		return null;
	}
	const view = app.workspace
		.getLeavesOfType('markdown')
		.map((leaf) => leaf.view)
		.find(
			(candidate): candidate is MarkdownView =>
				candidate instanceof MarkdownView &&
				candidate.file?.path === notePath,
		);
	return view ?? null;
}
