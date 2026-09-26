/**
 * Tests for the pure model behind splitting a transcript line between
 * speakers: cutting the text at the selection, estimating the selection's
 * times, validating entered times, and the pieces the line becomes.
 */

import {
	afterSelection,
	buildSplitPieces,
	estimateSplitTimes,
	readSplitTimes,
	splitLineText,
	splitTimesProblem,
	type SplitTexts,
} from 'src/speakers/transcriptSplit';
import { seg, wordsOf } from '../helpers/transcriptFixtures';

const texts = (
	before: string,
	selected: string,
	after: string,
): SplitTexts => ({
	before,
	selected,
	after,
});

describe('splitLineText', () => {
	const line = '[[rec#t=5|0:05]] **Anna** one two three';
	const parsed = { speaker: 'Anna', textStart: 26, textEnd: line.length };

	it('cuts the text before, inside and after the selection', () => {
		const from = line.indexOf('two');

		expect(splitLineText(line, parsed, from, from + 3)).toEqual(
			texts('one', 'two', 'three'),
		);
	});

	it('clamps a selection that reaches into the speaker label', () => {
		expect(splitLineText(line, parsed, 20, line.indexOf(' two'))).toEqual(
			texts('', 'one', 'two three'),
		);
	});

	it('rejects a selection that holds no spoken text', () => {
		expect(splitLineText(line, parsed, 0, 10)).toBeNull();
	});
});

describe('estimateSplitTimes', () => {
	it('uses the word timings when they match the line word for word', () => {
		const timing = {
			start: 10,
			end: 16,
			words: wordsOf('a b c d e f', 10),
		};

		expect(estimateSplitTimes(timing, texts('a b', 'c d', 'e f'))).toEqual({
			start: 12,
			end: 14,
		});
	});

	it('shares the span out by length without word timings', () => {
		expect(
			estimateSplitTimes(
				{ start: 10, end: 20 },
				texts('aaaaa', 'bbbbb', ''),
			),
		).toEqual({ start: 15, end: 20 });
	});

	it('ends a selection that ends the line where the line does', () => {
		const timing = { start: 10, end: 14, words: wordsOf('a b c', 10) };

		expect(estimateSplitTimes(timing, texts('a', 'b c', ''))).toEqual({
			start: 11,
			end: 14,
		});
	});

	it('ends a selection at its last word when the line end is unknown', () => {
		const timing = { start: 10, end: null, words: wordsOf('a b', 10) };

		expect(estimateSplitTimes(timing, texts('a', 'b', ''))).toEqual({
			start: 11,
			end: 12,
		});
	});

	it('offers only the start of a line whose end is unknown', () => {
		expect(
			estimateSplitTimes({ start: 10, end: null }, texts('', 'x', 'y')),
		).toEqual({ start: 10, end: 10 });
	});
});

describe('splitTimesProblem', () => {
	const timing = { start: 10, end: 20 };

	it('accepts a span inside the line', () => {
		expect(
			splitTimesProblem(
				{ start: 12, end: 15 },
				timing,
				texts('a', 'b', 'c'),
			),
		).toBeNull();
	});

	it('rejects an end before the start', () => {
		expect(
			splitTimesProblem(
				{ start: 15, end: 12 },
				timing,
				texts('', 'b', ''),
			),
		).toMatch(/has to come after its start/);
	});

	it('keeps time for the text before the selection', () => {
		expect(
			splitTimesProblem(
				{ start: 10, end: 15 },
				timing,
				texts('a', 'b', ''),
			),
		).toMatch(/start after the line does/);
	});

	it('keeps time for the text after the selection', () => {
		expect(
			splitTimesProblem(
				{ start: 12, end: 20 },
				timing,
				texts('', 'b', 'c'),
			),
		).toMatch(/end before the line does/);
	});
});

describe('readSplitTimes', () => {
	const timing = { start: 10, end: 20 };

	it('reads the times the fields hold', () => {
		expect(
			readSplitTimes('0:12', '0:15.5', timing, texts('a', 'b', 'c')),
		).toEqual({ start: 12, end: 15.5 });
	});

	it('asks for both times', () => {
		expect(readSplitTimes('', '0:15', timing, texts('', 'b', ''))).toMatch(
			/Enter the start and the end/,
		);
	});

	it('says why times inside the field are refused', () => {
		expect(
			readSplitTimes('0:15', '0:12', timing, texts('', 'b', '')),
		).toMatch(/has to come after its start/);
	});
});

describe('afterSelection', () => {
	it('runs from the selection to the end of the line', () => {
		expect(
			afterSelection({ start: 0, end: 20 }, { start: 5, end: 8 }),
		).toEqual({ start: 8, end: 20 });
	});

	it('takes no time past the selection when the line end is unknown', () => {
		expect(
			afterSelection({ start: 0, end: null }, { start: 5, end: 8 }),
		).toEqual({ start: 8, end: 8 });
	});
});

describe('buildSplitPieces', () => {
	it('splits a line into three pieces around the selection', () => {
		expect(
			buildSplitPieces(
				{ start: 10, end: 20 },
				texts('one', 'two', 'three'),
				{ start: 12, end: 15 },
				{ row: 'Anna', selected: 'Bob', after: 'Anna' },
			),
		).toEqual([
			seg(10, 12, 'one', 'Anna'),
			seg(12, 15, 'two', 'Bob'),
			seg(15, 20, 'three', 'Anna'),
		]);
	});

	it('re-attributes the start of a line as a piece of its own', () => {
		expect(
			buildSplitPieces(
				{ start: 10, end: 20 },
				texts('', 'one', 'two'),
				{ start: 10, end: 12 },
				{ row: 'Anna', selected: 'Bob', after: 'Anna' },
			),
		).toEqual([seg(10, 12, 'one', 'Bob'), seg(12, 20, 'two', 'Anna')]);
	});

	it('takes the escaping the note added back off the text', () => {
		expect(
			buildSplitPieces(
				{ start: 10, end: 20 },
				texts('', '\\[\\[Topic\\]\\]', ''),
				{ start: 10, end: 20 },
				{ row: 'Anna', selected: 'Bob', after: undefined },
			)[0]?.text,
		).toBe('[[Topic]]');
	});
});
