/**
 * The link a cursor stands on, read from one line of note source. Shared by
 * the editor menu, which offers the file actions for the link it was opened
 * on, and by the palette, which acts on the recording under the cursor before
 * any other recording of the note.
 * @module obsidian/linkAtCursor
 */

/** A link in one line of source, with the span it occupies. */
export interface LinkAtCursor {
	/** The link target, without its alias. */
	readonly path: string;
	/** Column the link starts at, its `!` included. */
	readonly start: number;
	/** Column just past the link's last character. */
	readonly end: number;
}

/** `![[target]]` or `[[target|alias]]`, target in group 1. */
const WIKI_LINK = /!?\[\[(.*?)(?:\|.*?)?\]\]/g;

/**
 * `![alt](target)` or `[text](target)`, target in group 2. The text holds no
 * bracket, so a task box or a footnote earlier in the line - `- [ ] see
 * [call](rec.webm)` - is never taken for the start of the link.
 */
const MARKDOWN_LINK = /!?\[([^[\]]*)\]\(([^()]*)\)/g;

/**
 * A Markdown link's target as the vault names the file: Obsidian writes a
 * path with spaces percent-encoded, or wraps it in angle brackets.
 * @param target - The target as written
 */
function markdownTarget(target: string): string {
	const bare =
		target.startsWith('<') && target.endsWith('>')
			? target.slice(1, -1)
			: target;
	try {
		return decodeURIComponent(bare);
	} catch {
		// A lone % is a character of the name, not an escape.
		return bare;
	}
}

/**
 * Finds the wikilink or Markdown link, embed or not, that a cursor column
 * falls inside or at either edge of - at its end only where no other link
 * begins. Wikilinks are tried first, as the form Obsidian writes by default.
 * @param lineText - The text of the line
 * @param cursorCh - The cursor column
 * @returns The link, or null when the cursor is on none
 */
export function linkAtCursor(
	lineText: string,
	cursorCh: number,
): LinkAtCursor | null {
	const found = (
		text: string,
		pattern: RegExp,
		group: number,
	): LinkAtCursor[] =>
		[...text.matchAll(pattern)].map((match) => ({
			// The group takes part in every match, if only as ''.
			path: String(match[group]),
			start: match.index,
			end: match.index + match[0].length,
		}));
	const wikilinks = found(lineText, WIKI_LINK, 1);
	// Markdown links are looked for with the wikilinks blanked out, columns
	// kept: the lazy Markdown pattern would otherwise start at a wikilink's
	// bracket and run on to a Markdown link later in the line.
	const outsideWikilinks = wikilinks.reduce(
		(text, wiki) =>
			text.slice(0, wiki.start) +
			' '.repeat(wiki.end - wiki.start) +
			text.slice(wiki.end),
		lineText,
	);
	const links = [
		...wikilinks,
		...found(outsideWikilinks, MARKDOWN_LINK, 2).map((link) => ({
			...link,
			path: markdownTarget(link.path),
		})),
	];
	// A column where one link ends and the next begins is the next one's:
	// a position mapped to the start of an embed, or a cursor in front of a
	// link, means that link and not the one before it.
	return (
		links.find((link) => cursorCh >= link.start && cursorCh < link.end) ??
		links.find((link) => cursorCh === link.end) ??
		null
	);
}

/**
 * Whether a link points at a file as a whole rather than at a heading, a
 * block or a moment of it. A timecode link is part of a transcript line and
 * points at one moment, so it is never "the link" a delete removes: that is
 * one to the whole recording, as the links a note-wide removal takes are.
 * @param link - The link
 */
export function pointsAtWholeFile(link: { readonly path: string }): boolean {
	return !link.path.includes('#');
}
