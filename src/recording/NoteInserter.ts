/**
 * Note link insertion utilities for the recording pipeline.
 * Handles capturing cursor context and inserting audio file links
 * into Obsidian notes.
 * @module recording/NoteInserter
 */

import { MarkdownView, TFile, getLinkpath } from 'obsidian';
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
 * @returns The path of the note the links were inserted into, or null when
 *          no editable note was available to receive them
 */
export function insertFileLinks(
	fileLinks: string[],
	insertionContext: InsertionContext | null,
	app: App,
): string | null {
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
			return leafView.file?.path ?? insertionContext.filePath;
		}
	}

	// Fallback: insert into the currently active note
	const activeView = app.workspace.getActiveViewOfType(MarkdownView);
	const editor = activeView?.editor;
	if (editor) {
		editor.replaceSelection(links);
		return activeView?.file?.path ?? null;
	}
	return null;
}

/**
 * Links a processed (cleaned/converted) audio file into the note that embeds
 * the source, mirroring how a freshly recorded file is linked. When the source
 * is being removed its embed is replaced (so no broken link is left behind);
 * otherwise the new embed is inserted on the line right after it, keeping both.
 * Edits the note content atomically via `vault.process`, matching the source
 * embed by its exact original text, so a stale cursor or offset cannot misplace
 * the insert. Returns the note path the embed landed in, or null when the active
 * note does not embed the source (e.g. cleanup invoked from the file explorer),
 * so the caller can skip the enhanced-player priming.
 * @param app - Obsidian App instance
 * @param sourceFile - The original audio file that was processed
 * @param processedPath - Vault path of the processed output
 * @param replaceSource - Replace the source embed instead of inserting after it
 * @returns The note path the embed was inserted into, or null when none matched
 */
export async function insertProcessedAudioEmbed(
	app: App,
	sourceFile: TFile,
	processedPath: string,
	replaceSource: boolean,
): Promise<string | null> {
	const note = app.workspace.getActiveFile();
	if (!note || note.extension !== 'md') {
		return null;
	}
	const embeds = app.metadataCache.getFileCache(note)?.embeds ?? [];
	const target = embeds.find(
		(embed) =>
			app.metadataCache.getFirstLinkpathDest(
				getLinkpath(embed.link),
				note.path,
			)?.path === sourceFile.path,
	);
	if (!target) {
		return null;
	}
	const processedFile = app.vault.getAbstractFileByPath(processedPath);
	const link =
		processedFile instanceof TFile
			? app.fileManager.generateMarkdownLink(processedFile, note.path)
			: `[[${processedPath.split('/').pop() ?? processedPath}]]`;
	const newEmbed = `!${link}`;
	const original = target.original;
	await app.vault.process(note, (content) =>
		content.replace(
			original,
			replaceSource ? newEmbed : `${original}\n${newEmbed}`,
		),
	);
	return note.path;
}
