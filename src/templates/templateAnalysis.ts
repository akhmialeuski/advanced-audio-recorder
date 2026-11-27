/**
 * Reads a parsed template against what it may name, without rendering it.
 *
 * Two readers need the same answer. The validator turns it into the problems
 * a profile page shows, each with the place it was found, so a user does not
 * edit a template blind. The renderer uses the variables it found unknown to
 * leave them in the output exactly as typed: a prompt that shows a model an
 * example such as `{{owner}}` must reach the model with it, and a typo is
 * better shown than silently cut out of an instruction.
 *
 * The walk keeps a scope per level, as Handlebars itself does: inside
 * `{{#each turns}}` a name is looked up among the fields of one turn, `../`
 * climbs back out, and `@root` starts from the top. A level whose shape is not
 * known is not checked at all, because reporting a name as unknown where the
 * plugin cannot know is worse than saying nothing.
 * @module templates/templateAnalysis
 */

import type {
	AstBlock,
	AstExpression,
	AstHash,
	AstMustache,
	AstNode,
	AstPath,
	AstProgram,
	AstStatement,
	AstSubExpression,
} from './handlebarsAst';
import {
	type TemplateCatalog,
	type TemplateVariable,
	findVariable,
	resolvesBelow,
} from './templateCatalog';
import type { TemplateLocation } from './templateSyntax';

/** How bad a problem is: an error stops a render, a warning does not. */
export const TemplateProblemSeverity = {
	/** The template cannot be rendered as written. */
	Error: 'error',
	/** The template renders, but probably not as meant. */
	Warning: 'warning',
} as const;

/** One severity (derived from {@link TemplateProblemSeverity}). */
export type TemplateProblemSeverity =
	(typeof TemplateProblemSeverity)[keyof typeof TemplateProblemSeverity];

/** Something wrong with a template, and where it is. */
export interface TemplateProblem {
	readonly severity: TemplateProblemSeverity;
	readonly message: string;
	readonly location?: TemplateLocation;
}

/** A plain `{{name}}` that names nothing known, as Handlebars located it. */
export interface UnknownToken {
	/** 1-based line of the opening braces. */
	readonly line: number;
	/** 0-based column of the opening braces. */
	readonly column: number;
}

/** What a walk over a template found. */
export interface TemplateAnalysis {
	readonly problems: readonly TemplateProblem[];
	readonly unknownTokens: readonly UnknownToken[];
}

/** What the walk is checking the template against. */
export interface AnalysisInput {
	/** The names the top level of a template sees. */
	readonly catalog: TemplateCatalog;
	/** Every helper a template may call, built-in or registered. */
	readonly helpers: ReadonlySet<string>;
}

/**
 * One level of a template. A null catalogue is a level whose shape is not
 * known, where no name is reported.
 */
interface Scope {
	readonly catalog: TemplateCatalog | null;
	readonly parent: Scope | null;
}

/** What a name resolved to in its scope. */
type Lookup =
	| { readonly status: 'known'; readonly variable?: TemplateVariable }
	| { readonly status: 'unknown' }
	| { readonly status: 'unchecked' };

/** Data variables Handlebars sets inside `{{#each}}`. */
const LOOP_DATA: ReadonlySet<string> = new Set([
	'index',
	'first',
	'last',
	'key',
	'root',
]);

/** Block helpers Handlebars ships, which keep the scope they are opened in. */
const SAME_SCOPE_BLOCKS: ReadonlySet<string> = new Set(['if', 'unless']);

/** Block helpers Handlebars ships, which move into the value they are given. */
const DESCENDING_BLOCKS: ReadonlySet<string> = new Set(['each', 'with']);

/** Every helper Handlebars itself registers. */
export const BUILT_IN_HELPERS: readonly string[] = [
	'if',
	'unless',
	'each',
	'with',
	'lookup',
	'log',
];

