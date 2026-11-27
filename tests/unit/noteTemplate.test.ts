/**
 * Unit tests for collecting the parts of a note template and writing the note.
 * @module tests/unit/noteTemplate.test
 */

import {
	NOTE_TEMPLATE_VARIABLES,
	assembleNote,
	collectParts,
	noteTemplateEngine,
	removeEmptySections,
} from 'src/templates/noteTemplate';
import { TemplateRenderError } from 'src/templates/TemplateEngine';

const context = {
	title: 'Weekly sync',
	participants: ['Anna', 'Ben'],
	transcript: 'Anna: hi',
};

describe('collectParts', () => {
	it('reads every part with its settings and its rendered instruction', () => {
		const parts = collectParts(
			[
				'# {{title}}',
				'{{#part "summary" format="bullets" max=3 language="German"}}',
				'  What {{join participants ", "}} agreed.',
				'{{/part}}',
				'{{part "actions" profile="Action items" separate=true empty="keep"}}',
			].join('\n'),
			context,
		);

		expect(parts).toEqual([
			expect.objectContaining({
				name: 'summary',
				instruction: 'What Anna, Ben agreed.',
				format: 'bullets',
				max: 3,
				language: 'German',
				empty: 'remove',
				separate: false,
				profile: undefined,
			}),
			expect.objectContaining({
				name: 'actions',
				instruction: '',
				format: 'prose',
				profile: 'Action items',
				empty: 'keep',
				separate: true,
				max: undefined,
			}),
		]);
	});

	it('asks for a part inside a condition only when the condition holds', () => {
		const source =
			'{{#if participants}}{{#part "who"}}Who spoke.{{/part}}{{/if}}';

		expect(collectParts(source, context)).toHaveLength(1);
		expect(collectParts(source, { participants: [] })).toHaveLength(0);
	});

	it('reads a limit written as text and ignores one that is not a count', () => {
		const [text, bad] = collectParts(
			'{{#part "a" max="4"}}x{{/part}}{{#part "b" max=0}}x{{/part}}',
			{},
		);

		expect(text?.max).toBe(4);
		expect(bad?.max).toBeUndefined();
	});

	it.each([
		['{{#part}}x{{/part}}', 'A part needs a name'],
		['{{#part ""}}x{{/part}}', 'A part needs a name'],
		[
			'{{#part "a"}}x{{/part}}{{#part "a"}}y{{/part}}',
			'Two parts are named "a"',
		],
	])('refuses %p', (source, message) => {
		expect(() => collectParts(source, {})).toThrow(TemplateRenderError);
		expect(() => collectParts(source, {})).toThrow(message);
	});
});

describe('assembleNote', () => {
	it('writes each result in its place and under parts', () => {
		const note = assembleNote(
			[
				'# {{title}}',
				'',
				'## Summary',
				'',
				'{{#part "summary"}}x{{/part}}',
				'',
				'{{#if parts.summary}}Has a summary.{{/if}}',
				'',
				'{{transcript}}',
			].join('\n'),
			context,
			new Map([['summary', 'They agreed.']]),
		);

		expect(note).toBe(
			'# Weekly sync\n\n## Summary\n\nThey agreed.\n\nHas a summary.\n\nAnna: hi',
		);
	});

	it('drops an empty part with its heading and keeps the next section', () => {
		const note = assembleNote(
			[
				'## Blockers',
				'',
				'{{#part "blockers"}}x{{/part}}',
				'',
				'## Notes',
				'',
				'Kept.',
			].join('\n'),
			{},
			new Map([['blockers', '']]),
		);

		expect(note).toBe('## Notes\n\nKept.');
	});

	it('keeps an empty part as nothing or writes the text it gives', () => {
		const source =
			'## A\n\n{{#part "a" empty="keep"}}x{{/part}}\n\n## B\n\n{{#part "b" empty="Nothing found."}}x{{/part}}';

		expect(assembleNote(source, {}, new Map())).toBe(
			'## A\n\n## B\n\nNothing found.',
		);
	});

	it('leaves the template unchanged by a part no result was given for', () => {
		expect(
			assembleNote('Before {{#part "a"}}x{{/part}} after', {}, new Map()),
		).toBe('Before  after');
	});
});

describe('removeEmptySections', () => {
	const removed = assembleNote('{{#part "a"}}x{{/part}}', {}, new Map());

	it('takes out a removed part that stands alone', () => {
		expect(removed).toBe('');
	});

	it.each([
		[
			'keeps a heading whose section holds other text',
			'## A\n\nIntro.\n\n{{#part "a"}}x{{/part}}',
			'## A\n\nIntro.',
		],
		[
			'keeps a heading with text after the part',
			'## A\n\n{{#part "a"}}x{{/part}}\n\nAfter.',
			'## A\n\nAfter.',
		],
		[
			'keeps a heading with a subsection that holds text',
			'## A\n\n{{#part "a"}}x{{/part}}\n\n### Sub\n\nText.',
			'## A\n\n### Sub\n\nText.',
		],
		[
			'drops a heading whose section held only removed parts',
			'## A\n\n{{#part "a"}}x{{/part}}\n{{#part "b"}}x{{/part}}\n\n# Next',
			'# Next',
		],
		[
			'keeps text that is not a heading above the part',
			'Plain line\n\n{{#part "a"}}x{{/part}}',
			'Plain line',
		],
	])('%s', (_title, source, expected) => {
		expect(assembleNote(source, {}, new Map())).toBe(expected);
	});

	it('leaves text without removed parts as it is, trimmed', () => {
		expect(removeEmptySections('\n\na\n\n\n\nb\n')).toBe('a\n\nb');
	});
});

describe('noteTemplateEngine', () => {
	it('knows the part block and the names a note template uses', () => {
		const engine = noteTemplateEngine();

		expect(engine).toBe(noteTemplateEngine());
		expect(engine.helpers.map((helper) => helper.name)).toContain('part');
		expect(
			engine.validate(
				'{{#part "a"}}{{title}}{{/part}}{{parts.a}}{{transcript}}',
				NOTE_TEMPLATE_VARIABLES,
			),
		).toEqual([]);
		expect(engine.render('{{#part "a"}}x{{/part}}', {})).toBe('');
	});
});
