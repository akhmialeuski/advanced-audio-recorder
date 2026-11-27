/**
 * What a note template declares, read without running it.
 *
 * The settings check a template as it is typed, and the cost estimate needs to
 * know how many calls a template makes before a run starts. Both read the
 * parts off the parsed template, every one of them, including a part inside a
 * condition that a given run may skip: a check has to cover every branch, and
 * an estimate errs towards the dearer one.
 * @module templates/noteTemplateCheck
 */

import type {
	AstBlock,
	AstBooleanLiteral,
	AstContent,
	AstExpression,
	AstMustache,
	AstNode,
	AstNumberLiteral,
	AstPath,
	AstProgram,
	AstStatement,
	AstStringLiteral,
} from './handlebarsAst';
import {
	type TemplateProblem,
	TemplateProblemSeverity,
	locationOf,
} from './templateAnalysis';
import { collectPaths } from './templatePaths';
import { normalizeCoreSyntax } from './templateSyntax';
import {
	NOTE_TEMPLATE_VARIABLES,
	PART_HELPER,
	PARTS_ROOT,
	SHARED_PART_OPTIONS,
	noteTemplateEngine,
} from './noteTemplate';
import { DEFAULT_PART_FORMAT, partFormat, partFormats } from './partFormats';

/** One part as the template text declares it. */
export interface DeclaredPart {
	/** Its name, or undefined when it is not written as text. */
	readonly name: string | undefined;
	/** Its format's name, the default when none is given. */
	readonly format: string;
	/** Whether it asks for a call of its own. */
	readonly separate: boolean;
	/** The prompt profile it names, if any. */
	readonly profile: string | undefined;
	/** Whether its block has an instruction in it. */
	readonly hasInstruction: boolean;
	/** The part's own node, for where a problem is. */
	readonly node: AstBlock | AstMustache;
	/** Whether it stands inside a block that repeats, or another part. */
	readonly nested: 'each' | 'part' | undefined;
}

/** What it takes to fill a template, for the estimate before a run. */
export interface NoteTemplatePlan {
	/** Calls to the model the run makes. */
	readonly calls: number;
	/** Share of a call's output against the transcript, summed over parts. */
	readonly outputRatio: number;
}

/** Share of output a part of a format nobody knows is counted at. */
const PROSE_RATIO = partFormat(DEFAULT_PART_FORMAT)?.outputRatio ?? 0;

/** Blocks that write their body more than once. */
const REPEATING_BLOCKS: ReadonlySet<string> = new Set(['each']);

/**
 * The value of a literal argument, or undefined for anything else.
 * @param value - The argument
 */
function literal(value: AstExpression | undefined): unknown {
	switch (value?.type) {
		case 'StringLiteral':
			return (value as AstStringLiteral).value;
		case 'NumberLiteral':
			return (value as AstNumberLiteral).value;
		case 'BooleanLiteral':
			return (value as AstBooleanLiteral).value;
		default:
			return undefined;
	}
}

/**
 * One setting of a call, as its node.
 * @param node - The call
 * @param key - The setting's name
 */
function setting(
	node: AstBlock | AstMustache,
	key: string,
): AstExpression | undefined {
	return node.hash?.pairs.find((pair) => pair.key === key)?.value;
}

/**
 * Whether a call is the part block.
 * @param node - A mustache or block
 */
function isPart(node: AstBlock | AstMustache): boolean {
	const path = node.path as AstPath;
	return (
		path.type === 'PathExpression' &&
		!path.data &&
		path.parts.length === 1 &&
		path.original === PART_HELPER
	);
}

/**
 * Whether a block has an instruction in it: anything but blank text.
 * @param program - The block's body, if it has one
 */
function hasInstruction(program: AstProgram | undefined): boolean {
	return (program?.body ?? []).some(
		(statement) =>
			statement.type !== 'ContentStatement' ||
			(statement as AstContent).value.trim() !== '',
	);
}

/**
 * The value of a setting given as text, or undefined for anything else.
 * @param node - The call
 * @param key - The setting's name
 */
function textOf(node: AstBlock | AstMustache, key: string): string | undefined {
	const value = literal(setting(node, key));
	return typeof value === 'string' ? value : undefined;
}

/**
 * A part as its node declares it.
 * @param node - The part's block or mustache
 * @param nested - What it stands inside
 */
function declaredPart(
	node: AstBlock | AstMustache,
	nested: DeclaredPart['nested'],
): DeclaredPart {
	const name = literal(node.params[0]);
	return {
		name: typeof name === 'string' ? name : undefined,
		format: textOf(node, 'format') ?? DEFAULT_PART_FORMAT,
		separate: literal(setting(node, 'separate')) === true,
		profile: textOf(node, 'profile'),
		hasInstruction: hasInstruction(
			'program' in node ? node.program : undefined,
		),
		node,
		nested,
	};
}