/**
 * The location of a node, in the 1-based line and column a user reads.
 * @param node - A node Handlebars parsed
 */
function locationOf(node: AstNode): TemplateLocation {
	return { line: node.loc.start.line, column: node.loc.start.column + 1 };
}

/**
 * Walks one parsed template and collects what it found. One instance walks
 * one template.
 */
class TemplateWalker {
	private readonly problems: TemplateProblem[] = [];
	private readonly unknownTokens: UnknownToken[] = [];
	private readonly root: Scope;

	constructor(private readonly input: AnalysisInput) {
		this.root = { catalog: input.catalog, parent: null };
	}

	/**
	 * Walks the whole template.
	 * @param program - The parsed template
	 */
	walk(program: AstProgram): TemplateAnalysis {
		this.program(program, this.root);
		return { problems: this.problems, unknownTokens: this.unknownTokens };
	}

	private program(program: AstProgram, scope: Scope): void {
		for (const statement of program.body) {
			this.statement(statement, scope);
		}
	}

	private statement(statement: AstStatement, scope: Scope): void {
		switch (statement.type) {
			case 'MustacheStatement':
				this.mustache(statement as AstMustache, scope);
				return;
			case 'BlockStatement':
				this.block(statement as AstBlock, scope);
				return;
			case 'PartialStatement':
			case 'PartialBlockStatement':
			case 'DecoratorBlock':
			case 'Decorator':
				this.error(
					statement,
					'Partials and decorators are not supported.',
				);
				return;
			default:
				return;
		}
	}

	private mustache(node: AstMustache, scope: Scope): void {
		const path = node.path;
		if (path.type !== 'PathExpression' || this.isHelper(path)) {
			this.call(node, scope);
			return;
		}
		const named = path as AstPath;
		if (node.params.length > 0 || (node.hash?.pairs.length ?? 0) > 0) {
			this.error(node, `Unknown helper "${named.original}".`);
			return;
		}
		this.plainName(node, named, scope);
	}

	/**
	 * Checks a `{{name}}` that is not a helper call, and marks it to be left
	 * in the output as typed when it names nothing known.
	 */
	private plainName(node: AstMustache, path: AstPath, scope: Scope): void {
		if (this.lookup(path, scope).status !== 'unknown') {
			return;
		}
		this.warning(node, `Unknown variable "${path.original}".`);
		this.unknownTokens.push({
			line: node.loc.start.line,
			column: node.loc.start.column,
		});
	}

	private block(node: AstBlock, scope: Scope): void {
		this.call(node, scope);
		if (
			!this.isHelper(node.path) &&
			this.lookup(node.path, scope).status === 'unknown'
		) {
			this.error(
				node,
				`Unknown helper or variable "${node.path.original}".`,
			);
		}
		this.program(node.program, this.blockScope(node, scope));
		if (node.inverse) {
			this.program(node.inverse, scope);
		}
	}

	/**
	 * The scope the body of a block is read in: the same one for a condition
	 * or a registered helper, the value's own fields for `each` and `with`, and
	 * for a section opened on a variable (`{{#turns}}`), that variable's.
	 */
	private blockScope(node: AstBlock, scope: Scope): Scope {
		const name = node.path.original;
		if (SAME_SCOPE_BLOCKS.has(name)) {
			return scope;
		}
		if (DESCENDING_BLOCKS.has(name)) {
			return this.descend(node.params[0], scope);
		}
		if (this.isHelper(node.path)) {
			return scope;
		}
		return this.descend(node.path, scope);
	}

	/**
	 * The scope inside a value: its declared fields, or an unchecked level when
	 * the value or its shape is not known.
	 */
	private descend(value: AstExpression | undefined, scope: Scope): Scope {
		const catalog =
			value?.type === 'PathExpression'
				? this.fieldsOf(value as AstPath, scope)
				: null;
		return { catalog, parent: scope };
	}

