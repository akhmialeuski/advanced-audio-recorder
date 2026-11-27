/**
 * Making text a model wrote safe to put into a note.
 *
 * What a model writes lands in the user's vault, where some characters mean
 * something. A `[[name]]` it wrote would link to a note nobody made and leave
 * a dangling link in the graph, a `|` would split a table cell, and a line
 * break would end a table row or a callout early. Each place a value is
 * written asks for the treatment it needs from here.
 * @module templates/markdownSafety
 */

/**
 * Text with the wiki links and embeds a model wrote shown as typed rather than
 * followed, so `[[Atlas]]` reads as text and no note is linked or created.
 * @param text - Text a model wrote
 */
export function neutralizeLinks(text: string): string {
	return text.replace(/(!?)\[\[/g, '$1\\[\\[');
}

/**
 * One line of text: line breaks and runs of spaces collapsed to one space.
 * @param text - Text a model wrote
 */
export function oneLine(text: string): string {
	return text.replace(/\s+/g, ' ').trim();
}

/**
 * Text for one table cell: on one line, with a pipe escaped so it does not
 * end the cell.
 * @param text - Text a model wrote
 */
export function tableCell(text: string): string {
	return oneLine(text).replace(/\|/g, '\\|');
}

/**
 * Text prefixed for the body of a callout or a quote, every line kept inside.
 * @param text - The body, possibly of several lines
 */
export function quoted(text: string): string {
	return text
		.split('\n')
		.map((line) => (line.trim() === '' ? '>' : `> ${line}`))
		.join('\n');
}
