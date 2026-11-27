/**
 * Renders and checks note templates.
 *
 * Templates are Handlebars, the engine obsidian-citation-extended already uses
 * for the same job, so both plugins read one notation: `{{title}}` for a fact,
 * `{{#if participants}}...{{else}}...{{/if}}` for a condition, `{{#each turns}}`
 * to repeat a block for every item, and helpers such as
 * `{{date format="YYYY-MM-DD"}}` or `{{join participants ", "}}`. The core
 * Templates notation `{{date:FORMAT}}` is accepted as well.
 *
 * Nothing in a template runs code: Handlebars evaluates only the helpers
 * registered here, and partials and decorators are refused. Output is never
 * HTML-escaped, because it is Markdown.
 *
 * A name the catalogue does not know is left in the output exactly as typed
 * rather than rendered as nothing. A prompt regularly shows a model an example
 * with braces in it, and cutting a piece out of an instruction without a word
 * is worse than leaving a typo where the validator already pointed at it.
 * @module templates/TemplateEngine
 */

import Handlebars from 'handlebars';
import type { AstProgram } from './handlebarsAst';
import {
	type TemplateProblem,
	BUILT_IN_HELPERS,
	TemplateProblemSeverity,
	analyzeTemplate,
} from './templateAnalysis';
import type { TemplateCatalog } from './templateCatalog';
import { type TemplateHelper, TEMPLATE_HELPERS } from './templateHelpers';
import {
	type TemplateLocation,
	normalizeCoreSyntax,
	offsetOf,
	parseErrorLocation,
	parseErrorMessage,
} from './templateSyntax';

/** What a render reads its values from. */
export type TemplateContext = Readonly<Record<string, unknown>>;

/** The options every compile uses: the output is Markdown, not HTML. */
const COMPILE_OPTIONS: CompileOptions = { noEscape: true };

/** Options Handlebars compiles with, as its typings name them. */
type CompileOptions = NonNullable<Parameters<typeof Handlebars.compile>[1]>;

/** Most compiled templates kept at once; a run renders a handful. */
const CACHE_LIMIT = 32;

/** A template that could not be rendered, with where it went wrong. */
export class TemplateRenderError extends Error {
	constructor(
		message: string,
		readonly location?: TemplateLocation,
	) {
		super(
			location
				? `${message} (line ${String(location.line)}, column ${String(location.column)})`
				: message,
		);
		this.name = 'TemplateRenderError';
	}
}

/**
 * A Handlebars instance with the plugin's helpers, and the checks around it.
 * One instance is enough for the plugin: its helpers do not change, and
 * compiled templates are cached by their text.
 */
export class TemplateEngine {
	private readonly hbs = Handlebars.create();
	private readonly cache = new Map<string, Handlebars.TemplateDelegate>();
	private readonly helperList: readonly TemplateHelper[];
	private readonly helperNames: ReadonlySet<string>;

	/**
	 * @param extraHelpers - Helpers a feature adds to the shared set, e.g. the
	 *   block that declares a part of a note template
	 */
	constructor(extraHelpers: readonly TemplateHelper[] = []) {
		this.helperList = [...TEMPLATE_HELPERS, ...extraHelpers];
		for (const helper of this.helperList) {
			this.hbs.registerHelper(helper.name, helper.fn);
		}
		this.helperNames = new Set([
			...BUILT_IN_HELPERS,
			...this.helperList.map((helper) => helper.name),
		]);
	}

	/** Every helper a template can call, for the list of variables. */
	get helpers(): readonly TemplateHelper[] {
		return this.helperList;
	}

	/**
	 * Checks a template without rendering it.
	 * @param source - The template as the user wrote it
	 * @param catalog - The names it may use
	 * @returns Every problem found, a syntax error alone when it cannot parse
	 */
	validate(
		source: string,
		catalog: TemplateCatalog,
	): readonly TemplateProblem[] {
		try {
			const program = this.hbs.parse(normalizeCoreSyntax(source));
			return analyzeTemplate(program, {
				catalog,
				helpers: this.helperNames,
			}).problems;
		} catch (error) {
			const location = parseErrorLocation(error);
			return [
				{
					severity: TemplateProblemSeverity.Error,
					message: parseErrorMessage(error),
					...(location ? { location } : {}),
				},
			];
		}
	}

	/**
	 * Renders a template.
	 * @param source - The template as the user wrote it
	 * @param context - The values it reads
	 * @param catalog - The names it may use. Given, a name outside it is left
	 *   in the output as typed; omitted, every name is looked up as is
	 * @returns The rendered text
	 * @throws TemplateRenderError when the template cannot be parsed or a
	 *   helper fails
	 */
	render(
		source: string,
		context: TemplateContext,
		catalog?: TemplateCatalog,
	): string {
		const text = this.prepare(normalizeCoreSyntax(source), catalog);
		try {
			return this.compiled(text)(context);
		} catch (error) {
			const location = parseErrorLocation(error);
			throw new TemplateRenderError(parseErrorMessage(error), location);
		}
	}

	/**
	 * The text to compile: the template with every unknown plain name escaped,
	 * so Handlebars writes it out instead of looking it up.
	 */
	private prepare(
		source: string,
		catalog: TemplateCatalog | undefined,
	): string {
		if (!catalog) {
			return source;
		}
		let program: AstProgram;
		try {
			program = this.hbs.parse(source);
		} catch (error) {
			throw new TemplateRenderError(
				parseErrorMessage(error),
				parseErrorLocation(error),
			);
		}
		const offsets = analyzeTemplate(program, {
			catalog,
			helpers: this.helperNames,
		})
			.unknownTokens.map((token) =>
				offsetOf(source, token.line, token.column),
			)
			.sort((a, b) => b - a);
		let text = source;
		for (const offset of offsets) {
			text = `${text.slice(0, offset)}\\${text.slice(offset)}`;
		}
		return text;
	}

	/** The compiled form of a text, compiled once while it stays cached. */
	private compiled(text: string): Handlebars.TemplateDelegate {
		const cached = this.cache.get(text);
		if (cached) {
			return cached;
		}
		const compiled = this.hbs.compile(text, COMPILE_OPTIONS);
		if (this.cache.size >= CACHE_LIMIT) {
			const oldest = this.cache.keys().next().value;
			if (oldest !== undefined) {
				this.cache.delete(oldest);
			}
		}
		this.cache.set(text, compiled);
		return compiled;
	}
}
