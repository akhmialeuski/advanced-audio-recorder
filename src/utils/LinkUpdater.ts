/**
 * Shared utilities for rewriting links to audio files in notes.
 * Used by the conversion flow (editor-based, preserves undo history)
 * and by the split flow (vault-wide, covers closed notes because the
 * source file may be deleted afterwards). The vault-wide variant works
 * on parsed metadata references, so every link syntax Obsidian indexes
 * (wikilinks, Markdown links, relative paths) is rewritten; frontmatter
 * links cannot hold several replacement links and are only counted.
 * @module utils/LinkUpdater
 */

import { MarkdownView, TFile, getLinkpath } from 'obsidian';
import type { App, ReferenceCache } from 'obsidian';
import { PLUGIN_LOG_PREFIX } from '../constants';
import type { ConversionLinkAction } from '../settings/Settings';

/**
 * Builds a regex matching all common internal link formats for a filename:
 * ![[file]], [[file]], ![[file|alias]], [[file|alias]]
 * @param fileName - File name (with extension) to match
 * @returns Global regex matching links to the file
 */
export function buildLinkPattern(fileName: string): RegExp {
	const escaped = fileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	return new RegExp(`(!?\\[\\[${escaped}(?:\\|[^\\]]*)?\\]\\])`, 'g');
}

/**
 * Builds the replacement text for a matched link: one link per new file,
 * joined by the given separator, preserving the embed prefix of the
 * original link.
 * @param newFileNames - File names of the replacement links
 * @param isEmbed - Whether the original link was an embed (starts with '!')
 * @param separator - Text inserted between the replacement links
 * @returns Joined replacement links
 */
export function buildReplacementLinks(
	newFileNames: string[],
	isEmbed: boolean,
	separator: string = '\n',
): string {
	return newFileNames
		.map((name) => (isEmbed ? `![[${name}]]` : `[[${name}]]`))
		.join(separator);
}

/**
 * Checks whether a reference occupies its line alone (ignoring
 * surrounding whitespace). Only then is it safe to expand one link into
 * several newline-separated links; inside single-line constructs such
 * as table rows, headings, or callout titles a newline would sever the
 * construct, so the replacement must stay on one line.
 * @param content - Full note content the offsets refer to
 * @param startOffset - Start offset of the reference
 * @param endOffset - End offset of the reference
 * @returns True when nothing but whitespace shares the line
 */
function isReferenceAloneOnLine(
	content: string,
	startOffset: number,
	endOffset: number,
): boolean {
	const lineStart = content.lastIndexOf('\n', startOffset - 1) + 1;
	const newlineAfter = content.indexOf('\n', endOffset);
	const lineEnd = newlineAfter === -1 ? content.length : newlineAfter;
	return (
		content.slice(lineStart, startOffset).trim() === '' &&
		content.slice(endOffset, lineEnd).trim() === ''
	);
}

/**
 * Applies the link action to a single matched link text.
 * @param matchedLink - The full matched link (e.g. "![[file.webm]]")
 * @param newFileNames - File names of the replacement links
 * @param action - How to rewrite the link
 * @param separator - Text inserted between the resulting links
 * @returns Replacement text for the match
 */
function rewriteMatchedLink(
	matchedLink: string,
	newFileNames: string[],
	action: ConversionLinkAction,
	separator: string,
): string {
	const isEmbed = matchedLink.startsWith('!');
	const links = buildReplacementLinks(newFileNames, isEmbed, separator);
	return action === 'after' ? `${matchedLink}${separator}${links}` : links;
}

/**
 * Finds and updates links to the source file in all open Markdown editors.
 * Uses replaceRange to preserve undo history.
 * @param app - Obsidian App instance
 * @param sourceFileName - File name (with extension) being replaced
 * @param newFileNames - File names of the replacement links
 * @param action - How to rewrite the links ('none' is a no-op)
 */