/**
 * What a block's body stands inside: a part, a repeat, or what the block does.
 * @param block - The block
 * @param nested - What the block stands inside
 */
function innerNesting(
	block: AstBlock,
	nested: DeclaredPart['nested'],
): DeclaredPart['nested'] {
	if (isPart(block)) {
		return 'part';
	}
	return REPEATING_BLOCKS.has(block.path.original) ? 'each' : nested;
}

/**
 * The parts one statement declares, its own and those inside it.
 * @param statement - A statement of a program
 * @param nested - What it stands inside
 * @param found - Where the parts are collected
 */
function partsOf(
	statement: AstStatement,
	nested: DeclaredPart['nested'],
	found: DeclaredPart[],
): void {
	if (
		statement.type !== 'MustacheStatement' &&
		statement.type !== 'BlockStatement'
	) {
		return;
	}
	const call = statement as AstBlock | AstMustache;
	if (isPart(call)) {
		found.push(declaredPart(call, nested));
	}
	if (statement.type === 'BlockStatement') {
		const block = statement as AstBlock;
		partsIn(block.program, innerNesting(block, nested), found);
		partsIn(block.inverse, nested, found);
	}
}

/**
 * Every part a parsed template declares, in the order they stand.
 * @param program - The parsed template
 * @param nested - What the program stands inside
 * @param found - Where the parts are collected
 */
function partsIn(
	program: AstProgram | undefined,
	nested: DeclaredPart['nested'],
	found: DeclaredPart[],
): void {
	for (const statement of program?.body ?? []) {
		partsOf(statement, nested, found);
	}
}

/**
 * The parts a template declares.
 * @param source - The template
 * @returns The parts, or none when the template cannot be parsed
 */
export function declaredParts(source: string): DeclaredPart[] {
	const program = parse(source);
	const found: DeclaredPart[] = [];
	partsIn(program, undefined, found);
	return found;
}

/**
 * The parsed template, or undefined when it does not parse.
 * @param source - The template
 */
function parse(source: string): AstProgram | undefined {
	try {
		return noteTemplateEngine().parse(normalizeCoreSyntax(source));
	} catch {
		return undefined;
	}
}

/**
 * How many calls a template makes and how much they write.
 * @param source - The template
 */
export function planNoteTemplate(source: string): NoteTemplatePlan {
	const parts = declaredParts(source);
	const separate = parts.filter((part) => part.separate).length;
	const shared = parts.length - separate > 0 ? 1 : 0;
	const outputRatio = parts.reduce(
		(sum, part) =>
			sum + (partFormat(part.format)?.outputRatio ?? PROSE_RATIO),
		0,
	);
	return { calls: separate + shared, outputRatio };
}

/** A problem of the template, at a node. */
function problem(
	severity: TemplateProblemSeverity,
	node: AstNode,
	message: string,
): TemplateProblem {
	return { severity, message, location: locationOf(node) };
}

/** Makes an error at a part. */
type PartError = (message: string) => TemplateProblem;

/**
 * What is wrong with the settings of one part.
 * @param part - The part
 * @param isProfile - Whether a prompt profile of a name exists
 */
function partProblems(
	part: DeclaredPart,
	isProfile: (name: string) => boolean,
): TemplateProblem[] {
	const error: PartError = (message) =>
		problem(TemplateProblemSeverity.Error, part.node, message);
	const label = part.name === undefined ? 'A part' : `Part "${part.name}"`;
	return [
		...placementProblems(part, label, error),
		...formatProblems(part, label, error),
		...maxProblems(part, label, error),
		...instructionProblems(part, label, error),
		...profileProblems(part, label, isProfile),
	];
}

/**
 * A part without a name, or standing where it cannot.
 * @param part - The part
 * @param label - How problems name it
 * @param error - Makes an error at the part
 */
function placementProblems(
	part: DeclaredPart,
	label: string,
	error: PartError,
): TemplateProblem[] {
	const where = {
		each: `${label} cannot stand inside a repeat.`,
		part: `${label} cannot stand inside another part.`,
	};
	return [
		...(part.name === undefined
			? [
					error(
						'A part needs a name in quotes, e.g. {{#part "summary"}}.',
					),
				]
			: []),
		...(part.nested === undefined ? [] : [error(where[part.nested])]),
	];
}

/**
 * An unknown format, or a setting neither every part nor its format takes.
 * @param part - The part
 * @param label - How problems name it
 * @param error - Makes an error at the part
 */
