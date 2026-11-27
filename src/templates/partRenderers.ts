/**
 * The Markdown each format of a part writes from its value.
 *
 * The plugin writes the Markdown, never the model, so the syntax that breaks
 * when one character is off, a checkbox, a table row, a callout line, comes
 * out the same way every time.
 * @module templates/partRenderers
 */

import { oneLine, quoted, tableCell } from './markdownSafety';
import type { PartRecord } from './partReaders';
import { formatTimecode, parseTimecode } from '../utils/TimeUtils';

/** What a part's settings say about how its result is shaped. */
export interface PartShape {
	/** Most items a list keeps; undefined for no limit. */
	readonly max?: number | undefined;
	/** Every other setting of the part, by name, as the template gave it. */
	readonly options: Readonly<Record<string, unknown>>;
	/**
	 * A link to a moment of the recording, labelled with its timecode. Absent
	 * where no link can be written, and a moment is then its timecode alone.
	 */
	readonly links?: ((seconds: number) => string) | undefined;
}

/**
 * The first `max` items of a list. The prompt asks for no more than that, but
 * the cut here is what guarantees it.
 * @param items - The list
 * @param shape - The part's settings
 */
export function limited<T>(
	items: readonly T[],
	shape: PartShape,
): readonly T[] {
	return shape.max === undefined ? items : items.slice(0, shape.max);
}

/**
 * A setting given as text, or the fallback.
 * @param shape - The part's settings
 * @param name - The setting
 * @param fallback - What it is when not given
 */
export function textOption(
	shape: PartShape,
	name: string,
	fallback: string,
): string {
	const value = shape.options[name];
	return typeof value === 'string' && value.trim() !== ''
		? value.trim()
		: fallback;
}

/**
 * The columns a table part names in `columns="A, B"`.
 * @param shape - The part's settings
 */
export function tableColumns(shape: PartShape): string[] {
	return textOption(shape, 'columns', '')
		.split(',')
		.map((column) => column.trim())
		.filter((column) => column !== '');
}

/**
 * A list, one item per line, with the marker each item gets.
 * @param items - The items
 * @param shape - The part's settings
 * @param marker - The marker of the item at an index
 */
export function listOf(
	items: readonly string[],
	shape: PartShape,
	marker: (index: number) => string,
): string {
	return limited(items, shape)
		.map((item, index) => `${marker(index)} ${oneLine(item)}`)
		.join('\n');
}

/** A calendar date as Dataview and Tasks read it. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The fields of one task, cleaned for one line. */
interface TaskFields {
	readonly text: string;
	readonly owner: string;
	readonly due: string;
}

/**
 * What a plain task writes after its text: who and by when, in brackets.
 * @param task - The task's fields
 */
function plainTaskDetail({ owner, due }: TaskFields): string[] {
	const detail = [owner, due && `due ${due}`].filter(Boolean);
	return detail.length > 0 ? [`(${detail.join(', ')})`] : [];
}

/** How each style other than plain writes what follows a task's text. */
const TASK_STYLES: Readonly<
	Record<string, ((task: TaskFields) => string[]) | undefined>
> = {
	dataview: ({ owner, due }) => [
		...(owner ? [`[owner:: ${owner}]`] : []),
		...(due ? [`[due:: ${due}]`] : []),
	],
	tasks: ({ owner, due }) => [
		...(owner ? [`(${owner})`] : []),
		...(due ? [`📅 ${due}`] : []),
	],
};

/**
 * The fields of one task, each on one line, and a due date only when it is a
 * calendar date the style can read.
 * @param task - The task as read
 */
function taskFields(task: PartRecord): TaskFields {
	const due = task['due'] ?? '';
	return {
		text: oneLine(task['text'] ?? ''),
		owner: oneLine(task['owner'] ?? ''),
		due: ISO_DATE.test(due) ? due : '',
	};
}

/**
 * One task, in the style a template asks for: plain text, Dataview inline
 * fields, or the Tasks plugin's due date.
 * @param task - The task's fields
 * @param style - `plain`, `dataview` or `tasks`
 */
function taskLine(task: PartRecord, style: string): string {
	const fields = taskFields(task);
	const extra = (TASK_STYLES[style] ?? plainTaskDetail)(fields);
	return [`- [ ] ${fields.text}`, ...extra].join(' ');
}

