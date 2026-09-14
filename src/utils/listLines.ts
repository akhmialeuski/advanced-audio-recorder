/**
 * One entry per line, read the way a Markdown note writes a list.
 *
 * A glossary or a roster typed into the settings is plain lines, and the same
 * body kept in a note is almost always a Markdown list under a heading. Both
 * have to yield the same entries, so the rule turning a line into an entry is
 * written once here and every list-shaped profile body is read through it. A
 * prompt is never read this way: its markup is part of the instruction.
 * @module utils/listLines
 */

/** An ATX heading: a section title of the note, never an entry of the list. */
const HEADING_LINE = /^\s{0,3}#{1,6}(?:\s|$)/;

/**
 * The markup a list item opens with: a bullet or an ordered number, then an
 * optional task checkbox. A marker counts only when whitespace or the end of
 * the line follows it, so `*nix` and `1.5x` stay entries as written.
 */
const LIST_MARKER = /^\s*(?:[-*+]|\d+[.)])(?:\s+|$)(?:\[.\](?:\s+|$))?/;

/**
 * Splits text into its list entries. A heading line is skipped, and a list
 * item keeps only the text after its marker. Entries come back untrimmed and
 * possibly blank, because trimming and de-duplicating are the rules of the
 * list being read, which differ between a glossary and a roster.
 * @param text - The body as typed, or as read from a note
 * @returns One entry per line that is not a heading
 */
export function listEntries(text: string): string[] {
	return text
		.split(/\r?\n/)
		.filter((line) => !HEADING_LINE.test(line))
		.map((line) => line.replace(LIST_MARKER, ''));
}