export function updateLinksInOpenEditors(
	app: App,
	sourceFileName: string,
	newFileNames: string[],
	action: ConversionLinkAction,
): void {
	if (action === 'none' || newFileNames.length === 0) {
		return;
	}

	const leaves = app.workspace.getLeavesOfType('markdown');
	const pattern = buildLinkPattern(sourceFileName);

	for (const leaf of leaves) {
		if (!(leaf.view instanceof MarkdownView)) {
			continue;
		}
		const editor = leaf.view.editor;
		const content = editor.getValue();
		if (!content.includes(sourceFileName)) {
			continue;
		}

		// Collect matches first, then apply replacements from end to start
		// so earlier offsets stay valid
		const matches: { index: number; length: number; text: string }[] = [];
		let match: RegExpExecArray | null;
		while ((match = pattern.exec(content)) !== null) {
			matches.push({
				index: match.index,
				length: match[0].length,
				text: match[0],
			});
		}

		for (let i = matches.length - 1; i >= 0; i--) {
			const m = matches[i];
			const from = editor.offsetToPos(m.index);
			const to = editor.offsetToPos(m.index + m.length);
			const separator = isReferenceAloneOnLine(
				content,
				m.index,
				m.index + m.length,
			)
				? '\n'
				: ' ';
			editor.replaceRange(
				rewriteMatchedLink(m.text, newFileNames, action, separator),
				from,
				to,
			);
		}
	}
}

/**
 * Builds the replacement text for one parsed reference: one link per
 * new file, generated with the user's link-format preferences, joined
 * by the given separator. The embed prefix of the original reference is
 * preserved regardless of how generateMarkdownLink treats the file type.
 * @param app - Obsidian App instance
 * @param reference - The reference being replaced
 * @param newFiles - Files the replacement links point to
 * @param notePath - Path of the note containing the reference
 * @param action - How to rewrite the link
 * @param separator - Text inserted between the resulting links
 * @returns Replacement text for the reference
 */
function buildReferenceReplacement(
	app: App,
	reference: ReferenceCache,
	newFiles: TFile[],
	notePath: string,
	action: ConversionLinkAction,
	separator: string,
): string {
	const isEmbed = reference.original.startsWith('!');
	const links = newFiles
		.map((file) => {
			const link = app.fileManager.generateMarkdownLink(file, notePath);
			const bareLink = link.startsWith('!') ? link.slice(1) : link;
			return isEmbed ? `!${bareLink}` : bareLink;
		})
		.join(separator);
	return action === 'after'
		? `${reference.original}${separator}${links}`
		: links;
}

/**
 * Checks whether a parsed reference resolves to the given file.
 * @param app - Obsidian App instance
 * @param link - Link text of the reference (may carry a subpath)
 * @param notePath - Path of the note containing the reference
 * @param sourceFile - File the reference must resolve to
 * @returns True when the reference points at the source file
 */
function resolvesToFile(
	app: App,
	link: string,
	notePath: string,
	sourceFile: TFile,
): boolean {
	const target = app.metadataCache.getFirstLinkpathDest(
		getLinkpath(link),
		notePath,
	);
	return target?.path === sourceFile.path;
}

/**
 * Collects the parsed references (links and embeds) of a note that
 * resolve to the source file, sorted by descending position so they
 * can be replaced from the end of the note to the start. Frontmatter
 * links are deliberately excluded: a YAML property cannot hold several
 * links, so they are only counted (see countFrontmatterReferences) and
 * reported to the caller.
 * @param app - Obsidian App instance
 * @param note - Note to scan
 * @param sourceFile - File the references must resolve to
 * @returns Matching references in descending position order
 */
function collectSourceReferences(
	app: App,
	note: TFile,
	sourceFile: TFile,
): ReferenceCache[] {
	const cache = app.metadataCache.getFileCache(note);
	const references = [...(cache?.links ?? []), ...(cache?.embeds ?? [])];
	return references
		.filter((reference) =>
			resolvesToFile(app, reference.link, note.path, sourceFile),
		)
		.sort((a, b) => b.position.start.offset - a.position.start.offset);
}

