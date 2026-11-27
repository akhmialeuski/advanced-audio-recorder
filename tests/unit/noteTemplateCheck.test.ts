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
			'Part "a" has an unknown format "mermaid"; use one of prose, bullets, numbered, tasks,',
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
		[
			'{{#part "t" format="table"}}x{{/part}}',
			'Part "t" needs its columns, e.g. columns="Owner, Task, Due".',
		],
		[
			'{{#part "t" format="tasks" style="org"}}x{{/part}}',
			'Part "t" needs style to be plain, dataview or tasks.',
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

	it('leaves a format setting given as an expression to the run', () => {
		expect(
			check('{{#part "t" format="tasks" style=title}}x{{/part}}'),
		).toEqual([]);
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

describe('checking the transcript of a template', () => {
	/**
	 * What a check finds, as the lines a user reads.
	 * @param source - The template
	 */
	function check(source: string): string[] {
		return checkNoteTemplate(
			`{{#part "a"}}A{{/part}}\n${source}`,
			() => false,
		).map(describeProblem);
	}

	it('accepts the settings it takes', () => {
		expect(
			check(
				'{{transcript callout="quote" title="T" folded=true timestamps=false speakers=false}}',
			),
		).toEqual([]);
		expect(check('{{#each turns}}{{speaker}}: {{text}}{{/each}}')).toEqual(
			[],
		);
	});

	it.each([
		[
			'{{transcript}}\n{{#if title}}{{transcript}}{{/if}}',
			'Line 3, column 14: The transcript is written more than once',
		],
		[
			'{{#each turns}}{{transcript}}{{/each}}',
			'Line 2, column 16: {{transcript}} cannot stand inside a repeat',
		],
		[
			'{{#transcript}}x{{/transcript}}',
			'Line 2, column 1: {{transcript}} is not a block',
		],
		[
			'{{transcript fold=true}}',
			'Line 2, column 1: {{transcript}} has an unknown setting "fold"',
		],
		[
			'{{transcript callout="quote" folded="yes"}}',
			'Line 2, column 1: {{transcript}} needs folded to be true or false.',
		],
		[
			'{{transcript title="T"}}',
			'Line 2, column 1: {{transcript}} has title but no callout',
		],
		[
			'{{transcript chapters="yes"}}',
			'Line 2, column 1: {{transcript}} needs chapters to be true, false or a heading level from 1 to 6.',
		],
	])('finds what is wrong with %s', (source, message) => {
		expect(check(source)).toEqual([expect.stringContaining(message)]);
	});
});

describe('checking the callout of a part', () => {
	it('takes callout, title and folded on any part', () => {
		expect(
			check(
				'{{#part "a" format="bullets" callout="tip" title="T" folded=true}}A{{/part}}',
			),
		).toEqual([]);
	});

	it.each([
		[
			'{{#part "a" title="T"}}A{{/part}}',
			'Part "a" has title but no callout',
		],
		[
			'{{#part "a" callout="tip" folded="no"}}A{{/part}}',
			'Part "a" needs folded to be true or false.',
		],
	])('finds what is wrong with %s', (source, message) => {
		expect(check(source)).toEqual([expect.stringContaining(message)]);
	});
});

describe('checking where a part writes and who fills it', () => {
	it('takes a property and a part its own text fills', () => {
		expect(
			check(
				[
					'{{#part "summary" property="summary"}}The points.{{/part}}',
					'{{#part "people" property="participants" model=false}}{{join participants ", "}}{{/part}}',
				].join('\n'),
			),
		).toEqual([]);
	});

	it.each([
		[
			'{{#part "a" property=3}}A{{/part}}',
			'Part "a" needs property to be the name of a property in quotes',
		],
		[
			'{{#part "a" model="no"}}A{{/part}}',
			'Part "a" needs model to be true or false.',
		],
		[
			'{{#part "a" inline="no"}}A{{/part}}',
			'Part "a" needs inline to be true or false.',
		],
		[
			'{{#part "a" model=false separate=true}}A{{/part}}',
			'Part "a" is filled by its own text (model=false), so it makes no call to be separate.',
		],
		[
			'{{part "a" model=false profile="Action items"}}',
			'Part "a" is filled by its own text (model=false), so it names no profile.',
		],
		[
			'{{#part "a" property="x"}}A{{/part}}{{#part "b" property="x"}}B{{/part}}',
			'Two parts write the property "x"; each property takes one part.',
		],
	])('finds what is wrong with %s', (source, message) => {
		expect(check(source, ['Action items'])).toContainEqual(
			expect.stringContaining(message),
		);
	});

	it('counts no call for a part its own text fills', () => {
		const plan = planNoteTemplate(
			'{{#part "a" model=false}}x{{/part}}{{#part "b" model=false separate=true}}x{{/part}}',
		);

		expect(plan).toEqual({ calls: 0, outputRatio: 0 });
	});
});
