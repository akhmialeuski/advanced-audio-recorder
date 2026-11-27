/**
 * The text-level side of the template notation: what is accepted besides
 * Handlebars itself, and where in the text a problem is.
 *
 * Templates are Handlebars, as they are in obsidian-citation-extended. A user
 * coming from Obsidian's core Templates plugin writes `{{date:YYYY-MM-DD}}`,
 * which Handlebars cannot parse as a call with a format, so that one form is
 * rewritten into the Handlebars call it means before anything else reads the
 * text. The rewrite keeps every line where it was, so a problem found in the
 * rewritten text is reported on the line the user typed it on.
 * @module templates/templateSyntax
 */

/** Where in a template something is: a 1-based line and column. */
export interface TemplateLocation {
	readonly line: number;
	readonly column: number;
}

/**
 * `{{date:FORMAT}}` or `{{time:FORMAT}}`, the core Templates notation. The
 * format runs to the closing braces and cannot hold a brace or a line break,
 * exactly as in the core plugin.
 */
const CORE_DATE_CALL = /\{\{\s*(date|time)\s*:\s*([^{}\n]*?)\s*\}\}/g;

/**
 * Rewrites the core Templates date and time calls into Handlebars calls, so
 * `{{date:dddd}}` reads as `{{date format="dddd"}}`. Everything else is left
 * byte for byte.
 * @param source - The template as the user wrote it
 * @returns The template Handlebars parses
 */
export function normalizeCoreSyntax(source: string): string {
	return source.replace(
		CORE_DATE_CALL,
		(_match, name: string, format: string) =>
			`{{${name} format="${format.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"}}`,
	);
}

/** What Handlebars attaches to the errors it throws while parsing. */
interface HandlebarsErrorFields {
	readonly lineNumber?: unknown;
	readonly column?: unknown;
}

/**
 * Where a Handlebars parse error points.
 *
 * Handlebars reports a location in one of two ways. A mismatched block carries
 * `lineNumber` and a 0-based `column` on the error. A grammar error carries
 * neither and instead writes "Parse error on line N:" followed by the line and
 * a caret under the offending character, so the column is read off the caret.
 * @param error - What Handlebars threw
 * @returns The location, or undefined when the error names none
 */
export function parseErrorLocation(
	error: unknown,
): TemplateLocation | undefined {
	const fields = (error ?? {}) as HandlebarsErrorFields;
	if (typeof fields.lineNumber === 'number') {
		const column = typeof fields.column === 'number' ? fields.column : 0;
		return { line: fields.lineNumber, column: column + 1 };
	}
	return caretLocation(
		error instanceof Error ? error.message : String(error),
	);
}

/**
 * The location a grammar error's message draws: the line it names and the
 * column of the caret under the offending character.
 * @param message - The error's message
 */
function caretLocation(message: string): TemplateLocation | undefined {
	const line = /Parse error on line (\d+):/.exec(message);
	if (!line?.[1]) {
		return undefined;
	}
	const caret = /\n(-*)\^/.exec(message);
	return {
		line: Number(line[1]),
		column: (caret?.[1]?.length ?? 0) + 1,
	};
}

/**
 * The first line of a Handlebars error, without the location Handlebars
 * prefixes or appends, so a message and its location are shown separately.
 * @param error - What Handlebars threw
 */
export function parseErrorMessage(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	const expecting = /\n(Expecting [^\n]*)/.exec(message);
	if (expecting?.[1]) {
		return expecting[1];
	}
	const first = message.split('\n')[0] ?? message;
	return first.replace(/ - \d+:\d+$/, '');
}

/**
 * The offset in a text of a 1-based line and 0-based column, as Handlebars
 * numbers the locations of its nodes.
 * @param source - The text the location points into
 * @param line - 1-based line
 * @param column - 0-based column
 */
export function offsetOf(source: string, line: number, column: number): number {
	let offset = 0;
	for (let current = 1; current < line; current += 1) {
		const next = source.indexOf('\n', offset);
		if (next < 0) {
			return source.length;
		}
		offset = next + 1;
	}
	return offset + column;
}
