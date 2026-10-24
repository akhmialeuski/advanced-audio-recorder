/**
 * Note link insertion utilities for the recording pipeline.
 * Handles capturing cursor context and inserting audio file links
 * into Obsidian notes.
 * @module recording/NoteInserter
 */

import { MarkdownView, TFile, getLinkpath } from 'obsidian';
import type { App, EmbedCache } from 'obsidian';
import type { InsertionContext } from '../types';
import type { DebugLogSink } from '../utils/DebugLogger';
import { findNoteView } from '../utils/noteViews';

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
	debugLogger: DebugLogSink,
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
 * Builds the embed of a vault file for a note, in the link format the user
 * chose under Files and links. `generateMarkdownLink` decides the format
 * (wikilink or Markdown link), the path it needs to stay unambiguous when
 * two files share a name, and the encoding of a Markdown target; whether it
 * also prefixes the `!` depends on the file type, so its marker is dropped
 * and the embed marker applied here, the way the vault-wide link rewrite
 * does it.
 *
 * A path the vault does not index has no TFile to hand over. Every caller
 * writes the file through the vault before linking it, which indexes it at
 * once, so this is a file removed in between; the embed then names the full
 * vault path, which is the one form that cannot resolve to another file of
 * the same name.
 * @param app - Obsidian App instance
 * @param path - Vault path of the file to embed
 * @param sourcePath - Path of the note the embed is written into
 * @returns The embed, ready to insert
 */
function embedLinkForPath(app: App, path: string, sourcePath: string): string {
	const file = app.vault.getFileByPath(path);
	if (!file) {
		return `![[${path}]]`;
	}
	const link = app.fileManager.generateMarkdownLink(file, sourcePath);
	return `!${link.startsWith('!') ? link.slice(1) : link}`;
}

/**
 * Builds the embeds of the given files for a note, one per line.
 * @param app - Obsidian App instance
 * @param paths - Vault paths of the files to embed
 * @param sourcePath - Path of the note the embeds are written into
 * @returns The embeds joined with newlines
 */
function embedLinksFor(app: App, paths: string[], sourcePath: string): string {
	return paths
		.map((path) => embedLinkForPath(app, path, sourcePath))
		.join('\n');
}

/**
 * Inserts embeds of the given files into a note. Uses the captured
 * insertion context if available, otherwise falls back to the currently
 * active editor. The embeds are built for the note they land in, since a
 * relative or shortest-path link is only correct from there.
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
	if (insertionContext) {
		const leafView = findNoteView(app, insertionContext.filePath);
		if (leafView) {
			const notePath = leafView.file?.path ?? insertionContext.filePath;
			const pos = {
				line: insertionContext.line + 1,
				ch: 0,
			};
			leafView.editor.replaceRange(
				embedLinksFor(app, fileLinks, notePath) + '\n',
				pos,
			);
			return notePath;
		}
	}

	// Fallback: insert into the currently active note
	const activeView = app.workspace.getActiveViewOfType(MarkdownView);
	const editor = activeView?.editor;
	if (editor) {
		const notePath = activeView.file?.path ?? null;
		editor.replaceSelection(embedLinksFor(app, fileLinks, notePath ?? ''));
		return notePath;
	}
	return null;
}

/**
 * Inserts text at the cursor of the active note, for a dictation started where
 * no note was active to anchor it.
 * @param app - Obsidian App instance
 * @param text - The text to insert, verbatim
 * @returns The path of the note the text went into, or null when no note was
 *   open to take it
 */
export function insertTextAtCursor(app: App, text: string): string | null {
	const view = app.workspace.getActiveViewOfType(MarkdownView);
	if (!view) {
		return null;
	}
	view.editor.replaceSelection(text);
	return view.file?.path ?? null;
}

/**
 * The embeds of a file in a note, as the metadata cache reports them: the
 * places a processed copy can take the file's place in.
 * @param app - Obsidian App
 * @param note - The Markdown note
 * @param file - The embedded file
 * @returns The embeds, in the note's order
 */
export function embedsOf(app: App, note: TFile, file: TFile): EmbedCache[] {
	return (app.metadataCache.getFileCache(note)?.embeds ?? []).filter(
		(embed) =>
			app.metadataCache.getFirstLinkpathDest(
				getLinkpath(embed.link),
				note.path,
			)?.path === file.path,
	);
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
 * @param note - The note to link into, when the caller knows which one the
 *   recording was reached through; the active note otherwise
 * @returns The note path the embed was inserted into, or null when none matched
 */
export async function insertProcessedAudioEmbed(
	app: App,
	sourceFile: TFile,
	processedPath: string,
	replaceSource: boolean,
	note: TFile | null = app.workspace.getActiveFile(),
): Promise<string | null> {
	if (!note || note.extension !== 'md') {
		return null;
	}
	const matches = embedsOf(app, note, sourceFile);
	const firstMatch = matches[0];
	if (!firstMatch) {
		return null;
	}
	const newEmbed = embedLinkForPath(app, processedPath, note.path);
	await app.vault.process(note, (content) =>
		replaceSource
			? replaceSourceEmbeds(content, matches, newEmbed)
			: insertEmbedAfterSource(content, firstMatch.original, newEmbed),
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
