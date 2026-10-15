/**
 * The one reader of links in a line of note source: what the editor menu,
 * the player's right-click menu, a Live Preview timecode click and the
 * transcript-line lookup all use to answer "which link is this", so they can
 * no longer disagree about where a link ends, whether a Markdown target is
 * decoded, or whether the subpath is still attached when the link is resolved.
 *
 * It reads the line as the editor holds it rather than the metadata cache's
 * `links` and `embeds`, although those carry positions too. The cache is
 * built from the file on disk and is parsed again only after Obsidian saves
 * the note, so for a link typed or moved a moment ago it either knows nothing
 * or names columns that now hold other text. Every caller here works in
 * editor coordinates - a click mapped to a buffer offset, a cursor, a range
 * the delete action removes from the buffer - so a position taken from the
 * cache could point the delete at the wrong text. Checking a cache entry
 * against the buffer and falling back to the line when it is stale would
 * still need this reader for the stale case, and would only add a second path
 * that agrees with it when the cache happens to be fresh. Splitting the
 * target into path and subpath is left to Obsidian's own `parseLinktext`, and
 * a Markdown target is decoded the way the metadata cache decodes it, so a
 * link read here resolves exactly as the same link read from the cache does.
 * @module obsidian/sourceLinks
 */

import { parseLinktext } from 'obsidian';

/** One link or embed found in a line of note source. */
export interface SourceLink {
	/** Column the link starts at, including an embed's `!`. */
	start: number;
	/** Column just past the link's closing `]]` or `)`. */
	end: number;
	/** Whether the link is an embed (`![[...]]` or `![...](...)`). */
	embed: boolean;
	/**
	 * The link text the way the metadata cache's `link` field holds it: the
	 * target without the alias or label, a Markdown target URL-decoded, e.g.
	 * `rec one.m4a#t=12`.
	 */
	link: string;
	/** The file part of {@link link}, ready for `getFirstLinkpathDest`. */
	path: string;
	/** The subpath of {@link link} with its `#`, or an empty string. */
	subpath: string;
}

/**
 * A wikilink or a Markdown link, either of them possibly an embed. The groups
 * are the embed marker, the wikilink target (the alias after `|` is not
 * captured, nor the backslash Obsidian writes before that `|` inside a table
 * row so the pipe does not end the cell), a Markdown target written in angle
 * brackets, and a bare Markdown
 * target, which Obsidian URL-encodes and which may hold one level of balanced
 * parentheses, as in `rec%20(1).m4a`. An optional link title after the target
 * is accepted and ignored.
 */
const SOURCE_LINK_PATTERN =
	/(!)?(?:\[\[([^\]|\n]+?)(?:\\?\|[^\]\n]*)?\]\]|\[[^\]\n]*\]\((?:<([^>\n]+)>|((?:[^()\s]|\([^()\s]*\))+))(?:\s+"[^"\n]*")?\))/g;

/**
 * Decodes the target of a Markdown link the way the metadata cache reads it.
 * A malformed escape is left as written, since that is what the link says.
 * @param target - The target between the parentheses
 * @returns The decoded target
 */
function decodeLinkTarget(target: string): string {
	try {
		return decodeURI(target);
	} catch {
		return target;
	}
}

/**
 * Every link and embed in one line of note source, in the order they appear.
 * @param lineText - The line as the editor holds it
 * @returns The links found, empty when the line holds none
 */
export function linksInLine(lineText: string): SourceLink[] {
	const links: SourceLink[] = [];
	for (const match of lineText.matchAll(SOURCE_LINK_PATTERN)) {
		const [whole, bang, wikiTarget, bracketedTarget, encodedTarget] = match;
		const link =
			wikiTarget ??
			bracketedTarget ??
			decodeLinkTarget(String(encodedTarget));
		const { path, subpath } = parseLinktext(link);
		links.push({
			start: match.index,
			end: match.index + whole.length,
			embed: bang !== undefined,
			link,
			path,
			subpath,
		});
	}
	return links;
}

/**
 * The link at a column of one line of note source, or null when there is
 * none. A column names the gap before a character, and two kinds of caller
 * land on it differently: a DOM node maps to the gap before its first
 * character, which is inside the link, while the caret a right-click places
 * on the right half of the closing bracket sits on the gap just past it. Both
 * mean this link, so a link also answers for the column it ends at, unless
 * another link starts right there, in which case that one is the link under
 * the pointer.
 * @param lineText - The line as the editor holds it
 * @param ch - Column within the line
 * @returns The link at the column, or null when none is there
 */
export function linkAtColumn(lineText: string, ch: number): SourceLink | null {
	const links = linksInLine(lineText);
	return (
		links.find((link) => link.start <= ch && ch < link.end) ??
		links.find((link) => link.end === ch) ??
		null
	);
}
