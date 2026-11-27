/**
 * What is wrong with where and how a note template writes the transcript,
 * read without running it.
 *
 * The transcript is the longest thing a note holds, so writing it twice, or
 * once per turn inside a repeat, is never what a template meant. Its settings
 * are checked as the part settings are: a name it does not take, or a value
 * of the wrong kind, is an error the settings show as the template is typed.
 * @module templates/transcriptCheck
 */

import type { AstBlock, AstProgram, AstStatement } from './handlebarsAst';
import {
	type TemplateProblem,
	TemplateProblemSeverity,
	locationOf,
} from './templateAnalysis';
import { type AstCall, isCallTo, literal, setting } from './templateLiterals';
import { TRANSCRIPT_HELPER, TRANSCRIPT_OPTIONS } from './transcriptPart';

/** Settings of the transcript that are true or false. */
const FLAGS: readonly string[] = ['folded', 'timestamps', 'speakers'];

/** Settings that shape the callout, and mean nothing without one. */
const CALLOUT_SHAPE: readonly string[] = ['title', 'folded'];

/** One place the template writes the transcript. */
interface TranscriptCall {
	readonly node: AstCall;
	/** Whether it stands inside a block that repeats. */
	readonly repeated: boolean;
}

/**
 * The places a program writes the transcript, in the order they stand.
 * @param program - A program, or the body of a block
 * @param repeated - Whether the program stands inside a repeat
 * @param found - Where the places are collected
 */
function callsIn(
	program: AstProgram | undefined,
	repeated: boolean,
	found: TranscriptCall[],
): void {
	for (const statement of program?.body ?? []) {
		callsOf(statement, repeated, found);
	}
}

/**
 * The places one statement writes the transcript, itself and inside it.
 * @param statement - A statement of a program
 * @param repeated - Whether it stands inside a repeat
 * @param found - Where the places are collected
 */
function callsOf(
	statement: AstStatement,
	repeated: boolean,
	found: TranscriptCall[],
): void {
	if (
		statement.type !== 'MustacheStatement' &&
		statement.type !== 'BlockStatement'
	) {
		return;
	}
	const call = statement as AstCall;
	if (isCallTo(call, TRANSCRIPT_HELPER)) {
		found.push({ node: call, repeated });
	}
	if (statement.type === 'BlockStatement') {
		const block = statement as AstBlock;
		callsIn(block.program, repeated || isCallTo(block, 'each'), found);
		callsIn(block.inverse, repeated, found);
	}
}

/**
 * What is wrong with one place the transcript is written.
 * @param call - The place
 * @param first - Whether it is the first place the template writes it
 */
function callProblems(call: TranscriptCall, first: boolean): string[] {
	return [
		...(first
			? []
			: [
					'The transcript is written more than once; write {{transcript}} once, or repeat its turns with {{#each turns}}.',
				]),
		...(call.repeated
			? [
					'{{transcript}} cannot stand inside a repeat; use the fields of {{#each turns}} there.',
				]
			: []),
		...('program' in call.node
			? ['{{transcript}} is not a block; write it as {{transcript}}.']
			: []),
		...settingProblems(call.node),
	];
}

/**
 * Settings the transcript does not take, or that are of the wrong kind.
 * @param node - The call
 */
function settingProblems(node: AstCall): string[] {
	const pairs = node.hash?.pairs ?? [];
	const given = new Set(pairs.map((pair) => pair.key));
	return [
		...pairs
			.filter((pair) => !TRANSCRIPT_OPTIONS.includes(pair.key))
			.map(
				(pair) =>
					`{{transcript}} has an unknown setting "${pair.key}"; it takes ${TRANSCRIPT_OPTIONS.join(', ')}.`,
			),
		...FLAGS.filter((name) => {
			const value = literal(setting(node, name));
			return value !== undefined && typeof value !== 'boolean';
		}).map((name) => `{{transcript}} needs ${name} to be true or false.`),
		...(given.has('callout')
			? []
			: CALLOUT_SHAPE.filter((name) => given.has(name)).map(
					(name) =>
						`{{transcript}} has ${name} but no callout; add callout="quote" or leave ${name} out.`,
				)),
	];
}

/**
 * Errors for where and how a template writes the transcript.
 * @param program - The parsed template
 */
export function transcriptProblems(program: AstProgram): TemplateProblem[] {
	const calls: TranscriptCall[] = [];
	callsIn(program, false, calls);
	return calls.flatMap((call, index) =>
		callProblems(call, index === 0).map((message) => ({
			severity: TemplateProblemSeverity.Error,
			message,
			location: locationOf(call.node),
		})),
	);
}
