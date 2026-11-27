/**
 * What a template may name, described once for everything that reads it.
 *
 * A template is checked, rendered and documented against the same list of
 * names: the validator warns about a name the list does not hold, the renderer
 * leaves such a name in the text as it was typed, and the list of variables a
 * profile page opens is this list. Keeping one description is what stops the
 * three from disagreeing the moment somebody adds a fact to one of them.
 *
 * The shapes here are the engine's own and know nothing about a run: what a
 * transcription run actually offers is declared by the run context, which
 * builds its catalogue from these types.
 * @module templates/templateCatalog
 */

/** One name a template may use, with what it holds. */
export interface TemplateVariable {
	/** The name as written in a template, e.g. `title`. */
	readonly name: string;
	/** What the value is, as the list of variables explains it. */
	readonly description: string;
	/** An example value, shown when no real value is at hand. */
	readonly example?: string;
	/**
	 * The fields of an object, or of each item of a list, by name. Present
	 * when the value has a known shape, so `{{#each turns}}{{speaker}}`
	 * checks `speaker` against the item rather than against the template.
	 */
	readonly fields?: readonly TemplateVariable[];
	/**
	 * Whether the value accepts any field name, as the properties of a note
	 * do: their names are the user's, so no list of them can be complete.
	 */
	readonly open?: boolean;
}

/** A list of names one level of a template sees. */
export type TemplateCatalog = readonly TemplateVariable[];

/**
 * Field names every list answers, whatever its items are. Handlebars reads
 * them off the array itself, so `{{#if turns.length}}` is a fact, not a typo.
 */
const LIST_FIELDS: ReadonlySet<string> = new Set(['length']);

/**
 * Looks one name up among the variables of a level.
 * @param catalog - The variables the level holds
 * @param name - The name to find
 * @returns The variable, or undefined when the level does not hold it
 */
export function findVariable(
	catalog: TemplateCatalog,
	name: string,
): TemplateVariable | undefined {
	return catalog.find((variable) => variable.name === name);
}

/**
 * Whether a dotted path below a known variable names something it holds.
 *
 * The first segment has already matched; each further segment is looked up in
 * the fields of the one before it. A variable without a declared shape, or an
 * open one, accepts whatever follows, because nothing says it is wrong.
 * @param variable - The variable the path starts at
 * @param rest - The segments after its name
 * @returns Whether the path resolves
 */
export function resolvesBelow(
	variable: TemplateVariable,
	rest: readonly string[],
): boolean {
	let current = variable;
	for (const segment of rest) {
		if (current.open || !current.fields) {
			return true;
		}
		if (LIST_FIELDS.has(segment)) {
			return true;
		}
		const next = findVariable(current.fields, segment);
		if (!next) {
			return false;
		}
		current = next;
	}
	return true;
}
