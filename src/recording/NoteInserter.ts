/**
 * Note link insertion utilities for the recording pipeline.
 * Handles capturing cursor context and inserting audio file links
 * into Obsidian notes.
 * @module recording/NoteInserter
 */

import { MarkdownView, TFile, getLinkpath } from 'obsidian';
import type { App, EmbedCache } from 'obsidian';
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
 * is being removed every one of its embeds is replaced (so no broken link is
 * left behind, even if the note embeds it more than once); otherwise the new
 * embed is inserted on the line right after the first one, keeping both. Edits
 * the note content atomically via `vault.process`, matching the source embeds by
 * their exact original text, so a stale cursor or offset cannot misplace the
 * insert. Returns the note path the embed landed in, or null when the active
 * note does not embed the source (e.g. cleanup invoked from the file explorer),
 * so the caller can skip the enhanced-player priming.
 * @param app - Obsidian App instance
 * @param sourceFile - The original audio file that was processed
 * @param processedPath - Vault path of the processed output
 * @param replaceSource - Replace the source embeds instead of inserting after
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
	const matches = embeds.filter(
		(embed) =>
			app.metadataCache.getFirstLinkpathDest(
				getLinkpath(embed.link),
				note.path,
			)?.path === sourceFile.path,
	);
	if (matches.length === 0) {
		return null;
	}
	const processedFile = app.vault.getAbstractFileByPath(processedPath);
	const link =
		processedFile instanceof TFile
			? app.fileManager.generateMarkdownLink(processedFile, note.path)
			: `[[${processedPath.split('/').pop() ?? processedPath}]]`;
	const newEmbed = `!${link}`;
	await app.vault.process(note, (content) =>
		replaceSource
			? replaceSourceEmbeds(content, matches, newEmbed)
			: insertEmbedAfterSource(content, matches[0].original, newEmbed),
	);
	return note.path;
}

/**
 * Replaces every embed of the source file with the processed embed, so trashing
 * the source afterwards leaves no broken link even when the note embeds it more
 * than once. Uses split/join rather than `String.prototype.replace`, whose
 * string replacement reinterprets `$` substitution patterns such as `$&` and
 * `$$` - a filename or alias containing `$` would otherwise corrupt the
 * rewritten note.
 * @param content - Current note body
 * @param matches - Embeds that resolve to the source file
 * @param newEmbed - The processed file's embed text
 * @returns The note body with every source embed replaced
 */
function replaceSourceEmbeds(
	content: string,
	matches: EmbedCache[],
	newEmbed: string,
): string {
	let next = content;
	// Distinct embed texts only: identical occurrences are all handled by a
	// single split/join, so a duplicate would otherwise replace nothing new.
	for (const original of new Set(matches.map((match) => match.original))) {
		next = next.split(original).join(newEmbed);
	}
	return next;
}

/**
 * Inserts the processed embed on the line right after the first source embed,
 * keeping the source. Plain string slicing avoids the `$` reinterpretation a
 * `String.prototype.replace` string replacement would apply to the embed text.
 * @param content - Current note body
 * @param original - The source embed's exact original text
 * @param newEmbed - The processed file's embed text
 * @returns The note body with the processed embed inserted after the source
 */
function insertEmbedAfterSource(
	content: string,
	original: string,
	newEmbed: string,
): string {
	const index = content.indexOf(original);
	if (index === -1) {
		return content;
	}
	const end = index + original.length;
	return `${content.slice(0, end)}\n${newEmbed}${content.slice(end)}`;
}
