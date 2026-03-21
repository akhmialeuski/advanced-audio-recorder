/**
 * Note link insertion utilities for the recording pipeline.
 * Handles capturing cursor context and inserting audio file links
 * into Obsidian notes.
 * @module recording/NoteInserter
 */

import { MarkdownView } from 'obsidian';
import type { App } from 'obsidian';
import type { InsertionContext } from '../types';
import type { DebugLogger } from '../utils/DebugLogger';

/**
 * Captures the active note path and cursor position for later
 * insertion of audio links.
 * @param app - Obsidian App instance
 * @param insertAtOriginalPosition - Whether to capture context
 * @param debugLogger - Logger for debug output
 * @returns Captured insertion context, or null if disabled or unavailable
 */
export function captureInsertionContext(
	app: App,
	insertAtOriginalPosition: boolean,
	debugLogger: DebugLogger,
): InsertionContext | null {
	if (!insertAtOriginalPosition) {
		return null;
	}
	const view = app.workspace.getActiveViewOfType(MarkdownView);
	const filePath = view?.file?.path;
	const cursor = view?.editor?.getCursor();
	if (filePath && cursor) {
		return {
			filePath,
			line: cursor.line,
			ch: cursor.ch,
		};
	}
	debugLogger.log(
		'Could not capture insertion context: no active Markdown view',
	);
	return null;
}

/**
 * Inserts Obsidian embed links for the given file paths into a note.
 * Uses the captured insertion context if available, otherwise falls
 * back to the currently active editor.
 * @param fileLinks - Array of saved file paths
 * @param insertionContext - Previously captured cursor context
 * @param app - Obsidian App instance
 */
export function insertFileLinks(
	fileLinks: string[],
	insertionContext: InsertionContext | null,
	app: App,
): void {
	const links = fileLinks
		.map((path) => {
			const fileName = path.split('/').pop() ?? path;
			return `![[${fileName}]]`;
		})
		.join('\n');

	if (insertionContext) {
		const leaf = app.workspace.getLeavesOfType('markdown').find((l) => {
			const leafView = l.view;
			return (
				leafView instanceof MarkdownView &&
				leafView.file?.path === insertionContext.filePath
			);
		});

		const leafView = leaf?.view;
		if (leafView instanceof MarkdownView) {
			const editor = leafView.editor;
			const pos = {
				line: insertionContext.line + 1,
				ch: 0,
			};
			editor.replaceRange(links + '\n', pos);
			return;
		}
	}

	// Fallback: insert into the currently active note
	const activeView = app.workspace.getActiveViewOfType(MarkdownView);
	const editor = activeView?.editor;
	if (editor) {
		editor.replaceSelection(links);
	}
}
