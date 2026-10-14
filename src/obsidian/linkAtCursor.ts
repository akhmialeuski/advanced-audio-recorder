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
 * falls inside or at either edge of. Wikilinks are tried first, as the form
 * Obsidian writes by default.
 * @param lineText - The text of the line
 * @param cursorCh - The cursor column
 * @returns The link, or null when the cursor is on none
 */
export function linkAtCursor(
	lineText: string,
	cursorCh: number,
): LinkAtCursor | null {
	for (const [pattern, group] of [
		[WIKI_LINK, 1],
		[MARKDOWN_LINK, 2],
	] as const) {
		for (const match of lineText.matchAll(pattern)) {
			const start = match.index;
			const end = start + match[0].length;
			const path = match[group];
			if (path !== undefined && cursorCh >= start && cursorCh <= end) {
				return { path, start, end };
			}
		}
	}
	return null;
}
