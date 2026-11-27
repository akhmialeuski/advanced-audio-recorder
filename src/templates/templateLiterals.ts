/**
 * Reading the calls of a parsed template without running it: which helper a
 * call names, and the settings written as literals in it.
 * @module templates/templateLiterals
 */

import type {
	AstBlock,
	AstBooleanLiteral,
	AstExpression,
	AstMustache,
	AstNumberLiteral,
	AstPath,
	AstStringLiteral,
} from './handlebarsAst';

/** A call of a helper, written alone or as a block. */
export type AstCall = AstBlock | AstMustache;

/**
 * The value of a literal argument, or undefined for anything else.
 * @param value - The argument
 */
export function literal(value: AstExpression | undefined): unknown {
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
export function setting(node: AstCall, key: string): AstExpression | undefined {
	return node.hash?.pairs.find((pair) => pair.key === key)?.value;
}

/**
 * The settings of a call written as literals, by name; a setting given as an
 * expression is left out, since only a run knows its value.
 * @param node - The call
 */
export function literalSettings(node: AstCall): Record<string, unknown> {
	return Object.fromEntries(
		(node.hash?.pairs ?? [])
			.map((pair) => [pair.key, literal(pair.value)] as const)
			.filter(([, value]) => value !== undefined),
	);
}

/**
 * Whether a call names a helper by its plain name.
 * @param node - A mustache or block
 * @param helper - The helper's name
 */
export function isCallTo(node: AstCall, helper: string): boolean {
	const path = node.path as AstPath;
	return (
		path.type === 'PathExpression' &&
		!path.data &&
		path.parts.length === 1 &&
		path.original === helper
	);
}

/** Settings that shape a callout, and mean nothing without one. */
const CALLOUT_SHAPE: readonly string[] = ['title', 'folded'];

/**
 * What is wrong with the callout settings of a call that may be written in a
 * callout: `folded` that is not true or false, and `title` or `folded` given
 * without `callout`. Each message follows the call's name.
 * @param node - The call
 */
export function calloutSettingProblems(node: AstCall): string[] {
	const given = new Set((node.hash?.pairs ?? []).map((pair) => pair.key));
	const folded = literal(setting(node, 'folded'));
	return [
		...(folded === undefined || typeof folded === 'boolean'
			? []
			: ['needs folded to be true or false.']),
		...(given.has('callout')
			? []
			: CALLOUT_SHAPE.filter((name) => given.has(name)).map(
					(name) =>
						`has ${name} but no callout; add callout="quote" or leave ${name} out.`,
				)),
	];
}
