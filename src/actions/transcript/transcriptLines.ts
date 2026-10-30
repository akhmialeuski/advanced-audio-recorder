/**
 * The two places a transcript line edit reads and writes a note's lines:
 * the open editor, where a selection is made with the mouse, and the note
 * file, where the command line names the lines by number. Both refuse to
 * write over lines that no longer read as they did when the edit was
 * prepared, so an edit can never land on lines that moved under it.
 * @module actions/transcript/transcriptLines
 */

import type { App, Editor, TFile } from 'obsidian';
import type { TranscriptLines } from '../core/PluginAction';

/**
 * The lines of an open editor. Written through the editor, so an edit made
 * from a dialog is undone with the editor's own undo.
 * @param editor - The editor holding the note
 */
export function editorLines(
	editor: Pick<Editor, 'getLine' | 'lineCount' | 'replaceRange'>,
): TranscriptLines {
	return {
		getLine: (line) => editor.getLine(line),
		lineCount: () => editor.lineCount(),
		replaceLines: (first, expected, text) => {
			if (
				expected.some(
					(line, index) => editor.getLine(first + index) !== line,
				)
			) {
				return Promise.resolve(false);
			}
			const last = first + expected.length - 1;
			editor.replaceRange(
				text,
				{ line: first, ch: 0 },
				{ line: last, ch: editor.getLine(last).length },
			);
			return Promise.resolve(true);
		},
	};
}

/**
 * The line break a note uses: Windows line ends are kept as they are, so an
 * edit does not rewrite every line of a note written on another system.
 * @param content - The note
 */
const lineBreakOf = (content: string): string =>
	content.includes('\r\n') ? '\r\n' : '\n';

/**
 * The lines of a note as the file holds them, read once. Written through the
 * vault in one atomic step that checks the lines first against the file as it
 * is at that moment, not as it was read.
 * @param app - Obsidian App
 * @param note - The note
 * @param content - The note's text, as read
 */
export function noteLines(
	app: App,
	note: TFile,
	content: string,
): TranscriptLines {
	const lines = content.split(/\r?\n/);
	return {
		getLine: (line) => lines[line] ?? '',
		lineCount: () => lines.length,
		replaceLines: async (first, expected, text) => {
			let replaced = false;
			await app.vault.process(note, (current) => {
				const now = current.split(/\r?\n/);
				if (
					expected.some((line, index) => now[first + index] !== line)
				) {
					return current;
				}
				const lineBreak = lineBreakOf(current);
				now.splice(first, expected.length, ...text.split(/\r?\n/));
				replaced = true;
				return now.join(lineBreak);
			});
			return replaced;
		},
	};
}
