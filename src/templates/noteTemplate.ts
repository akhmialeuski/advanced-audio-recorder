/**
 * A note template: a Markdown text with parts a model fills.
 *
 * A part is a block, `{{#part "actions" format="bullets" max=5}}instruction{{/part}}`,
 * standing where its result goes in the note. Its settings are the arguments of
 * the block and its body is the instruction for the model, rendered with the
 * facts of the run, so an instruction can name the meeting and its people.
 * `profile="Action items"` takes the instruction from a named prompt profile
 * instead, which is how one instruction serves several templates.
 *
 * A template is rendered twice. The first render only collects the parts, as
 * the run's facts make them, so a part inside `{{#if participants}}` is asked
 * for only when there are participants. The second writes the note, with each
 * part's result in its place and in `{{parts.name}}` for a condition or a
 * second mention elsewhere.
 * @module templates/noteTemplate
 */

import type { HelperDelegate, HelperOptions } from 'handlebars';
import { RUN_VARIABLES } from './runVariables';
import type { TemplateCatalog } from './templateCatalog';
import type { TemplateHelper } from './templateHelpers';
import {
	type TemplateContext,
	TemplateEngine,
	TemplateRenderError,
} from './TemplateEngine';
import { DEFAULT_PART_FORMAT } from './partFormats';

/** Name of the block that declares a part. */
export const PART_HELPER = 'part';

/** The root a template reads results of parts under, e.g. `parts.summary`. */
export const PARTS_ROOT = 'parts';

/** What a part does when the model found nothing for it. */
export const EmptyPart = {
	/** Drop the part, and the heading right above it when that is all it held. */
	Remove: 'remove',
	/** Leave the place empty, heading and all. */
	Keep: 'keep',
} as const;

/** Settings every part accepts, whatever its format. */
export const SHARED_PART_OPTIONS: readonly string[] = [
	'format',
	'profile',
	'max',
	'empty',
	'language',
	'separate',
];

/** One part of a template, as the run's facts made it. */
export interface PartSpec {
	/** Name of the part, unique in its template; the key of its result. */
	readonly name: string;
	/** The instruction written in the block, rendered; '' when it names a profile. */
	readonly instruction: string;
	/** Name of the prompt profile the instruction is taken from, if any. */
	readonly profile?: string | undefined;
	/** Name of the part's format. */
	readonly format: string;
	/** Most items a list keeps. */
	readonly max?: number | undefined;
	/** `remove`, `keep`, or the text written when nothing was found. */
	readonly empty: string;
	/** Language the part is written in, when it differs from the note's. */
	readonly language?: string | undefined;
	/** Whether the part is asked for in a call of its own. */
	readonly separate: boolean;
	/** Every setting of the part, by name, as the template gave it. */
	readonly options: Readonly<Record<string, unknown>>;
}

/**
 * Everything a note template can name: the facts of the run, the transcript
 * and the results of its parts.
 */
export const NOTE_TEMPLATE_VARIABLES: TemplateCatalog = [
	...RUN_VARIABLES,
	{
		name: 'transcript',
		description: 'The transcript, written the way the note writes it.',
		example: '{{transcript}}',
	},
	{
		name: PARTS_ROOT,
		description:
			'Results of the parts, by name, e.g. parts.summary; empty for a part the model found nothing for.',
		example: '{{#if parts.actions}}...{{/if}}',
		open: true,
	},
];

/**
 * The declaration of the part block, which the variable list shows. A run
 * replaces its function for each of its two renders, so the one registered
 * here only stands for the block outside a run, where it writes nothing.
 */
const PART_DECLARATION: TemplateHelper = {
	name: PART_HELPER,
	description:
		'A section a model fills from the transcript. The body is the instruction; settings: format (prose, bullets, numbered, tasks, decisions, terms, outline, quotes, table, callout), max, empty="remove|keep|text", profile, language, separate.',
	example:
		'{{#part "summary" format="bullets" max=3}}The three things that matter.{{/part}}',
	fn: () => '',
};

/** The engine note templates render with, built on first use. */
let engine: TemplateEngine | undefined;

/** The engine with the part block, shared by every note template. */
export function noteTemplateEngine(): TemplateEngine {
	engine ??= new TemplateEngine([PART_DECLARATION]);
	return engine;
}

/** Marks the place of a part that is removed with its heading. */
const REMOVED = '\u0000aar-removed-part\u0000';

