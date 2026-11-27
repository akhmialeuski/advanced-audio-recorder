/**
 * The helpers every template can call.
 *
 * The set follows the one obsidian-citation-extended ships, so a user who
 * writes templates for both plugins writes them the same way: comparisons and
 * boolean logic for `{{#if}}`, string shaping, and dates. Dates go through the
 * `moment` Obsidian already carries, so `{{date format="dddd, D MMMM"}}`
 * accepts every format a core template or a daily note does and speaks the
 * vault's locale.
 *
 * A helper is declared with a description and an example next to its
 * function: the list of variables shows them, and a helper nobody can find is
 * a helper nobody uses.
 * @module templates/templateHelpers
 */

import { moment } from 'obsidian';
import type { HelperDelegate, HelperOptions } from 'handlebars';

/**
 * Obsidian's `moment`, typed as the namespace import of the moment package,
 * which `esModuleInterop` makes non-callable. At runtime it is the function.
 */
const momentOf = moment as unknown as (
	input?: number | string | Date,
	parseFormat?: unknown,
) => {
	isValid(): boolean;
	format(pattern: string): string;
};

/**
 * Moment's ISO 8601 parse format. Text is read only as ISO 8601, because the
 * fallback moment uses otherwise is the browser's own guess, which differs
 * between platforms and logs a deprecation warning for every miss.
 */
const ISO_8601 = (moment as unknown as { ISO_8601: unknown }).ISO_8601;

/** One helper, as a template calls it and as the variable list shows it. */
export interface TemplateHelper {
	/** Name a template calls it by. */
	readonly name: string;
	/** What it does, for the list of variables. */
	readonly description: string;
	/** A call as a template would write it. */
	readonly example: string;
	/** The function Handlebars runs. */
	readonly fn: HelperDelegate;
}

/** Format `{{date}}` renders without one. */
export const DEFAULT_DATE_FORMAT = 'YYYY-MM-DD';

/** Format `{{time}}` renders without one. */
export const DEFAULT_TIME_FORMAT = 'HH:mm';

/**
 * The arguments a helper was called with, without the options object
 * Handlebars appends as the last one.
 * @param args - Everything the helper received
 */
function positional(args: readonly unknown[]): unknown[] {
	return args.slice(0, -1);
}

/**
 * The options object Handlebars appends to every helper call.
 * @param args - Everything the helper received
 */
function optionsOf(args: readonly unknown[]): HelperOptions {
	return args[args.length - 1] as HelperOptions;
}

/**
 * The text of a value a string helper was handed. A missing value is the empty
 * string rather than "undefined", so a helper over an absent fact renders
 * nothing instead of a word nobody wrote.
 * @param value - Whatever the template passed
 */
function textOf(value: unknown): string {
	if (value === undefined || value === null) {
		return '';
	}
	if (typeof value === 'object') {
		return Array.isArray(value)
			? value.map(textOf).join(', ')
			: JSON.stringify(value);
	}
	return typeof value === 'string' ? value : `${value as number}`;
}

/**
 * Formats a moment in time the way a core template does.
 *
 * Called as `{{date}}` it formats now; called with a value it formats that
 * value, which may be epoch milliseconds, an ISO string or a Date. A value
 * moment cannot read renders as nothing instead of "Invalid date".
 * @param fallbackFormat - Format used when the call names none
 */
function formatMomentHelper(fallbackFormat: string): HelperDelegate {
	return (...args: unknown[]): string => {
		const [value] = positional(args);
		const hash = optionsOf(args).hash as { format?: unknown };
		const format =
			typeof hash.format === 'string' && hash.format !== ''
				? hash.format
				: fallbackFormat;
		const when = value === undefined ? momentOf() : momentAt(value);
		return when.isValid() ? when.format(format) : '';
	};
}

/**
 * The moment a template passed as a date.
 * @param value - Epoch milliseconds, an ISO 8601 string or a Date
 */
function momentAt(value: unknown): ReturnType<typeof momentOf> {
	if (typeof value === 'number' || value instanceof Date) {
		return momentOf(value);
	}
	return momentOf(textOf(value), ISO_8601);
}

/**
 * A number of seconds as a clock reading: `M:SS` under an hour and `H:MM:SS`
 * from one hour up, the way the transcript writes its timestamps.
 * @param value - Seconds, as a number or numeric text
 * @returns The reading, or empty for something that is not a number
 */
export function formatDuration(value: unknown): string {
	const seconds = typeof value === 'number' ? value : Number(textOf(value));
	if (!Number.isFinite(seconds) || textOf(value) === '') {
		return '';
	}
	const whole = Math.max(0, Math.round(seconds));
	const hours = Math.floor(whole / 3600);
	const minutes = Math.floor((whole % 3600) / 60);
	const rest = String(whole % 60).padStart(2, '0');
	if (hours === 0) {
		return `${String(minutes)}:${rest}`;
	}
	return `${String(hours)}:${String(minutes).padStart(2, '0')}:${rest}`;
}

/**
 * Quotes a value for a YAML property when the bare text would not survive
 * there: a colon followed by a space, a leading character YAML reserves, or a
 * quote. Plain text stays bare so a property reads as the user would type it.
 * @param value - Text going into frontmatter
 */
