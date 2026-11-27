/**
 * Unit tests for reading which fields of a value a template names.
 * @module tests/unit/templatePaths.test
 */

import { TemplateEngine } from 'src/templates/TemplateEngine';

/**
 * The fields of `properties` a template reads.
 * @param source - The template
 */
function read(source: string): ReadonlySet<string> | 'all' {
	return new TemplateEngine().fieldsRead(source, 'properties');
}

describe('fieldsRead', () => {
	it.each([
		[
			'{{properties.project}} {{properties.owner}}',
			new Set(['project', 'owner']),
		],
		['{{#if properties.done}}x{{/if}}', new Set(['done'])],
		['{{upper (default properties.a "b")}}', new Set(['a'])],
		['{{#each turns}}{{@root.properties.x}}{{/each}}', new Set(['x'])],
		['{{#if a}}{{else}}{{properties.y}}{{/if}}', new Set(['y'])],
		['{{title}}', new Set()],
		['{{#each properties}}{{this}}{{/each}}', 'all'],
		['{{properties}}', 'all'],
		['{{#if}', new Set()],
	])('reads %s as %p', (source, expected) => {
		expect(read(source)).toEqual(expected);
	});
});