/** A Markdown heading line. */
const HEADING = /^(#{1,6})\s/;

/**
 * The hash arguments of one call of the part block.
 * @param args - What the helper received
 */
function partCall(args: readonly unknown[]): {
	readonly name: unknown;
	readonly options: HelperOptions;
} {
	return {
		name: args.length > 1 ? args[0] : undefined,
		options: args[args.length - 1] as HelperOptions,
	};
}

/**
 * Reads a setting given as text.
 * @param value - The setting as the template gave it
 */
function textSetting(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() !== ''
		? value.trim()
		: undefined;
}

/**
 * Reads the most items a list keeps: a whole number above zero, else none.
 * @param value - The setting as the template gave it
 */
function maxSetting(value: unknown): number | undefined {
	const max = typeof value === 'string' ? Number(value) : value;
	return typeof max === 'number' && Number.isInteger(max) && max > 0
		? max
		: undefined;
}

/**
 * One part as a call of its block describes it.
 * @param name - Its name
 * @param hash - Its settings
 * @param body - Its instruction, rendered
 */
function partSpec(
	name: string,
	hash: Readonly<Record<string, unknown>>,
	body: string,
): PartSpec {
	return {
		name,
		instruction: body.trim(),
		profile: textSetting(hash['profile']),
		format: textSetting(hash['format']) ?? DEFAULT_PART_FORMAT,
		max: maxSetting(hash['max']),
		empty:
			typeof hash['empty'] === 'string'
				? hash['empty']
				: EmptyPart.Remove,
		language: textSetting(hash['language']),
		separate: hash['separate'] === true,
		options: { ...hash },
	};
}

/**
 * The parts a template asks for, as the facts of the run make them.
 * @param source - The template
 * @param context - The facts it renders with
 * @returns The parts in the order they stand in the note
 * @throws TemplateRenderError when the template cannot be rendered, a part has
 *   no name, or two parts share one
 */
export function collectParts(
	source: string,
	context: TemplateContext,
): PartSpec[] {
	const found: PartSpec[] = [];
	const part: HelperDelegate = function (this: unknown, ...args: unknown[]) {
		const { name, options } = partCall(args);
		if (typeof name !== 'string' || name.trim() === '') {
			throw new TemplateRenderError(
				'A part needs a name, e.g. {{#part "summary"}}.',
			);
		}
		if (found.some((spec) => spec.name === name)) {
			throw new TemplateRenderError(
				`Two parts are named "${name}"; each needs a name of its own.`,
			);
		}
		const body = typeof options.fn === 'function' ? options.fn(this) : '';
		found.push(
			partSpec(name, options.hash as Record<string, unknown>, body),
		);
		return '';
	};
	noteTemplateEngine().render(
		source,
		{ ...context, [PARTS_ROOT]: {} },
		NOTE_TEMPLATE_VARIABLES,
		{ [PART_HELPER]: part },
	);
	return found;
}

/**
 * What a part writes in its place.
 * @param result - Its result, '' for nothing found
 * @param empty - What it does with nothing found
 */
function partOutput(result: string, empty: unknown): string {
	if (result !== '') {
		return result;
	}
	if (empty === undefined || empty === EmptyPart.Remove) {
		return REMOVED;
	}
	return empty === EmptyPart.Keep || typeof empty !== 'string' ? '' : empty;
}

/**
 * Writes the note: the template with each part's result in its place.
 * @param source - The template
 * @param context - The facts it renders with
 * @param results - The Markdown of each part, by name; '' for nothing found
 * @returns The note's Markdown
 */
export function assembleNote(
	source: string,
	context: TemplateContext,
	results: ReadonlyMap<string, string>,
): string {
	const part: HelperDelegate = (...args: unknown[]) => {
		const { name, options } = partCall(args);
		const result =
			typeof name === 'string' ? (results.get(name) ?? '') : '';
		return partOutput(
			result,
			(options.hash as Record<string, unknown>)['empty'],
		);
	};
	const rendered = noteTemplateEngine().render(
		source,
		{ ...context, [PARTS_ROOT]: Object.fromEntries(results) },
		NOTE_TEMPLATE_VARIABLES,
		{ [PART_HELPER]: part },
	);
	return removeEmptySections(rendered);
}

/**
 * Takes out the parts removed for having nothing in them, with the heading
 * right above one when the part was all its section held, so a meeting without
 * blockers has no empty "Blockers" heading.
 * @param text - The rendered note, with removed parts marked
 * @returns The note without them, blank lines collapsed
 */
export function removeEmptySections(text: string): string {
	const lines: (string | null)[] = text.split('\n');
	lines.forEach((line, index) => {
		if (line === null || !line.includes(REMOVED)) {
			return;
		}
		if (line.trim() !== REMOVED) {
			lines[index] = line.split(REMOVED).join('');
			return;
		}
		lines[index] = null;
		dropEmptyHeadingAbove(lines, index);
	});
	return lines
		.filter((line): line is string => line !== null)
		.join('\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

/**
 * The level of a heading line, or 0 for a line that is not a heading.
 * @param line - A line of the note, null for one removed
 */
function headingLevel(line: string | null | undefined): number {
	return HEADING.exec(line ?? '')?.[1]?.length ?? 0;
}

/**
 * Whether a line holds nothing a reader sees: blank, removed, or a removed
 * part's mark.
 * @param line - A line of the note, null for one removed
 */
function isVacant(line: string | null | undefined): boolean {
	return (line ?? '').split(REMOVED).join('').trim() === '';
}

/**
 * Drops the heading above a removed part when nothing else is in its section:
 * no text between the heading and the part, and none after the part before the
 * next heading of the same or a higher level.
 * @param lines - The note's lines, removed ones as null
 * @param index - Where the removed part stood
 */
function dropEmptyHeadingAbove(lines: (string | null)[], index: number): void {
	let above = index - 1;
	while (above >= 0 && isVacant(lines[above])) {
		above -= 1;
	}
	const level = headingLevel(lines[above]);
	if (level === 0) {
		return;
	}
	for (let below = index + 1; below < lines.length; below += 1) {
		const line = lines[below];
		const next = headingLevel(line);
		if (next > 0 && next <= level) {
			break;
		}
		if (!isVacant(line)) {
			return;
		}
	}
	lines[above] = null;
}
