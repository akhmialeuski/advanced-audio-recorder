/**
 * Unit tests for the formats a part of a note template takes.
 * @module tests/unit/partFormats.test
 */

import {
	DEFAULT_PART_FORMAT,
	answerItems,
	answerText,
	limited,
	partFormat,
	partFormats,
} from 'src/templates/partFormats';

describe('answerText', () => {
	it.each([
		['  A paragraph.  ', 'A paragraph.'],
		[['One.', ' ', 'Two.', 3], 'One.\n\nTwo.'],
		[{ text: 'x' }, ''],
		[null, ''],
	])('reads %p as %p', (answer, expected) => {
		expect(answerText(answer)).toBe(expected);
	});
});

describe('answerItems', () => {
	it.each([
		[
			['First', ' Second '],
			['First', 'Second'],
		],
		[
			'- one\n* two\n\n3. three\n- [x] four',
			['one', 'two', 'three', 'four'],
		],
		[
			[{ text: 'Call Ben', owner: 'Anna' }, 42, null, ''],
			['Call Ben', '42'],
		],
		[{ point: 'Only one' }, ['Only one']],
		[[{ count: 1 }], []],
	])('reads %p as %p', (answer, expected) => {
		expect(answerItems(answer)).toEqual(expected);
	});
});

describe('limited', () => {
	it('keeps every item without a limit and the first ones with one', () => {
		expect(limited([1, 2, 3], { options: {} })).toEqual([1, 2, 3]);
		expect(limited([1, 2, 3], { max: 2, options: {} })).toEqual([1, 2]);
	});
});

describe('partFormat', () => {
	it('finds a format by name and nothing for an unknown one', () => {
		expect(partFormat(DEFAULT_PART_FORMAT)?.id).toBe('prose');
		expect(partFormat('mermaid')).toBeUndefined();
		expect(partFormats().map((format) => format.id)).toEqual([
			'prose',
			'bullets',
		]);
	});

	it('writes prose as it came back and nothing for a list', () => {
		const prose = partFormat('prose');

		expect(prose?.render(prose.read(' Text. '), { options: {} })).toBe(
			'Text.',
		);
		expect(prose?.render(['a'], { options: {} })).toBe('');
	});

	it('writes bullets up to the limit and nothing for text', () => {
		const bullets = partFormat('bullets');

		expect(
			bullets?.render(bullets.read(['a', 'b', 'c']), {
				max: 2,
				options: {},
			}),
		).toBe('- a\n- b');
		expect(bullets?.render('a', { options: {} })).toBe('');
	});
});
