/**
 * Tests the placement of text in a note written through the vault: the route
 * a note takes when no editor is editing it, as in Reading view.
 * @module tests/unit/noteText.test
 */

import {
	lineBreakOf,
	lineOfText,
	withBlockInserted,
	withLinesInserted,
} from 'src/utils/noteText';

describe('withLinesInserted', () => {
	it('adds the lines after the named line', () => {
		expect(withLinesInserted('one\ntwo\nthree\n', 'X\nY', 0)).toBe(
			'one\nX\nY\ntwo\nthree\n',
		);
	});

	it('adds at the end of a note that closes with a line break', () => {
		expect(withLinesInserted('one\ntwo\n', 'X', null)).toBe(
			'one\ntwo\nX\n',
		);
	});

	it('closes a note that had no last line break', () => {
		expect(withLinesInserted('one\ntwo', 'X', null)).toBe('one\ntwo\nX\n');
	});

	it('treats a line past the end as the end', () => {
		// The note got shorter between the capture of the line and the write.
		expect(withLinesInserted('one\n', 'X', 40)).toBe('one\nX\n');
	});

	it('fills an empty note', () => {
		expect(withLinesInserted('', 'X', null)).toBe('X\n');
	});

	it('keeps Windows line ends', () => {
		expect(withLinesInserted('one\r\ntwo\r\n', 'X\nY', 0)).toBe(
			'one\r\nX\r\nY\r\ntwo\r\n',
		);
	});
});

describe('withBlockInserted', () => {
	it('sets the block off by a blank line on each side', () => {
		expect(withBlockInserted('one\ntwo\n', '## T\n\nbody', 0)).toBe(
			'one\n\n## T\n\nbody\n\ntwo\n',
		);
	});

	it('adds no second blank line where the note already has one', () => {
		expect(withBlockInserted('one\n\ntwo\n', 'body', 1)).toBe(
			'one\n\nbody\n\ntwo\n',
		);
	});

	it('ends the note with the block when added at its end', () => {
		expect(withBlockInserted('one', 'body', null)).toBe('one\n\nbody\n');
	});

	it('opens an empty note with the block', () => {
		expect(withBlockInserted('', 'body', null)).toBe('body\n');
	});
});

describe('lineOfText', () => {
	it('is the line the text starts on', () => {
		expect(lineOfText('one\n![[a.webm]]\nthree', '![[a.webm]]')).toBe(1);
	});

	it('is nothing for text the note does not hold', () => {
		expect(lineOfText('one\ntwo', '![[a.webm]]')).toBeNull();
	});
});

describe('lineBreakOf', () => {
	it('tells a note written with Windows line ends from one without', () => {
		expect(lineBreakOf('a\r\nb')).toBe('\r\n');
		expect(lineBreakOf('a\nb')).toBe('\n');
	});
});
