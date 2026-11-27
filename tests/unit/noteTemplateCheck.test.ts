/**
 * Unit tests for checking a note template and planning its calls.
 * @module tests/unit/noteTemplateCheck.test
 */

import {
	checkNoteTemplate,
	declaredParts,
	planNoteTemplate,
} from 'src/templates/noteTemplateCheck';
import { describeProblem } from 'src/templates/templateAnalysis';

/**
 * What a check of a template finds, as the lines a user reads.
 * @param source - The template
 * @param profiles - The names of the prompt profiles there are
 */
function check(source: string, profiles: readonly string[] = []): string[] {
	return checkNoteTemplate(source, (name) => profiles.includes(name)).map(
		describeProblem,
	);
}

describe('checkNoteTemplate', () => {
	it('finds nothing wrong with a well-formed template', () => {
		expect(
			check(
				[
					'# {{title}}',
					'{{#part "summary" format="bullets" max=3}}The points.{{/part}}',
					'{{part "actions" profile="Action items" separate=true}}',
					'{{#if parts.actions}}Has actions.{{/if}}',
					'{{transcript}}',
				].join('\n'),
				['Action items'],
			),
		).toEqual([]);
	});

	it('warns about a template without parts', () => {
		expect(check('# {{title}}')).toEqual([
			expect.stringContaining('The template has no parts'),
		]);
	});

	it('reports a syntax error alone', () => {
		expect(check('{{#part "a"}}')).toEqual([
			expect.stringContaining('Line 1'),
		]);
	});

	it.each([
		['{{#part}}x{{/part}}', 'A part needs a name in quotes'],
		['{{#part name}}x{{/part}}', 'A part needs a name in quotes'],
		[
			'{{#each speakers}}{{#part "a"}}x{{/part}}{{/each}}',
			'Part "a" cannot stand inside a repeat.',
		],
		[
			'{{#part "a"}}{{#part "b"}}x{{/part}}{{/part}}',
			'Part "b" cannot stand inside another part.',
		],
		[
			'{{#part "a" format="mermaid"}}x{{/part}}',
			'Part "a" has an unknown format "mermaid"; use one of prose, bullets.',
		],
		[
			'{{#part "a" target="property:x"}}x{{/part}}',
			'Part "a" has an unknown setting "target".',
		],
		[
			'{{#part "a" max=1.5}}x{{/part}}',
			'Part "a" needs max to be a whole number',
		],
		[
			'{{#part "a" max="3"}}x{{/part}}',
			'Part "a" needs max to be a whole number',
		],
		[
			'{{#part "a" profile="P"}}x{{/part}}',
			'Part "a" has both an instruction and profile="P"; keep one.',
		],
		['{{#part "a"}}  {{/part}}', 'Part "a" has no instruction'],
		[
			'{{#part "a"}}x{{/part}}{{#part "a"}}y{{/part}}',
			'Line 1, column 24: Two parts are named "a"',
		],
	])('reports %p', (source, message) => {
		expect(check(source, ['P'])).toEqual(
			expect.arrayContaining([expect.stringContaining(message)]),
		);
	});

	it('warns about a profile and a part result nobody declared', () => {
		expect(
			check(
				'{{part "a" profile="Missing"}}\n{{parts.b}} {{@root.parts.a}}',
			),
		).toEqual([
			'Line 1, column 1: Part "a" names the profile "Missing", which no cleanup, summary or custom prompt profile is called.',
			'Line 2, column 3: No part is named "b".',
		]);
	});

	it('orders problems by line and column', () => {
		const found = check(
			'{{#part "a" format="x"}}y{{/part}}\n{{unknown}} {{#part "b" max=0}}y{{/part}}',
		);

		expect(found.map((line) => line.slice(0, 20))).toEqual([
			'Line 1, column 1: Pa',
			'Line 2, column 1: Un',
			'Line 2, column 13: P',
		]);
	});
});

describe('declaredParts', () => {
	it('reads the parts of every branch, and none of a broken template', () => {
		const parts = declaredParts(
			'{{#if x}}{{#part "a"}}x{{/part}}{{else}}{{part "b" profile="P" format="bullets"}}{{/if}}',
		);

		expect(
			parts.map(({ name, format, profile, hasInstruction }) => ({
				name,
				format,
				profile,
				hasInstruction,
			})),
		).toEqual([
			{
				name: 'a',
				format: 'prose',
				profile: undefined,
				hasInstruction: true,
			},
			{
				name: 'b',
				format: 'bullets',
				profile: 'P',
				hasInstruction: false,
			},
		]);
		expect(declaredParts('{{#part')).toEqual([]);
	});
});

describe('planNoteTemplate', () => {
	it.each([
		['no parts', '# Title', 0, 0],
		[
			'shared parts',
			'{{#part "a"}}x{{/part}}{{#part "b" format="bullets"}}x{{/part}}',
			1,
			0.23,
		],
		[
			'a separate part',
			'{{#part "a"}}x{{/part}}{{#part "b" separate=true}}x{{/part}}',
			2,
			0.3,
		],
		[
			'an unknown format at the prose rate',
			'{{#part "a" format="z"}}x{{/part}}',
			1,
			0.15,
		],
	])('plans %s', (_title, source, calls, ratio) => {
		const plan = planNoteTemplate(source);

		expect(plan.calls).toBe(calls);
		expect(plan.outputRatio).toBeCloseTo(ratio);
	});
});
