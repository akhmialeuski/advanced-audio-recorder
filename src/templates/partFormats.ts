/**
 * The forms a part of a note template can take.
 *
 * A format is a contract with three halves that live in one record, because
 * the halves drifting apart is the defect the record exists to prevent: how
 * the result is described to the model, how the model's answer is read and
 * repaired ({@link module:templates/partReaders}), and how Markdown is built
 * from it ({@link module:templates/partRenderers}). The model returns data,
 * never Markdown, so a table, a checklist or a list cannot come back broken:
 * the plugin writes them.
 * @module templates/partFormats
 */

import {
	type PartRecord,
	answerItems,
	answerRecords,
	answerText,
} from './partReaders';
import {
	type PartShape,
	listOf,
	renderCallout,
	renderLeads,
	renderOutline,
	renderQuotes,
	renderTable,
	renderTasks,
	tableColumns,
} from './partRenderers';

export type { PartShape } from './partRenderers';

/** The value a format reads an answer into: text, or a list. */
export type PartValue = string | readonly unknown[];

/** One format of a part. */
export interface PartFormat {
	/** Name a template writes in `format="..."`. */
	readonly id: string;
	/** What the value is, told to the model in the prompt. */
	readonly contract: (shape: PartShape) => string;
	/** What the format is for, for the list of formats. */
	readonly description: string;
	/**
	 * Share of a call's output this format runs to against the transcript it
	 * reads, for the estimate before a run.
	 */
	readonly outputRatio: number;
	/** Settings besides the shared ones this format accepts. */
	readonly options: readonly string[];
	/**
	 * What is wrong with the settings of a part in this format, checked as
	 * the template is typed.
	 * @param options - The part's settings
	 * @returns A sentence per problem, after the part's name
	 */
	readonly check?: (options: Readonly<Record<string, unknown>>) => string[];
	/**
	 * Reads the model's answer for the part into the format's value, repairing
	 * what can be repaired. Answers an empty value for nothing usable.
	 */
	readonly read: (answer: unknown, shape: PartShape) => PartValue;
	/** Builds the part's Markdown from its value. Empty for an empty value. */
	readonly render: (value: PartValue, shape: PartShape) => string;
}

/** The styles a checklist of tasks is written in. */
const TASK_STYLE_NAMES: readonly unknown[] = ['plain', 'dataview', 'tasks'];

/** The format a part takes when it names none. */
export const DEFAULT_PART_FORMAT = 'prose';

/**
 * A value as text, '' for a list.
 * @param value - The value
 */
function asText(value: PartValue): string {
	return typeof value === 'string' ? value : '';
}

/**
 * A value as a list of strings, none for text.
 * @param value - The value
 */
function asItems(value: PartValue): readonly string[] {
	return Array.isArray(value) ? (value as readonly string[]) : [];
}

/**
 * A value as a list of records, none for text.
 * @param value - The value
 */
function asRecords(value: PartValue): readonly PartRecord[] {
	return Array.isArray(value) ? (value as readonly PartRecord[]) : [];
}

/**
 * The JSON shape of a list of objects, for a contract.
 * @param fields - The fields, each with what it holds
 */
function objects(fields: readonly (readonly [string, string])[]): string {
	return `an array of objects, one per item, with ${fields
		.map(([name, what]) => `"${name}" (${what})`)
		.join(', ')}`;
}

/** A format that reads a list of records and writes it one way. */
function recordFormat(
	spec: Omit<PartFormat, 'read' | 'render' | 'contract'> & {
		readonly fields: readonly (readonly [string, string])[];
		readonly write: (
			records: readonly PartRecord[],
			shape: PartShape,
		) => string;
	},
): PartFormat {
	const names = spec.fields.map(([name]) => name);
	const { fields, write, ...rest } = spec;
	return {
		...rest,
		contract: () => objects(fields),
		read: (answer) => answerRecords(answer, names),
		render: (value, shape) => write(asRecords(value), shape),
	};
}

/** Paragraphs of text, the format a part takes when it names none. */
const PROSE: PartFormat = {
	id: 'prose',
	contract: () => 'a string of Markdown paragraphs',
	description: 'Paragraphs of text.',
	outputRatio: 0.15,
	options: [],
	read: answerText,
	render: asText,
};