/**
 * A checklist of tasks.
 * @param tasks - The tasks
 * @param shape - The part's settings
 */
export function renderTasks(
	tasks: readonly PartRecord[],
	shape: PartShape,
): string {
	const style = textOption(shape, 'style', 'plain');
	return limited(tasks, shape)
		.map((task) => taskLine(task, style))
		.join('\n');
}

/**
 * A list of items, each a bold lead with what follows it after a colon, as
 * decisions with their reasons and terms with their definitions are written.
 * @param records - The items
 * @param shape - The part's settings
 * @param lead - The field written in bold
 * @param detail - The field after it
 */
export function renderLeads(
	records: readonly PartRecord[],
	shape: PartShape,
	lead: string,
	detail: string,
): string {
	return limited(records, shape)
		.map((record) => {
			const head = oneLine(record[lead] ?? '');
			const rest = record[detail] ? oneLine(record[detail]) : '';
			return rest ? `- **${head}**: ${rest}` : `- **${head}**`;
		})
		.join('\n');
}

/**
 * Topics with the points under each, as a nested list.
 * @param records - The topics, each with its points as lines
 * @param shape - The part's settings
 */
export function renderOutline(
	records: readonly PartRecord[],
	shape: PartShape,
): string {
	return limited(records, shape)
		.map((record) => {
			const points = (record['points'] ?? '')
				.split('\n')
				.map((point) => oneLine(point))
				.filter((point) => point !== '')
				.map((point) => `\t- ${point}`);
			return [`- **${oneLine(record['title'] ?? '')}**`, ...points].join(
				'\n',
			);
		})
		.join('\n');
}

/**
 * The moment a quote was said, as a link where one can be written.
 * @param time - Seconds or a timecode, as the model gave it
 * @param shape - The part's settings
 */
function momentOf(time: string | undefined, shape: PartShape): string {
	const seconds =
		time === undefined
			? null
			: /^\d+(?:\.\d+)?$/.test(time)
				? Number(time)
				: parseTimecode(time);
	if (seconds === null) {
		return '';
	}
	return shape.links ? shape.links(seconds) : formatTimecode(seconds);
}

/**
 * Quotes, each in a quote block with who said it and when.
 * @param records - The quotes
 * @param shape - The part's settings
 */
export function renderQuotes(
	records: readonly PartRecord[],
	shape: PartShape,
): string {
	return limited(records, shape)
		.map((record) => {
			const source = [
				record['speaker'] ? oneLine(record['speaker']) : '',
				momentOf(record['time'], shape),
			].filter(Boolean);
			const text = quoted(oneLine(record['quote'] ?? ''));
			return source.length > 0
				? `${text}\n> - ${source.join(', ')}`
				: text;
		})
		.join('\n\n');
}

/**
 * A table with the columns the part names, one row per record.
 * @param records - The rows, by column name
 * @param shape - The part's settings
 */
export function renderTable(
	records: readonly PartRecord[],
	shape: PartShape,
): string {
	const columns = tableColumns(shape);
	const rows = limited(records, shape);
	if (columns.length === 0 || rows.length === 0) {
		return '';
	}
	const line = (cells: readonly string[]): string =>
		`| ${cells.join(' | ')} |`;
	return [
		line(columns.map(tableCell)),
		line(columns.map(() => '---')),
		...rows.map((row) =>
			line(columns.map((column) => tableCell(row[column] ?? ''))),
		),
	].join('\n');
}

/**
 * Text in a callout of the type, title and folding the part asks for.
 * @param text - The body
 * @param shape - The part's settings
 */
export function renderCallout(text: string, shape: PartShape): string {
	if (text === '') {
		return '';
	}
	const type = textOption(shape, 'type', 'note')
		.toLowerCase()
		.replace(/[^a-z-]/g, '');
	const folded = shape.options['folded'];
	const fold = folded === true ? '-' : folded === false ? '+' : '';
	const title = oneLine(textOption(shape, 'title', ''));
	const head = `> [!${type || 'note'}]${fold}${title ? ` ${title}` : ''}`;
	return `${head}\n${quoted(text)}`;
}
