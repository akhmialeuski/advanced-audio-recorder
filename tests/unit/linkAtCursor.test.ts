/**
 * Tests for finding the link a cursor stands on in one line of note source,
 * which is what the editor menu and the palette resolve a recording from.
 * @module tests/unit/linkAtCursor.test
 */

import { linkAtCursor } from 'src/obsidian/linkAtCursor';

describe('the link at a cursor', () => {
	it.each([
		{ name: 'an embed', line: '![[rec.webm]]', path: 'rec.webm' },
		{ name: 'a wikilink', line: '[[rec.webm]]', path: 'rec.webm' },
		{
			name: 'a wikilink with an alias',
			line: '[[rec.webm|Call]]',
			path: 'rec.webm',
		},
		{
			name: 'a Markdown embed',
			line: '![call](rec.webm)',
			path: 'rec.webm',
		},
		{
			name: 'a Markdown link',
			line: '[call](Recordings/rec.webm)',
			path: 'Recordings/rec.webm',
		},
	])('finds $name', ({ line, path }) => {
		expect(linkAtCursor(line, 3)).toEqual({
			path,
			start: 0,
			end: line.length,
		});
	});

	it.each([
		{ name: 'at its first character', ch: 5 },
		{ name: 'just past its last one', ch: 17 },
	])('finds a link with the cursor $name', ({ ch }) => {
		expect(linkAtCursor('Text [[rec.webm]] text', ch)).toEqual({
			path: 'rec.webm',
			start: 5,
			end: 17,
		});
	});

	it('finds the link the cursor is on, not the first of the line', () => {
		expect(linkAtCursor('[[a.webm]] and [[b.webm]]', 18)?.path).toBe(
			'b.webm',
		);
	});

	it.each([
		{ name: 'on text beside a link', line: 'Text [[rec.webm]]', ch: 2 },
		{ name: 'on a line without links', line: 'Just text', ch: 3 },
		{ name: 'on an empty line', line: '', ch: 0 },
	])('finds nothing $name', ({ line, ch }) => {
		expect(linkAtCursor(line, ch)).toBeNull();
	});
});
