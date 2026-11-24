/**
 * Text placed into the content of a note, for a note written through the
 * vault because no editor is editing it: one open in Reading view, or one
 * that is not open at all. Pure, so the placement is tested without a vault.
 * @module utils/noteText
 */

/**
 * The line break a note uses: Windows line ends are kept as they are, so an
 * edit does not rewrite every line of a note written on another system.
 * @param content - The note
 */
export const lineBreakOf = (content: string): string =>
	content.includes('\r\n') ? '\r\n' : '\n';

/**
 * Where lines added after a line start, as an index into the note's lines.
 * The end of a note that closes with a line break is before the empty line
 * that break leaves, so what is added does not open with a blank line.
 * @param lines - The note's lines
 * @param afterLine - Zero-based line to add after, or null for the end
 */
function insertionIndex(lines: string[], afterLine: number | null): number {
	const index =
		afterLine === null
			? lines.length
			: Math.min(Math.max(afterLine + 1, 0), lines.length);
	return index === lines.length && lines.at(-1) === ''
		? lines.length - 1
		: index;
}

/**
 * A note with lines added after one of its lines.
 * @param content - The note as read
 * @param text - The lines to add, joined by newlines
 * @param afterLine - Zero-based line to add after; null, or a line past the
 *   last one, adds at the end of the note
 * @returns The note with the lines in it, on lines of their own
 */
export function withLinesInserted(
	content: string,
	text: string,
	afterLine: number | null,
): string {
	const lines = content.split(/\r?\n/);
	const index = insertionIndex(lines, afterLine);
	const added = text.split(/\r?\n/);
	lines.splice(index, 0, ...added);
	// Lines added at the very end close with a line break, as the note's own
	// last line would.
	if (index + added.length === lines.length && lines.at(-1) !== '') {
		lines.push('');
	}
	return lines.join(lineBreakOf(content));
}

/**
 * A note with a block added after one of its lines, set off from the text
 * around it by a blank line on each side, as Markdown needs for a heading or
 * a paragraph to stand on its own.
 * @param content - The note as read
 * @param block - The block to add
 * @param afterLine - Zero-based line to add after; null, or a line past the
 *   last one, adds at the end of the note
 * @returns The note with the block in it
 */
export function withBlockInserted(
	content: string,
	block: string,
	afterLine: number | null,
): string {
	const lines = content.split(/\r?\n/);
	const index = insertionIndex(lines, afterLine);
	const blankBefore = index === 0 || lines[index - 1]?.trim() === '';
	const next = lines[index];
	const blankAfter = next === undefined || next.trim() === '';
	return withLinesInserted(
		content,
		`${blankBefore ? '' : '\n'}${block}${blankAfter ? '' : '\n'}`,
		afterLine,
	);
}

/**
 * The zero-based line a piece of text starts on in a note.
 * @param content - The note
 * @param text - The text to find
 * @returns Its line, or null when the note does not hold it
 */
export function lineOfText(content: string, text: string): number | null {
	const index = content.indexOf(text);
	return index === -1 ? null : content.slice(0, index).split('\n').length - 1;
}
