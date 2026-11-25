/**
 * Note link insertion utilities for the recording pipeline.
 * Handles capturing cursor context and inserting audio file links
 * into Obsidian notes.
 * @module recording/NoteInserter
 */

import { getLinkpath } from 'obsidian';
import type { App, Editor, EmbedCache, TFile } from 'obsidian';
import type { InsertionContext } from '../types';
import type { DebugLogSink } from '../utils/DebugLogger';
import { withLinesInserted } from '../utils/noteText';
import { activeNote, findNoteEditor } from '../utils/noteViews';

/**
 * Captures the active note path and cursor line for later insertion of
 * audio links. A note in Reading view is captured too, without a line: it
 * has no cursor, and its hidden editor's one is not where the user is.
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
	const note = activeNote(app);
	const filePath = note?.file?.path;
	if (filePath) {
		return {
			filePath,
			line: note.editor?.getCursor().line ?? null,
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
 * Adds lines after a line of the note an editor holds, or at its end.
 * @param editor - The editor the note is being edited in
 * @param text - The lines to add
 * @param afterLine - Zero-based line to add after, or null for the end
 */
export function insertLinesInEditor(
	editor: Editor,
	text: string,
	afterLine: number | null,
): void {
	const last = editor.lastLine();
	if (afterLine !== null && afterLine < last) {
		editor.replaceRange(`${text}\n`, { line: afterLine + 1, ch: 0 });
		return;
	}
	// Past the last line there is no line start to insert at, so the text
	// opens with the break that ends the last line when it holds any text.
	const end = editor.getLine(last).length;
	editor.replaceRange(`${end > 0 ? '\n' : ''}${text}\n`, {
		line: last,
		ch: end,
	});
}

/**
 * Adds lines to a specific note: through its editor when it is being edited,
 * so they join what is typed there, and through the vault when it is in
 * Reading view or not open, where no editor reaches its file.
 * @param app - Obsidian App instance
 * @param notePath - Vault path of the note
 * @param text - The lines to add
 * @param afterLine - Zero-based line to add after, or null for the end
 * @returns Whether the note took the lines; false when it no longer exists
 */
async function insertLinesIntoNote(
	app: App,
	notePath: string,
	text: string,
	afterLine: number | null,
): Promise<boolean> {
	const editor = findNoteEditor(app, notePath);
	if (editor) {
		insertLinesInEditor(editor, text, afterLine);
		return true;
	}
	const note = app.vault.getFileByPath(notePath);
	if (!note) {
		return false;
	}
	await app.vault.process(note, (content) =>
		withLinesInserted(content, text, afterLine),
	);
	return true;
}

/**
 * Inserts embeds of the given files into a note: the note the recording was
 * started in, after the line the cursor was on, or else the active note, at
 * its cursor. Either note takes them in any view mode - a note in Reading
 * view, which has no cursor, takes them at its end. The embeds are built for
 * the note they land in, since a relative or shortest-path link is only
 * correct from there.
 * @param fileLinks - Array of saved file paths
 * @param insertionContext - Previously captured cursor context
 * @param app - Obsidian App instance
 * @returns The path of the note the links were inserted into, or null when
 *          no note was available to receive them
 */
export async function insertFileLinks(
	fileLinks: string[],
	insertionContext: InsertionContext | null,
	app: App,
): Promise<string | null> {
	const linksFor = (notePath: string): string =>
		embedLinksFor(app, fileLinks, notePath);
	if (
		insertionContext &&
		(await insertLinesIntoNote(
			app,
			insertionContext.filePath,
			linksFor(insertionContext.filePath),
			insertionContext.line,
		))
	) {
		return insertionContext.filePath;
	}
	return insertIntoActiveNote(app, linksFor);
}

/**
 * Inserts lines into the active note: at the cursor of one being edited, at
 * the end of one in Reading view.
 * @param app - Obsidian App instance
 * @param linesFor - Builds the lines for the note they land in
 * @returns The path of the note that took them, or null when none did
 */
async function insertIntoActiveNote(
	app: App,
	linesFor: (notePath: string) => string,
): Promise<string | null> {
	const active = activeNote(app);
	if (!active) {
		return null;
	}
	const notePath = active.file?.path ?? null;
	if (active.editor) {
		active.editor.replaceSelection(linesFor(notePath ?? ''));
		return notePath;
	}
	const written =
		notePath !== null &&
		(await insertLinesIntoNote(app, notePath, linesFor(notePath), null));
	return written ? notePath : null;
}

/**
 * Inserts text at the cursor of the active note, for a dictation started where
 * no note was active to anchor it.
 * @param app - Obsidian App instance
 * @param text - The text to insert, verbatim
 * @returns The path of the note the text went into, or null when no note is
 *   being edited: a note in Reading view has no cursor to take it at
 */
export function insertTextAtCursor(app: App, text: string): string | null {
	const active = activeNote(app);
	if (!active?.editor) {
		return null;
	}
	active.editor.replaceSelection(text);
	return active.file?.path ?? null;
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
