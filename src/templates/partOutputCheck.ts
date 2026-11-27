/**
 * What is wrong with where a part of a note template sends its result and
 * who fills it, read without running it.
 *
 * A part sent to a property needs the property's name as text, and two parts
 * writing one property would leave it holding whichever came last. A part its
 * own body fills asks no model, so a profile or a call of its own would be a
 * setting that does nothing.
 * @module templates/partOutputCheck
 */

import {
	INLINE_SETTING,
	MODEL_SETTING,
	PROPERTY_SETTING,
} from './noteTemplate';
import { type AstCall, literal, setting } from './templateLiterals';

/**
 * The property a part writes, as its text names it.
 * @param node - The part's call
 * @returns The name, undefined for a part written in the body
 */
export function propertyOf(node: AstCall): string | undefined {
	const value = literal(setting(node, PROPERTY_SETTING));
	return typeof value === 'string' && value.trim() !== ''
		? value.trim()
		: undefined;
}

/**
 * Whether a model fills a part: every part but one with `model=false`.
 * @param node - The part's call
 */
export function asksModel(node: AstCall): boolean {
	return literal(setting(node, MODEL_SETTING)) !== false;
}

/**
 * Property and model settings of the wrong kind.
 * @param node - The part's call
 */
function kindProblems(node: AstCall): string[] {
	const model = literal(setting(node, MODEL_SETTING));
	const inline = literal(setting(node, INLINE_SETTING));
	return [
		...(setting(node, PROPERTY_SETTING) !== undefined &&
		propertyOf(node) === undefined
			? [
					'needs property to be the name of a property in quotes, e.g. property="summary".',
				]
			: []),
		...(model !== undefined && typeof model !== 'boolean'
			? ['needs model to be true or false.']
			: []),
		...(inline !== undefined && typeof inline !== 'boolean'
			? ['needs inline to be true or false.']
			: []),
	];
}

/**
 * Settings that do nothing on a part its own text fills.
 * @param node - The part's call
 */
function unaskedProblems(node: AstCall): string[] {
	if (asksModel(node)) {
		return [];
	}
	return [
		...(setting(node, 'profile') === undefined
			? []
			: [
					'is filled by its own text (model=false), so it names no profile.',
				]),
		...(literal(setting(node, 'separate')) === true
			? [
					'is filled by its own text (model=false), so it makes no call to be separate.',
				]
			: []),
	];
}

/**
 * What is wrong with a part's property and model settings.
 * @param node - The part's call
 * @returns The problems, each a sentence to follow the part's label
 */
export function partOutputProblems(node: AstCall): string[] {
	return [...kindProblems(node), ...unaskedProblems(node)];
}

/**
 * The properties more than one part writes.
 * @param nodes - The template's parts
 * @returns One sentence per property written twice, with the second part
 */
export function sharedPropertyProblems(
	nodes: readonly AstCall[],
): { readonly node: AstCall; readonly message: string }[] {
	const seen = new Set<string>();
	return nodes.flatMap((node) => {
		const property = propertyOf(node);
		if (property === undefined) {
			return [];
		}
		const twice = seen.has(property);
		seen.add(property);
		return twice
			? [
					{
						node,
						message: `Two parts write the property "${property}"; each property takes one part.`,
					},
				]
			: [];
	});
}
