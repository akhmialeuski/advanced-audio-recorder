/**
 * Shared utilities for rewriting links to audio files in notes.
 * Used by the conversion flow (editor-based, preserves undo history)
 * and by the split flow (vault-wide, covers closed notes because the
 * source file may be deleted afterwards).
 * @module utils/LinkUpdater
 */

import { MarkdownView, TFile } from 'obsidian';
import type { App } from 'obsidian';
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
 * joined by newlines, preserving the embed prefix of the original link.
 * @param newFileNames - File names of the replacement links
 * @param isEmbed - Whether the original link was an embed (starts with '!')
 * @returns Newline-joined replacement links
 */
export function buildReplacementLinks(
	newFileNames: string[],
	isEmbed: boolean,
): string {
	return newFileNames
		.map((name) => (isEmbed ? `![[${name}]]` : `[[${name}]]`))
		.join('\n');
}

/**
 * Applies the link action to a single matched link text.
 * @param matchedLink - The full matched link (e.g. "![[file.webm]]")
 * @param newFileNames - File names of the replacement links
 * @param action - How to rewrite the link
 * @returns Replacement text for the match
 */
function rewriteMatchedLink(
	matchedLink: string,
	newFileNames: string[],
	action: ConversionLinkAction,
): string {
	const isEmbed = matchedLink.startsWith('!');
	const links = buildReplacementLinks(newFileNames, isEmbed);
	return action === 'after' ? `${matchedLink}\n${links}` : links;
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
			editor.replaceRange(
				rewriteMatchedLink(m.text, newFileNames, action),
				from,
				to,
			);
		}
	}
}

/**
 * Updates links to the source file in every note of the vault that
 * references it, including notes that are not currently open. Uses
 * metadataCache.resolvedLinks to find referencing notes and
 * vault.process for atomic modification.
 * @param app - Obsidian App instance
 * @param sourceFile - File whose links are being rewritten
 * @param newFileNames - File names of the replacement links
 * @param action - How to rewrite the links ('none' is a no-op)
 * @returns Number of notes that were updated
 */
export async function updateLinksInVault(
	app: App,
	sourceFile: TFile,
	newFileNames: string[],
	action: ConversionLinkAction,
): Promise<number> {
	if (action === 'none' || newFileNames.length === 0) {
		return 0;
	}

	// Notes may link by file name or by full vault path; cover both forms
	const patterns = [buildLinkPattern(sourceFile.name)];
	if (sourceFile.path !== sourceFile.name) {
		patterns.push(buildLinkPattern(sourceFile.path));
	}
	const referencingPaths = Object.entries(
		app.metadataCache.resolvedLinks,
	).filter(([, links]) => sourceFile.path in links);

	let updatedCount = 0;
	for (const [notePath] of referencingPaths) {
		const note = app.vault.getAbstractFileByPath(notePath);
		if (!(note instanceof TFile)) {
			continue;
		}
		let changed = false;
		await app.vault.process(note, (content) => {
			let rewritten = content;
			for (const pattern of patterns) {
				rewritten = rewritten.replace(pattern, (matchedLink) =>
					rewriteMatchedLink(matchedLink, newFileNames, action),
				);
			}
			changed = rewritten !== content;
			return rewritten;
		});
		if (changed) {
			updatedCount++;
		}
	}
	return updatedCount;
}
