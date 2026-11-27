/**
 * Unit tests for the formats a part of a note template takes: what each one
 * asks the model for, how it reads the answer, and the Markdown it writes.
 * @module tests/unit/partFormats.test
 */

import {
	answerTerms,
	DEFAULT_PART_FORMAT,
	type PartShape,
	formatOf,
	partFormat,
	partFormats,
} from 'src/templates/partFormats';

/**
 * The Markdown a format writes for an answer.
 * @param id - The format
 * @param answer - What the model answered
 * @param shape - The part's settings besides the format
 */
function written(
	id: string,
	answer: unknown,
	shape: Partial<PartShape> = {},
): string {
	const format = formatOf(id);
	const full: PartShape = { options: {}, ...shape };
	return format.render(format.read(answer, full), full);
}

describe('partFormat', () => {
	it('finds a format by name and nothing for an unknown one', () => {
		expect(partFormat(DEFAULT_PART_FORMAT)?.id).toBe('prose');
		expect(partFormat('mermaid')).toBeUndefined();
		expect(formatOf('mermaid').id).toBe('prose');
		expect(partFormats().map((format) => format.id)).toEqual([
			'prose',
			'bullets',
			'numbered',
			'tasks',
			'decisions',
			'terms',
			'outline',
			'quotes',
			'table',
			'callout',
		]);
	});

	it('describes every format to the model and in the list of formats', () => {
		for (const format of partFormats()) {
			expect(format.contract({ options: { columns: 'A' } })).not.toBe('');
			expect(format.description).not.toBe('');
		}
	});
});

describe('prose and lists', () => {
	it('writes prose as it came back, with links a model wrote shown as text', () => {
		expect(written('prose', ' See [[Atlas]] and ![[img.png]]. ')).toBe(
			'See \\[\\[Atlas]] and !\\[\\[img.png]].',
		);
		expect(written('prose', ['One.', 3, 'Two.'])).toBe('One.\n\nTwo.');
		expect(written('prose', { text: 'x' })).toBe('');
	});

	it('writes bullets and numbered steps up to the limit, one line each', () => {
		expect(written('bullets', ['a', 'b\nc', 'd'], { max: 2 })).toBe(
			'- a\n- b c',
		);
		expect(written('numbered', '1. first\n2) second')).toBe(
			'1. first\n2. second',
		);
	});

	it('repairs the lists models predictably send instead', () => {
		expect(
			written('bullets', [
				{ text: 'wrapped' },
				42,
				'- [x] marked',
				null,
				'',
			]),
		).toBe('- wrapped\n- 42\n- marked');
		expect(written('bullets', { point: 'only one' })).toBe('- only one');
		expect(written('bullets', 'text')).toBe('- text');
		expect(written('bullets', [[1]])).toBe('');
	});

	it('writes nothing for a value of the other kind', () => {
		const bullets = formatOf('bullets');
		const prose = formatOf('prose');

		expect(bullets.render('text', { options: {} })).toBe('');
		expect(prose.render(['a'], { options: {} })).toBe('');
	});
});

describe('tasks', () => {
	const answer = [
		{ text: 'Send the deck', owner: 'Ben', due: '2026-10-01' },
		{ Text: 'Book a room', Owner: '', due: 'next week' },
		'Call the client',
		{ owner: 'Anna' },
		{ task: 'Renamed field', owner: 'Ben' },
	];

	it.each([
		[
			'plain',
			'- [ ] Send the deck (Ben, due 2026-10-01)\n- [ ] Book a room\n- [ ] Call the client\n- [ ] Renamed field (Ben)',
		],
		[
			'dataview',
			'- [ ] Send the deck [owner:: Ben] [due:: 2026-10-01]\n- [ ] Book a room\n- [ ] Call the client\n- [ ] Renamed field [owner:: Ben]',
		],
		[
			'tasks',
			'- [ ] Send the deck (Ben) 📅 2026-10-01\n- [ ] Book a room\n- [ ] Call the client\n- [ ] Renamed field (Ben)',
		],
		[
			'unknown',
			'- [ ] Send the deck (Ben, due 2026-10-01)\n- [ ] Book a room\n- [ ] Call the client\n- [ ] Renamed field (Ben)',
		],
	])('writes the %s style', (style, expected) => {
		expect(written('tasks', answer, { options: { style } })).toBe(expected);
	});

	it('writes an owner without a date and a date without an owner', () => {
		expect(
			written('tasks', [
				{ text: 'a', owner: 'Ben' },
				{ text: 'b', due_date: '2026-01-02', dueDate: 'x' },
			]),
		).toBe('- [ ] a (Ben)\n- [ ] b');
		expect(
			written('tasks', [{ text: 'b', due: '2026-01-02' }], {
				options: { style: 'dataview' },
			}),
		).toBe('- [ ] b [due:: 2026-01-02]');
		expect(
			written('tasks', [{ text: 'b', owner: 'Ann' }], {
				options: { style: 'tasks' },
			}),
		).toBe('- [ ] b (Ann)');
	});

	it('accepts only the styles it writes', () => {
		const check = formatOf('tasks').check;

		expect(check?.({})).toEqual([]);
		expect(check?.({ style: 'dataview' })).toEqual([]);
		expect(check?.({ style: 'org' })).toEqual([
			'needs style to be plain, dataview or tasks.',
		]);
	});
});