export function yamlQuote(value: unknown): string {
	const text = textOf(value);
	const needsQuotes =
		/: |\s#|^[\s\-?:,[\]{}#&*!|>'"%@`]|\s$|^$/.test(text) ||
		text.includes('"');
	if (!needsQuotes) {
		return text;
	}
	return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Replaces every match of a pattern. A pattern that is not a valid regular
 * expression leaves the text as it was rather than failing the whole note.
 * @param value - Text to rewrite
 * @param pattern - Regular expression source
 * @param replacement - What each match becomes
 */
function replaceAll(
	value: unknown,
	pattern: unknown,
	replacement: unknown,
): string {
	const text = textOf(value);
	try {
		return text.replace(
			new RegExp(textOf(pattern), 'g'),
			textOf(replacement),
		);
	} catch {
		return text;
	}
}

/**
 * Joins a list into text. A value that is not a list renders as itself, so
 * `{{join participants ", "}}` over a single name still shows it.
 * @param value - The list
 * @param separator - What goes between items; ", " when not a string
 */
function joinList(value: unknown, separator: unknown): string {
	if (!Array.isArray(value)) {
		return textOf(value);
	}
	const glue = typeof separator === 'string' ? separator : ', ';
	return value.map(textOf).join(glue);
}

/**
 * Every helper a template can call, in the order the variable list shows them.
 *
 * Comparisons are loose on purpose, as they are in obsidian-citation-extended:
 * a property read from frontmatter may be the number 3 or the text "3", and a
 * template author means both.
 */
export const TEMPLATE_HELPERS: readonly TemplateHelper[] = [
	{
		name: 'eq',
		description: 'True when two values are equal.',
		example: '{{#if (eq language "en")}}...{{/if}}',
		fn: (a: unknown, b: unknown) => a == b,
	},
	{
		name: 'ne',
		description: 'True when two values differ.',
		example: '{{#if (ne speakerCount 1)}}...{{/if}}',
		fn: (a: unknown, b: unknown) => a != b,
	},
	{
		name: 'gt',
		description: 'True when the first number is greater.',
		example: '{{#if (gt durationSeconds 3600)}}...{{/if}}',
		fn: (a: unknown, b: unknown) => Number(a) > Number(b),
	},
	{
		name: 'lt',
		description: 'True when the first number is smaller.',
		example: '{{#if (lt speakerCount 3)}}...{{/if}}',
		fn: (a: unknown, b: unknown) => Number(a) < Number(b),
	},
	{
		name: 'gte',
		description: 'True when the first number is greater or equal.',
		example: '{{#if (gte speakerCount 2)}}...{{/if}}',
		fn: (a: unknown, b: unknown) => Number(a) >= Number(b),
	},
	{
		name: 'lte',
		description: 'True when the first number is smaller or equal.',
		example: '{{#if (lte durationSeconds 600)}}...{{/if}}',
		fn: (a: unknown, b: unknown) => Number(a) <= Number(b),
	},
	{
		name: 'and',
		description: 'True when every argument is true.',
		example: '{{#if (and participants language)}}...{{/if}}',
		fn: (...args: unknown[]) => positional(args).every(Boolean),
	},
	{
		name: 'or',
		description: 'True when any argument is true.',
		example: '{{#if (or (eq language "en") (eq language "de"))}}...{{/if}}',
		fn: (...args: unknown[]) => positional(args).some(Boolean),
	},
	{
		name: 'not',
		description: 'Inverts a value.',
		example: '{{#if (not participants)}}...{{/if}}',
		fn: (value: unknown) => !value,
	},
	{
		name: 'default',
		description: 'The value, or a fallback when it is empty.',
		example: '{{default language "unknown"}}',
		fn: (value: unknown, fallback: unknown) =>
			textOf(value) === '' ? textOf(fallback) : textOf(value),
	},
	{
		name: 'upper',
		description: 'Text in upper case.',
		example: '{{upper title}}',
		fn: (value: unknown) => textOf(value).toUpperCase(),
	},
	{
		name: 'lower',
		description: 'Text in lower case.',
		example: '{{lower title}}',
		fn: (value: unknown) => textOf(value).toLowerCase(),
	},
	{
		name: 'trim',
		description: 'Text without surrounding whitespace.',
		example: '{{trim title}}',
		fn: (value: unknown) => textOf(value).trim(),
	},
	{
		name: 'truncate',
		description: 'The first N characters of the text.',
		example: '{{truncate title 40}}',
		fn: (value: unknown, length: unknown) =>
			textOf(value).slice(0, Math.max(0, Number(length) || 0)),
	},
	{
		name: 'replace',
		description: 'Replaces every match of a regular expression.',
		example: '{{replace title "_" " "}}',
		fn: replaceAll,
	},
	{
		name: 'join',
		description: 'Joins a list with a separator.',
		example: '{{join participants ", "}}',
		fn: joinList,
	},
	{
		name: 'split',
		description: 'Splits text into a list.',
		example: '{{#each (split tagsText ",")}}...{{/each}}',
		fn: (value: unknown, separator: unknown) =>
			textOf(value).split(textOf(separator)),
	},
	{
		name: 'quote',
		description: 'Quotes text so it is a valid YAML property value.',
		example: 'summary: {{quote title}}',
		fn: yamlQuote,
	},
	{
		name: 'date',
		description:
			'Now, or the given date, in a Moment format (YYYY-MM-DD by default).',
		example: '{{date format="dddd, D MMMM YYYY"}}',
		fn: formatMomentHelper(DEFAULT_DATE_FORMAT),
	},
	{
		name: 'time',
		description: 'Now, or the given date, as a time (HH:mm by default).',
		example: '{{time format="HH:mm:ss"}}',
		fn: formatMomentHelper(DEFAULT_TIME_FORMAT),
	},
	{
		name: 'duration',
		description: 'Seconds as a clock reading, e.g. 1:02:03.',
		example: '{{duration durationSeconds}}',
		fn: formatDuration,
	},
];
