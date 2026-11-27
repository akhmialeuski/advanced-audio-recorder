/**
 * Reading a model's answer for a part into the value its format writes.
 *
 * Reading is tolerant of what models predictably do instead of what was asked,
 * because repairing an answer is cheaper than asking again: a list sent as one
 * string of lines, items wrapped in objects, list markers left on. An item
 * that cannot be repaired is dropped on its own rather than taking the whole
 * list with it. Every text read here has its wiki links neutralized, so what a
 * model wrote never links a note.
 * @module templates/partReaders
 */

import { neutralizeLinks } from './markdownSafety';

/** One item of a list of records, by field name. */
export type PartRecord = Readonly<Record<string, string>>;

/**
 * Text a model wrote, trimmed and with its links neutralized.
 * @param text - The text
 */
function clean(text: string): string {
	return neutralizeLinks(text.trim());
}

/**
 * The text of an answer that should be text: a string as it is, a list joined
 * into paragraphs, anything else nothing.
 * @param answer - What the model answered for the part
 */
export function answerText(answer: unknown): string {
	if (typeof answer === 'string') {
		return clean(answer);
	}
	if (Array.isArray(answer)) {
		return answer
			.filter((item): item is string => typeof item === 'string')
			.map(clean)
			.filter((item) => item !== '')
			.join('\n\n');
	}
	return '';
}

/** A leading list marker or checkbox a model put on a line of a list. */
const LIST_MARKER = /^\s*(?:[-*+•]|\d+[.)])?\s*(?:\[[ xX]\]\s*)?/;

/**
 * The elements of an answer that should be a list: a list as it is, a string
 * split into its lines, anything else one element.
 * @param answer - What the model answered for the part
 */
function elements(answer: unknown): readonly unknown[] {
	if (Array.isArray(answer)) {
		return answer;
	}
	return typeof answer === 'string' ? answer.split('\n') : [answer];
}

/**
 * Text from one value: a string as it is, a number as its digits, anything
 * else nothing.
 * @param value - One value of the answer
 */
function scalarText(value: unknown): string {
	if (typeof value === 'string') {
		return value;
	}
	return typeof value === 'number' && Number.isFinite(value)
		? String(value)
		: '';
}

/**
 * Text from one field of a record: a list of texts reads as one per line.
 * @param value - The field's value
 */
function fieldText(value: unknown): string {
	return Array.isArray(value)
		? value.map(scalarText).filter(Boolean).join('\n')
		: scalarText(value);
}

/**
 * The text of one list item. An object reads as its first text field, which
 * is what a model that wrapped each item in `{ "text": ... }` meant.
 * @param item - One element of the answer
 */
function itemText(item: unknown): string {
	if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
		return (
			Object.values(item).find(
				(value): value is string => typeof value === 'string',
			) ?? ''
		);
	}
	return scalarText(item);
}

/**
 * The items of an answer that should be a list of strings, with list markers
 * a model left on taken off.
 * @param answer - What the model answered for the part
 */
export function answerItems(answer: unknown): string[] {
	return elements(answer)
		.map((item) => clean(itemText(item).replace(LIST_MARKER, '')))
		.filter((item) => item !== '');
}

/**
 * A field name as compared: case and anything but letters and digits ignored,
 * so `Due date`, `due_date` and `dueDate` are one field.
 * @param name - The name
 */
function fieldKey(name: string): string {
	return name.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

/**
 * One record of a list, with the fields asked for.
 * @param item - One element of the answer
 * @param fields - The fields of a record, the main one first
 * @returns The record, or undefined when it has no main field
 */
function recordOf(
	item: unknown,
	fields: readonly string[],
): PartRecord | undefined {
	const [main] = fields;
	if (main === undefined) {
		return undefined;
	}
	if (typeof item !== 'object' || item === null || Array.isArray(item)) {
		const text = clean(scalarText(item).replace(LIST_MARKER, ''));
		return text === '' ? undefined : { [main]: text };
	}
	return objectRecord(item, fields, main);
}

/**
 * One record read from an object, its fields matched by name.
 * @param item - The object
 * @param fields - The fields of a record, the main one first
 * @param main - The main field
 * @returns The record, or undefined when it has no main field
 */
function objectRecord(
	item: object,
	fields: readonly string[],
	main: string,
): PartRecord | undefined {
	const byKey = new Map(
		Object.entries(item).map(([key, value]) => [fieldKey(key), value]),
	);
	const record = Object.fromEntries(
		fields
			.map((field) => [
				field,
				clean(fieldText(byKey.get(fieldKey(field)))),
			])
			.filter(([, value]) => value !== ''),
	) as Record<string, string>;
	// A model that named the main field otherwise, `task` for `text`, meant
	// its first text field that is none of the others.
	const known = new Set(fields.map(fieldKey));
	record[main] ??= clean(
		scalarText(
			[...byKey].find(
				([key, value]) => !known.has(key) && typeof value === 'string',
			)?.[1],
		),
	);
	return record[main] === '' ? undefined : record;
}

/**
 * The records of an answer that should be a list of objects. An item given as
 * plain text is a record with only its main field; a field is matched by name
 * whatever its case or spelling; a record without its main field is dropped.
 * @param answer - What the model answered for the part
 * @param fields - The fields of a record, the main one first
 */
export function answerRecords(
	answer: unknown,
	fields: readonly string[],
): PartRecord[] {
	return elements(answer)
		.map((item) => recordOf(item, fields))
		.filter((record): record is PartRecord => record !== undefined);
}
