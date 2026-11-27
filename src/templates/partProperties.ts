/**
 * The properties a note template writes: the results of the parts it sends to
 * the note's frontmatter rather than its body.
 *
 * A summary in the body is text; the same summary in a property is data a
 * Dataview query or a Bases table reads. The value is written as the text the
 * part came to: Obsidian gives a plugin no way to declare a property's type
 * that would agree with what the user set up, so no date or list is guessed.
 * @module templates/partProperties
 */

import type { PartSpec } from './noteTemplate';

/** Properties of a note, by name, as a template wrote them. */
export type NoteProperties = Readonly<Record<string, string>>;

/**
 * The properties a template's parts came to: each part with a property set,
 * whose result is not empty. A part that found nothing leaves the property as
 * the note had it.
 * @param specs - The parts of the template
 * @param results - Every part's result, by name
 */
export function noteProperties(
	specs: readonly PartSpec[],
	results: ReadonlyMap<string, string>,
): NoteProperties {
	const properties: Record<string, string> = {};
	for (const spec of specs) {
		const value = results.get(spec.name)?.trim() ?? '';
		if (spec.property !== undefined && value !== '') {
			properties[spec.property] = value;
		}
	}
	return properties;
}
