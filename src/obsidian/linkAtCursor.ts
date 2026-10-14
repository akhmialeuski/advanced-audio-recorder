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

/** `![alt](target)` or `[text](target)`, target in group 2. */
const MARKDOWN_LINK = /!?\[(.*?)\]\((.*?)\)/g;

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
	const links: LinkAtCursor[] = [];
	for (const [pattern, group] of [
		[WIKI_LINK, 1],
		[MARKDOWN_LINK, 2],
	] as const) {
		for (const match of lineText.matchAll(pattern)) {
			const start = match.index;
			links.push({
				// The group takes part in every match, if only as ''.
				path: String(match[group]),
				start,
				end: start + match[0].length,
			});
		}
	}
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
