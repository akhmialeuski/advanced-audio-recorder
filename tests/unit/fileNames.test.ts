/**
 * Tests for turning free text into something a vault path can carry. Two
 * callers depend on it - a recording named from a template and a split part
 * named after its chapter - so a character safe in one place cannot be unsafe
 * in the other.
 */

import {
	foldSeparators,
	sanitizeFileNameSegment,
	toFileNameSegment,
	truncateToBytes,
	uniqueName,
	utf8ByteLength,
} from 'src/utils/fileNames';

describe('replacing what a path cannot carry', () => {
	it.each([
		{ char: 'a slash', text: 'a/b', expected: 'a-b' },
		{ char: 'a backslash', text: 'a\\b', expected: 'a-b' },
		{ char: 'a colon', text: 'a:b', expected: 'a-b' },
		{ char: 'an asterisk', text: 'a*b', expected: 'a-b' },
		{ char: 'a question mark', text: 'a?b', expected: 'a-b' },
		{ char: 'a quotation mark', text: 'a"b', expected: 'a-b' },
		{ char: 'an angle bracket', text: 'a<b>c', expected: 'a-b-c' },
		{ char: 'a pipe', text: 'a|b', expected: 'a-b' },
	])('replaces $char', ({ text, expected }) => {
		expect(sanitizeFileNameSegment(text)).toBe(expected);
	});

	it('leaves a dot alone, which is legal inside a name', () => {
		expect(sanitizeFileNameSegment('take.1.wav')).toBe('take.1.wav');
	});
});

describe('turning a title into a file-name segment', () => {
	it('keeps an ordinary title as it is', () => {
		expect(toFileNameSegment('The middle', 'part')).toBe('The middle');
	});

	it('folds a dot in, which would read as an extension boundary', () => {
		expect(toFileNameSegment('Part 1.2', 'part')).toBe('Part 1-2');
	});

	it('collapses a run of separators rather than leaving a row of dashes', () => {
		expect(toFileNameSegment('A // B', 'part')).toBe('A - B');
	});

	it('trims the separators off the ends', () => {
		expect(toFileNameSegment('/ Intro /', 'part')).toBe('Intro');
	});

	it.each([
		{ case: 'an empty title', title: '' },
		{ case: 'a title of only spaces', title: '   ' },
		{ case: 'a title of only punctuation', title: '///' },
	])('falls back for $case', ({ title }) => {
		expect(toFileNameSegment(title, 'talk-3')).toBe('talk-3');
	});
});

describe('folding the separators of a name', () => {
	it('keeps a dot, which only the free-text rule folds in', () => {
		expect(foldSeparators('v1.2 rec', 'part')).toBe('v1.2 rec');
	});

	it('collapses a run of dashes and trims the ends', () => {
		expect(foldSeparators('- a---b -', 'part')).toBe('a-b');
	});

	it('falls back when nothing is left', () => {
		expect(foldSeparators(' - ', 'part')).toBe('part');
	});
});

describe('measuring a name in bytes', () => {
	it.each([
		{ width: 'one byte', text: 'a', bytes: 1 },
		{ width: 'two bytes', text: 'Я', bytes: 2 },
		{ width: 'three bytes', text: '€', bytes: 3 },
		{ width: 'four bytes as one code point', text: '😀', bytes: 4 },
	])('counts a character of $width', ({ text, bytes }) => {
		expect(utf8ByteLength(text)).toBe(bytes);
	});
});

describe('cutting a name to a byte budget', () => {
	it('leaves a text that fits', () => {
		expect(truncateToBytes('Intro', 10)).toBe('Intro');
	});

	it('cuts at the last whole character that fits', () => {
		expect(truncateToBytes('ЯЯЯ', 5)).toBe('ЯЯ');
	});

	it('never splits a character of four bytes', () => {
		expect(truncateToBytes('😀😀', 7)).toBe('😀');
	});

	it('gives an empty text for a budget of zero', () => {
		expect(truncateToBytes('abc', 0)).toBe('');
	});
});

describe('making a name unique', () => {
	it('leaves a name nothing else took', () => {
		expect(uniqueName('Intro', new Set())).toBe('Intro');
	});

	it('numbers the second of two chapters with one title', () => {
		// Two chapters can share a title; two files cannot share a name
		const taken = new Set<string>();

		expect(uniqueName('Intro', taken)).toBe('Intro');
		expect(uniqueName('Intro', taken)).toBe('Intro-2');
		expect(uniqueName('Intro', taken)).toBe('Intro-3');
	});

	it('remembers what it handed out, so the next call avoids it', () => {
		const taken = new Set<string>();
		uniqueName('Intro', taken);

		expect(taken.has('Intro')).toBe(true);
	});
});