	/** The declared fields of a value, or null when they are not known. */
	private fieldsOf(path: AstPath, scope: Scope): TemplateCatalog | null {
		const found = this.lookup(path, scope);
		if (
			found.status !== 'known' ||
			!found.variable ||
			found.variable.open
		) {
			return null;
		}
		return found.variable.fields ?? null;
	}

	/** Checks the arguments of a call, and the callee when it is nested. */
	private call(
		node: {
			readonly params: readonly AstExpression[];
			readonly hash?: AstHash;
		},
		scope: Scope,
	): void {
		for (const param of node.params) {
			this.expression(param, scope);
		}
		for (const pair of node.hash?.pairs ?? []) {
			this.expression(pair.value, scope);
		}
	}

	private expression(expression: AstExpression, scope: Scope): void {
		if (expression.type === 'SubExpression') {
			const sub = expression as AstSubExpression;
			if (!this.isHelper(sub.path)) {
				this.error(sub, `Unknown helper "${sub.path.original}".`);
			}
			this.call(sub, scope);
			return;
		}
		if (expression.type !== 'PathExpression') {
			return;
		}
		const path = expression as AstPath;
		if (this.lookup(path, scope).status === 'unknown') {
			this.warning(path, `Unknown variable "${path.original}".`);
		}
	}

	/** Whether a path is a bare helper name. */
	private isHelper(path: AstPath | AstExpression): boolean {
		if (path.type !== 'PathExpression') {
			return false;
		}
		const named = path as AstPath;
		return (
			!named.data &&
			named.depth === 0 &&
			named.parts.length === 1 &&
			this.input.helpers.has(named.original)
		);
	}

	/** Resolves a path in the scope it is written in. */
	private lookup(path: AstPath, scope: Scope): Lookup {
		if (path.data) {
			return this.lookupData(path);
		}
		let level: Scope | null = scope;
		for (let up = 0; up < path.depth && level; up += 1) {
			level = level.parent;
		}
		if (!level) {
			return { status: 'unknown' };
		}
		return lookupIn(level.catalog, path.parts);
	}

	/** Resolves `@index`, `@root.title` and the like. */
	private lookupData(path: AstPath): Lookup {
		const [head, ...rest] = path.parts;
		if (head === 'root') {
			return rest.length === 0
				? { status: 'known' }
				: lookupIn(this.root.catalog, rest);
		}
		return head !== undefined && LOOP_DATA.has(head)
			? { status: 'known' }
			: { status: 'unknown' };
	}

	private error(node: AstNode, message: string): void {
		this.problems.push({
			severity: TemplateProblemSeverity.Error,
			message,
			location: locationOf(node),
		});
	}

	private warning(node: AstNode, message: string): void {
		this.problems.push({
			severity: TemplateProblemSeverity.Warning,
			message,
			location: locationOf(node),
		});
	}
}

/**
 * Resolves the segments of a path among the variables of one level.
 * @param catalog - The level's variables, or null when its shape is unknown
 * @param parts - The path's segments; empty for `this`
 */
function lookupIn(
	catalog: TemplateCatalog | null,
	parts: readonly string[],
): Lookup {
	if (catalog === null) {
		return { status: 'unchecked' };
	}
	const [head, ...rest] = parts;
	if (head === undefined) {
		return { status: 'known' };
	}
	const variable = findVariable(catalog, head);
	if (!variable || !resolvesBelow(variable, rest)) {
		return { status: 'unknown' };
	}
	return rest.length === 0
		? { status: 'known', variable }
		: { status: 'known' };
}

/**
 * Walks a parsed template against what it may name.
 * @param program - The template as Handlebars parsed it
 * @param input - The catalogue and the helpers it is checked against
 * @returns The problems found and the unknown names to leave as typed
 */
export function analyzeTemplate(
	program: AstProgram,
	input: AnalysisInput,
): TemplateAnalysis {
	return new TemplateWalker(input).walk(program);
}
