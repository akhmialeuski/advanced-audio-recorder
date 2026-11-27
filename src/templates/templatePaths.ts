/**
 * Which fields of one value a template reads.
 *
 * Some values are expensive or private to collect whole: the properties of a
 * note go to a model provider, and a note can hold fields nobody meant to send.
 * Asking the template which ones it names lets the run read exactly those. The
 * answer errs towards reading more: a template that hands the whole value to a
 * block, as `{{#each properties}}` does, is answered with every field.
 * @module templates/templatePaths
 */

import type {
	AstExpression,
	AstHash,
	AstNode,
	AstPath,
	AstProgram,
} from './handlebarsAst';

/** The fields a template reads of a value, or all of them. */
export type FieldReads = ReadonlySet<string> | 'all';

/** A node that may carry a callee, arguments and a body. */
interface Visitable extends AstNode {
	readonly path?: AstExpression;
	readonly params?: readonly AstExpression[];
	readonly hash?: AstHash;
	readonly program?: AstProgram;
	readonly inverse?: AstProgram;
	readonly body?: readonly AstNode[];
}

/**
 * Every path expression in a parsed template, wherever it stands: output,
 * callee, argument, hash value, or inside a block of either branch.
 * @param root - The parsed template or any node of it
 * @returns The paths, in no particular order
 */
export function collectPaths(root: AstNode): AstPath[] {
	const found: AstPath[] = [];
	const pending: AstNode[] = [root];
	for (let node = pending.pop(); node; node = pending.pop()) {
		if (node.type === 'PathExpression') {
			found.push(node as AstPath);
			continue;
		}
		pending.push(...childrenOf(node));
	}
	return found;
}

/**
 * The nodes directly under one node.
 * @param node - Any node of a parsed template
 */
function childrenOf(node: Visitable): AstNode[] {
	return [
		...(node.body ?? []),
		...(node.path ? [node.path] : []),
		...(node.params ?? []),
		...(node.hash?.pairs.map((pair) => pair.value) ?? []),
		...(node.program ? [node.program] : []),
		...(node.inverse ? [node.inverse] : []),
	];
}

/**
 * The fields of one top-level value a template reads.
 * @param program - The parsed template
 * @param root - Name of the value, e.g. `properties`
 * @returns The field names, or 'all' when the value is read whole
 */
export function fieldsRead(program: AstProgram, root: string): FieldReads {
	const fields = new Set<string>();
	for (const path of collectPaths(program)) {
		const parts =
			path.data && path.parts[0] === 'root'
				? path.parts.slice(1)
				: path.parts;
		if (parts[0] !== root) {
			continue;
		}
		const field = parts[1];
		if (field === undefined) {
			return 'all';
		}
		fields.add(field);
	}
	return fields;
}
