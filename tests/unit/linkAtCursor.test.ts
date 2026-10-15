/**
 * Tests for finding the link a cursor stands on in one line of note source,
 * which is what the editor menu and the palette resolve a recording from.
 * @module tests/unit/linkAtCursor.test
 */

import { linkAtCursor, pointsAtWholeFile } from 'src/obsidian/linkAtCursor';

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
		{
			ch: 15,
			path: 'rec.webm',
			why: 'where one link ends and the next begins',
		},
		{ ch: 3, path: 'intro.webm', why: 'inside the first' },
		{ ch: 28, path: 'rec.webm', why: 'just past the last' },
	])('finds the right one of two links that touch: $why', ({ ch, path }) => {
		expect(linkAtCursor('![[intro.webm]]![[rec.webm]]', ch)?.path).toBe(
			path,
		);
	});

	it.each([
		{ ch: 13, path: 'rec.webm' },
		{ ch: 28, path: 'notes.md' },
	])(
		'keeps a wikilink and a later Markdown link apart: column $ch',
		({ ch, path }) => {
			expect(
				linkAtCursor('![[rec.webm]] see [notes](notes.md)', ch)?.path,
			).toBe(path);
		},
	);

	it.each([
		{ name: 'a task box', line: '- [ ] see [call](rec.webm)' },
		{ name: 'a footnote', line: 'Note[^1] and [call](rec.webm)' },
	])('starts a Markdown link at its own bracket, after $name', ({ line }) => {
		const link = linkAtCursor(line, line.length - 3);

		expect(link?.path).toBe('rec.webm');
		expect(line.slice(link?.start, link?.end)).toBe('[call](rec.webm)');
	});

	it.each([
		{
			line: '![](Recording%202026-10-14.webm)',
			path: 'Recording 2026-10-14.webm',
		},
		{
			line: '![](<Recording 2026-10-14.webm>)',
			path: 'Recording 2026-10-14.webm',
		},
		{ line: '[50% off](deal%.webm)', path: 'deal%.webm' },
	])('reads the target of $line as the vault names it', ({ line, path }) => {
		expect(linkAtCursor(line, 5)?.path).toBe(path);
	});

	it.each([
		{ name: 'on text beside a link', line: 'Text [[rec.webm]]', ch: 2 },
		{ name: 'on a line without links', line: 'Just text', ch: 3 },
		{ name: 'on an empty line', line: '', ch: 0 },
	])('finds nothing $name', ({ line, ch }) => {
		expect(linkAtCursor(line, ch)).toBeNull();
	});
});

describe('whether a link points at a whole file', () => {
	it.each([
		{ path: 'rec.webm', whole: true },
		{ path: 'Recordings/rec.webm', whole: true },
		{ path: 'rec.webm#t=90', whole: false },
		{ path: 'Meeting#Decisions', whole: false },
	])('says $whole for $path', ({ path, whole }) => {
		expect(pointsAtWholeFile({ path })).toBe(whole);
	});
});