/**
 * Counts the frontmatter links of a note that resolve to the source
 * file. These cannot be rewritten to several part links, so callers
 * surface the count to the user instead.
 * @param app - Obsidian App instance
 * @param note - Note to scan
 * @param sourceFile - File the references must resolve to
 * @returns Number of frontmatter references to the source file
 */
function countFrontmatterReferences(
	app: App,
	note: TFile,
	sourceFile: TFile,
): number {
	const cache = app.metadataCache.getFileCache(note);
	return (cache?.frontmatterLinks ?? []).filter((reference) =>
		resolvesToFile(app, reference.link, note.path, sourceFile),
	).length;
}

/**
 * Outcome of a vault-wide link update, surfaced to the user by callers:
 * skipped references mean some links still point at the source file,
 * and frontmatter references cannot be rewritten at all.
 */
export interface VaultLinkUpdateResult {
	/** Number of notes whose body content was updated. */
	updatedNotes: number;
	/** References skipped because the metadata cache was stale. */
	skippedReferences: number;
	/** Frontmatter references to the source that cannot be rewritten. */
	frontmatterReferences: number;
}

/**
 * Updates links to the source file in every note of the vault that
 * references it, including notes that are not currently open. Uses
 * metadataCache.resolvedLinks to find referencing notes, the parsed
 * link/embed references for exact positions (covering wikilinks,
 * Markdown links, and relative paths alike), and vault.process for
 * atomic modification. References that share a line with other content
 * are replaced with space-separated links so single-line constructs
 * (table rows, headings) stay intact; references alone on their line
 * get one link per line.
 * @param app - Obsidian App instance
 * @param sourceFile - File whose links are being rewritten
 * @param newFiles - Files the replacement links point to
 * @param action - How to rewrite the links ('none' is a no-op)
 * @returns Counts of updated notes, skipped references, and
 * frontmatter references left untouched
 */
export async function updateLinksInVault(
	app: App,
	sourceFile: TFile,
	newFiles: TFile[],
	action: ConversionLinkAction,
): Promise<VaultLinkUpdateResult> {
	const result: VaultLinkUpdateResult = {
		updatedNotes: 0,
		skippedReferences: 0,
		frontmatterReferences: 0,
	};
	if (action === 'none' || newFiles.length === 0) {
		return result;
	}

	const referencingPaths = Object.entries(app.metadataCache.resolvedLinks)
		.filter(([, links]) => sourceFile.path in links)
		.map(([notePath]) => notePath);

	for (const notePath of referencingPaths) {
		const note = app.vault.getAbstractFileByPath(notePath);
		if (!(note instanceof TFile)) {
			continue;
		}
		result.frontmatterReferences += countFrontmatterReferences(
			app,
			note,
			sourceFile,
		);
		const references = collectSourceReferences(app, note, sourceFile);
		if (references.length === 0) {
			continue;
		}
		let changed = false;
		await app.vault.process(note, (content) => {
			let rewritten = content;
			// Replace from the end to the start so earlier offsets stay valid
			for (const reference of references) {
				const { start, end } = reference.position;
				const original = rewritten.slice(start.offset, end.offset);
				if (original !== reference.original) {
					// The metadata cache lags behind the file content;
					// skip the reference instead of corrupting the note
					result.skippedReferences++;
					console.warn(
						`${PLUGIN_LOG_PREFIX} Skipped a stale link reference in:`,
						notePath,
					);
					continue;
				}
				const separator = isReferenceAloneOnLine(
					rewritten,
					start.offset,
					end.offset,
				)
					? '\n'
					: ' ';
				rewritten =
					rewritten.slice(0, start.offset) +
					buildReferenceReplacement(
						app,
						reference,
						newFiles,
						notePath,
						action,
						separator,
					) +
					rewritten.slice(end.offset);
			}
			changed = rewritten !== content;
			return rewritten;
		});
		if (changed) {
			result.updatedNotes++;
		}
	}
	return result;
}