/** Every format, in the order the list of formats shows them. */
const FORMATS: readonly PartFormat[] = [
	PROSE,
	{
		id: 'bullets',
		contract: () =>
			'an array of strings, one per point, without list markers',
		description: 'A bulleted list.',
		outputRatio: 0.08,
		options: [],
		read: answerItems,
		render: (value, shape) => listOf(asItems(value), shape, () => '-'),
	},
	{
		id: 'numbered',
		contract: () =>
			'an array of strings, one per step, in order, without numbers',
		description: 'A numbered list, for steps in order.',
		outputRatio: 0.08,
		options: [],
		read: answerItems,
		render: (value, shape) =>
			listOf(asItems(value), shape, (index) => `${String(index + 1)}.`),
	},
	recordFormat({
		id: 'tasks',
		fields: [
			['text', 'what is to be done, starting with a verb'],
			['owner', 'who does it, as named in the transcript, or ""'],
			[
				'due',
				'the date it is due as YYYY-MM-DD, or "" when none was said',
			],
		],
		description:
			'A checklist of action items with owner and due date; style="dataview" writes them as Dataview fields, style="tasks" as the Tasks plugin reads them.',
		outputRatio: 0.06,
		options: ['style'],
		check: (options) =>
			options['style'] === undefined ||
			TASK_STYLE_NAMES.includes(options['style'])
				? []
				: ['needs style to be plain, dataview or tasks.'],
		write: renderTasks,
	}),
	recordFormat({
		id: 'decisions',
		fields: [
			['decision', 'what was decided'],
			['reason', 'why, when the transcript says, or ""'],
		],
		description: 'Decisions, each with its reason.',
		outputRatio: 0.05,
		options: [],
		write: (records, shape) =>
			renderLeads(records, shape, 'decision', 'reason'),
	}),
	recordFormat({
		id: 'terms',
		fields: [
			['term', 'a name, term or acronym used in the recording'],
			['definition', 'what it means there, in one sentence'],
		],
		description: 'A glossary of the terms used, each with its meaning.',
		outputRatio: 0.05,
		options: [],
		write: (records, shape) =>
			renderLeads(records, shape, 'term', 'definition'),
	}),
	recordFormat({
		id: 'outline',
		fields: [
			['title', 'a topic, in a few words'],
			['points', 'an array of strings, the points made about it'],
		],
		description: 'The topics discussed, each with its points.',
		outputRatio: 0.1,
		options: [],
		write: renderOutline,
	}),
	recordFormat({
		id: 'quotes',
		fields: [
			['quote', 'the words exactly as said'],
			['speaker', 'who said them, or ""'],
			['time', 'when, as the [m:ss] timestamp of the line, or ""'],
		],
		description:
			'Quotes as said, each with who said it and a link to the moment.',
		outputRatio: 0.05,
		options: [],
		write: renderQuotes,
	}),
	{
		id: 'table',
		contract: (shape) =>
			objects(
				tableColumns(shape).map(
					(column) => [column, 'a short text'] as const,
				),
			),
		description: 'A table with the columns columns="A, B, C" names.',
		outputRatio: 0.08,
		options: ['columns'],
		check: (options) =>
			typeof options['columns'] === 'string' &&
			options['columns'].trim() !== ''
				? []
				: ['needs its columns, e.g. columns="Owner, Task, Due".'],
		read: (answer, shape) => answerRecords(answer, tableColumns(shape)),
		render: (value, shape) => renderTable(asRecords(value), shape),
	},
	{
		id: 'callout',
		contract: () => 'a string of Markdown paragraphs',
		description:
			'Paragraphs in a callout; type="tip" picks its kind, title="..." its title, folded=true folds it.',
		outputRatio: 0.15,
		options: ['type', 'title', 'folded'],
		read: answerText,
		render: (value, shape) => renderCallout(asText(value), shape),
	},
];

/**
 * The format a template names, or undefined for a name no format has.
 * @param id - The name from `format="..."`
 */
export function partFormat(id: string): PartFormat | undefined {
	return FORMATS.find((format) => format.id === id);
}

/**
 * The format a part is written in: the one it names, or prose for a name no
 * format has, which the check of the template has already reported.
 * @param id - The name from `format="..."`
 */
export function formatOf(id: string): PartFormat {
	return partFormat(id) ?? PROSE;
}

/** Every format, in the order the list of formats shows them. */
export function partFormats(): readonly PartFormat[] {
	return FORMATS;
}
