/**
 * The forms a part of a note template can take.
 *
 * A format is a contract with three halves that live in one record, because
 * the halves drifting apart is the defect the record exists to prevent: how
 * the result is described to the model, how the model's answer is read and
 * repaired, and how Markdown is built from it. The model returns data, never
 * Markdown, so a table, a checklist or a list cannot come back broken: the
 * plugin writes them.
 *
 * Reading is tolerant of what models predictably do instead of what was asked,
 * because repairing an answer is cheaper than asking again and an item that
 * cannot be repaired is dropped on its own rather than taking the whole list
 * with it.
 * @module templates/partFormats
 */

/** What a part's settings say about how its result is shaped. */
export interface PartShape {
	/** Most items a list keeps; undefined for no limit. */
	readonly max?: number | undefined;
	/** Every other setting of the part, by name, as the template gave it. */
	readonly options: Readonly<Record<string, unknown>>;
}

/** One format of a part. */
export interface PartFormat {
	/** Name a template writes in `format="..."`. */
	readonly id: string;
	/** What the value is, told to the model in the prompt. */
	readonly contract: string;
	/** What the format is for, for the list of formats in the docs. */
	readonly description: string;
	/**
	 * Share of a call's output this format runs to against the transcript it
	 * reads, for the estimate before a run.
	 */
	readonly outputRatio: number;
	/** Settings besides the shared ones this format accepts. */
	readonly options: readonly string[];
	/**
	 * Reads the model's answer for the part into the format's value, repairing
	 * what can be repaired. Answers an empty value for nothing usable.
	 */
	readonly read: (answer: unknown) => readonly unknown[] | string;
	/** Builds the part's Markdown from its value. Empty for an empty value. */
	readonly render: (
		value: readonly unknown[] | string,
		shape: PartShape,
	) => string;
}

/** The format a part takes when it names none. */
export const DEFAULT_PART_FORMAT = 'prose';

/**
 * The text of an answer that should be text: a string as it is, a list joined
 * into paragraphs, anything else nothing.
 * @param answer - What the model answered for the part
 */
export function answerText(answer: unknown): string {
	if (typeof answer === 'string') {
		return answer.trim();
	}
	if (Array.isArray(answer)) {
		return answer
			.filter((item): item is string => typeof item === 'string')
			.map((item) => item.trim())
			.filter((item) => item !== '')
			.join('\n\n');
	}
	return '';
}

/** A leading list marker or checkbox a model put on a line of a list. */
const LIST_MARKER = /^\s*(?:[-*+•]|\d+[.)])?\s*(?:\[[ xX]\]\s*)?/;

/**
 * The items of an answer that should be a list of strings. A string is split
 * into lines with their list markers taken off; a single object or number is
 * one item; anything that is not text after that is dropped item by item.
 * @param answer - What the model answered for the part
 */
export function answerItems(answer: unknown): string[] {
	const raw = Array.isArray(answer)
		? answer
		: typeof answer === 'string'
			? answer.split('\n')
			: [answer];
	return raw
		.map((item) => itemText(item))
		.map((item) => item.replace(LIST_MARKER, '').trim())
		.filter((item) => item !== '');
}

/**
 * The text of one list item. A number reads as its digits; an object reads as
 * its first text field, which is what a model that wrapped each item in
 * `{ "text": ... }` meant.
 * @param item - One element of the answer
 */
function itemText(item: unknown): string {
	if (typeof item === 'string') {
		return item;
	}
	if (typeof item === 'number') {
		return String(item);
	}
	if (typeof item === 'object' && item !== null) {
		const first = Object.values(item).find(
			(value): value is string => typeof value === 'string',
		);
		return first ?? '';
	}
	return '';
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

/** Every format, by the name a template writes. */
const FORMATS: readonly PartFormat[] = [
	{
		id: 'prose',
		contract: 'a string of Markdown paragraphs',
		description: 'Paragraphs of text, as they come back.',
		outputRatio: 0.15,
		options: [],
		read: answerText,
		render: (value) => (typeof value === 'string' ? value : ''),
	},
	{
		id: 'bullets',
		contract: 'an array of strings, one per point, without list markers',
		description: 'A bulleted list.',
		outputRatio: 0.08,
		options: [],
		read: answerItems,
		render: (value, shape) =>
			Array.isArray(value)
				? limited(value as readonly string[], shape)
						.map((item) => `- ${item}`)
						.join('\n')
				: '',
	},
];

/**
 * The format a template names, or undefined for a name no format has.
 * @param id - The name from `format="..."`
 */
export function partFormat(id: string): PartFormat | undefined {
	return FORMATS.find((format) => format.id === id);
}

/** Every format, in the order the docs list them. */
export function partFormats(): readonly PartFormat[] {
	return FORMATS;
}