function formatProblems(
	part: DeclaredPart,
	label: string,
	error: PartError,
): TemplateProblem[] {
	const format = partFormat(part.format);
	const known = new Set([...SHARED_PART_OPTIONS, ...(format?.options ?? [])]);
	const names = partFormats()
		.map((each) => each.id)
		.join(', ');
	return [
		...(format
			? []
			: [
					error(
						`${label} has an unknown format "${part.format}"; use one of ${names}.`,
					),
				]),
		...(part.node.hash?.pairs ?? [])
			.filter((pair) => !known.has(pair.key))
			.map((pair) =>
				error(`${label} has an unknown setting "${pair.key}".`),
			),
	];
}

/**
 * A most-items setting that is not a whole number above zero.
 * @param part - The part
 * @param label - How problems name it
 * @param error - Makes an error at the part
 */
function maxProblems(
	part: DeclaredPart,
	label: string,
	error: PartError,
): TemplateProblem[] {
	const max = setting(part.node, 'max');
	if (max === undefined) {
		return [];
	}
	const value = literal(max);
	const whole = typeof value === 'number' && Number.isInteger(value);
	return whole && value > 0
		? []
		: [error(`${label} needs max to be a whole number, e.g. max=5.`)];
}

/**
 * A part with both an instruction and a profile, or with neither.
 * @param part - The part
 * @param label - How problems name it
 * @param error - Makes an error at the part
 */
function instructionProblems(
	part: DeclaredPart,
	label: string,
	error: PartError,
): TemplateProblem[] {
	if (part.profile !== undefined && part.hasInstruction) {
		return [
			error(
				`${label} has both an instruction and profile="${part.profile}"; keep one.`,
			),
		];
	}
	if (part.profile === undefined && !part.hasInstruction) {
		return [
			error(
				`${label} has no instruction; write one inside the block or name a profile.`,
			),
		];
	}
	return [];
}

/**
 * A profile named that no prompt profile is called.
 * @param part - The part
 * @param label - How problems name it
 * @param isProfile - Whether a prompt profile of a name exists
 */
function profileProblems(
	part: DeclaredPart,
	label: string,
	isProfile: (name: string) => boolean,
): TemplateProblem[] {
	if (part.profile === undefined || isProfile(part.profile)) {
		return [];
	}
	return [
		problem(
			TemplateProblemSeverity.Warning,
			part.node,
			`${label} names the profile "${part.profile}", which no cleanup, summary or custom prompt profile is called.`,
		),
	];
}

/**
 * Warnings for `{{parts.name}}` naming no part of the template.
 * @param program - The parsed template
 * @param names - The names the template's parts have
 */
function partReferenceProblems(
	program: AstProgram,
	names: ReadonlySet<string>,
): TemplateProblem[] {
	return collectPaths(program).flatMap((path) => {
		const segments =
			path.data && path.parts[0] === 'root'
				? path.parts.slice(1)
				: path.parts;
		const [root, name] = segments;
		if (root !== PARTS_ROOT || name === undefined || names.has(name)) {
			return [];
		}
		return [
			problem(
				TemplateProblemSeverity.Warning,
				path,
				`No part is named "${name}".`,
			),
		];
	});
}

/**
 * Checks a note template without running it: the syntax and the names it
 * uses, then every part's settings.
 * @param source - The template
 * @param isProfile - Whether a prompt profile of a name exists
 * @returns Every problem found, in the order of the text
 */
export function checkNoteTemplate(
	source: string,
	isProfile: (name: string) => boolean,
): TemplateProblem[] {
	const problems = [
		...noteTemplateEngine().validate(source, NOTE_TEMPLATE_VARIABLES),
	];
	const program = parse(source);
	if (!program) {
		return problems;
	}
	const parts: DeclaredPart[] = [];
	partsIn(program, undefined, parts);
	if (parts.length === 0) {
		problems.push({
			severity: TemplateProblemSeverity.Warning,
			message:
				'The template has no parts, so no model is asked; add one with {{#part "summary"}}...{{/part}}.',
		});
	}
	const seen = new Set<string>();
	for (const part of parts) {
		problems.push(...partProblems(part, isProfile));
		if (part.name === undefined) {
			continue;
		}
		if (seen.has(part.name)) {
			problems.push(
				problem(
					TemplateProblemSeverity.Error,
					part.node,
					`Two parts are named "${part.name}"; each needs a name of its own.`,
				),
			);
		}
		seen.add(part.name);
	}
	problems.push(...partReferenceProblems(program, seen));
	return problems.sort(byPlace);
}

/**
 * Where a problem is, as one number that orders problems by their place, those
 * without one last.
 * @param problem - What the check found
 */
function placeOf(problem: TemplateProblem): number {
	const { location } = problem;
	return location
		? location.line * 100_000 + location.column
		: Number.MAX_SAFE_INTEGER;
}

/**
 * Orders problems by where they are, those without a place last.
 * @param a - One problem
 * @param b - Another
 */
function byPlace(a: TemplateProblem, b: TemplateProblem): number {
	return placeOf(a) - placeOf(b);
}