describe('records with a lead', () => {
	it('writes decisions with their reasons and terms with their meaning', () => {
		expect(
			written('decisions', [
				{ decision: 'Ship Friday', reason: 'QA is done' },
				{ decision: 'Drop the beta' },
			]),
		).toBe('- **Ship Friday**: QA is done\n- **Drop the beta**');
		expect(
			written('terms', [
				{ term: 'OKR', definition: 'Objectives and key results' },
			]),
		).toBe('- **OKR**: Objectives and key results');
	});

	it('writes topics with their points nested under them', () => {
		expect(
			written('outline', [
				{
					title: 'Budget',
					points: ['Over by 5%', '', 'Freeze hiring'],
				},
				{ title: 'Hiring' },
			]),
		).toBe('- **Budget**\n\t- Over by 5%\n\t- Freeze hiring\n- **Hiring**');
	});
});

describe('quotes', () => {
	const answer = [
		{ quote: 'We ship Friday.', speaker: 'Anna', time: '1:05' },
		{ quote: 'Fine.', time: 30 },
		{ quote: 'Who knows.', speaker: 'Ben', time: 'soon' },
		{ quote: 'Alone.' },
	];

	it('writes who said each quote and links the moment', () => {
		expect(
			written('quotes', answer, {
				links: (seconds) => `[[rec.webm#t=${String(seconds)}|x]]`,
			}),
		).toBe(
			[
				'> We ship Friday.\n> - Anna, [[rec.webm#t=65|x]]',
				'> Fine.\n> - [[rec.webm#t=30|x]]',
				'> Who knows.\n> - Ben',
				'> Alone.',
			].join('\n\n'),
		);
	});

	it('writes the timecode where no link can be written', () => {
		expect(written('quotes', [answer[0]])).toBe(
			'> We ship Friday.\n> - Anna, 1:05',
		);
	});
});

describe('table', () => {
	const columns = { columns: 'Owner, Task ,, Due' };

	it('writes the columns the part names, escaping what would break a row', () => {
		expect(
			written(
				'table',
				[
					{ owner: 'Ben', task: 'Send a|b\ndeck' },
					{ Owner: 'Anna', Due: '2026-10-01' },
				],
				{ options: columns },
			),
		).toBe(
			'| Owner | Task | Due |\n| --- | --- | --- |\n| Ben | Send a\\|b deck |  |\n| Anna |  | 2026-10-01 |',
		);
	});

	it('names its columns to the model', () => {
		expect(formatOf('table').contract({ options: columns })).toBe(
			'an array of objects, one per item, with "Owner" (a short text), "Task" (a short text), "Due" (a short text)',
		);
	});

	it('writes nothing without columns or rows, and asks for its columns', () => {
		expect(written('table', [{ a: 'x' }])).toBe('');
		expect(written('table', [], { options: columns })).toBe('');
		expect(formatOf('table').check?.({})).toEqual([
			'needs its columns, e.g. columns="Owner, Task, Due".',
		]);
		expect(formatOf('table').check?.(columns)).toEqual([]);
	});
});

describe('callout', () => {
	it.each([
		[{}, '> [!note]\n> One.\n>\n> Two.'],
		[
			{ type: 'Tip!', title: 'Key\npoints' },
			'> [!tip] Key points\n> One.\n>\n> Two.',
		],
		[{ folded: true, type: '%%' }, '> [!note]-\n> One.\n>\n> Two.'],
		[{ folded: false }, '> [!note]+\n> One.\n>\n> Two.'],
	])('writes %p', (options, expected) => {
		expect(written('callout', 'One.\n\nTwo.', { options })).toBe(expected);
	});

	it('writes nothing for nothing found', () => {
		expect(written('callout', '')).toBe('');
	});
});

describe('answerTerms', () => {
	it('reads the terms of a glossary answer, as spelled', () => {
		expect(
			answerTerms('terms', [
				{ term: 'Argo CD', definition: 'Deploys the services.' },
				{ term: '', definition: 'Nothing.' },
				{ definition: 'No term.' },
				{ term: 'SLO' },
			]),
		).toEqual(['Argo CD', 'SLO']);
	});

	it.each([
		['another format', 'bullets', ['Argo CD']],
		['no answer', 'terms', undefined],
		['a null answer', 'terms', null],
	])('reads none from %s', (_label, format, answer) => {
		expect(answerTerms(format, answer)).toEqual([]);
	});
});
