/**
 * Tests for the reader of links in a line of note source, which the editor
 * menu, the player menu, Live Preview timecode clicks and the transcript-line
 * lookup all share.
 */

import { linkAtColumn, linksInLine } from 'src/obsidian/sourceLinks';

describe('linksInLine', () => {
	it.each([
		{
			name: 'a wikilink',
			line: '[[rec.m4a]]',
			link: 'rec.m4a',
			path: 'rec.m4a',
			subpath: '',
		},
		{
			name: 'an aliased timecode wikilink',
			line: '[[rec.m4a#t=30|0:30]]',
			link: 'rec.m4a#t=30',
			path: 'rec.m4a',
			subpath: '#t=30',
		},
		{
			name: 'an aliased wikilink inside a table row',
			line: '[[rec.m4a#t=30\\|0:30]]',
			link: 'rec.m4a#t=30',
			path: 'rec.m4a',
			subpath: '#t=30',
		},
		{
			name: 'a wikilink whose name holds a backslash',
			line: '[[a\\b.m4a]]',
			link: 'a\\b.m4a',
			path: 'a\\b.m4a',
			subpath: '',
		},
		{
			name: 'an encoded Markdown link',
			line: '[0:05](audio/rec%20one.m4a#t=5)',
			link: 'audio/rec one.m4a#t=5',
			path: 'audio/rec one.m4a',
			subpath: '#t=5',
		},
		{
			name: 'a Markdown link in angle brackets',
			line: '[take](<audio/rec one.m4a>)',
			link: 'audio/rec one.m4a',
			path: 'audio/rec one.m4a',
			subpath: '',
		},
		{
			name: 'a Markdown link whose target holds parentheses',
			line: '[take](rec%20(1).m4a)',
			link: 'rec (1).m4a',
			path: 'rec (1).m4a',
			subpath: '',
		},
		{
			name: 'a Markdown link with a title',
			line: '[take](rec.m4a "The take")',
			link: 'rec.m4a',
			path: 'rec.m4a',
			subpath: '',
		},
		{
			name: 'a Markdown link whose escape is malformed, as written',
			line: '[take](rec%zz.m4a)',
			link: 'rec%zz.m4a',
			path: 'rec%zz.m4a',
			subpath: '',
		},
	])('reads $name', ({ line, link, path, subpath }) => {
		expect(linksInLine(line)).toEqual([
			{ start: 0, end: line.length, embed: false, link, path, subpath },
		]);
	});

	it('marks an embed and counts its marker in the span', () => {
		expect(linksInLine('See ![[rec.m4a|300]] here')).toEqual([
			{
				start: 4,
				end: 20,
				embed: true,
				link: 'rec.m4a',
				path: 'rec.m4a',
				subpath: '',
			},
		]);
	});

	it('lists every link of a line in order', () => {
		const line = '[[a.m4a#t=1|0:01]] then ![b](b.m4a) and [[c]]';

		expect(linksInLine(line).map((link) => link.link)).toEqual([
			'a.m4a#t=1',
			'b.m4a',
			'c',
		]);
	});

	it.each([
		{ name: 'an empty line', line: '' },
		{ name: 'plain text', line: 'just words' },
		{ name: 'an unclosed wikilink', line: '[[rec.m4a' },
		{ name: 'an empty wikilink', line: '[[]]' },
	])('finds nothing in $name', ({ line }) => {
		expect(linksInLine(line)).toEqual([]);
	});
});

describe('linkAtColumn', () => {
	const line = 'Text [[rec.m4a#t=5|0:05]] Text';

	it.each([
		{ name: 'its first column', ch: 5 },
		{ name: 'its alias', ch: 20 },
		{ name: 'its last character', ch: 24 },
		// A right-click on the right half of the closing bracket places the
		// caret here, just past the link.
		{ name: 'the column it ends at', ch: 25 },
	])('answers the link at $name', ({ ch }) => {
		expect(linkAtColumn(line, ch)?.link).toBe('rec.m4a#t=5');
	});

	it.each([
		{ name: 'before it', ch: 4 },
		{ name: 'one past its end', ch: 26 },
	])('answers nothing $name', ({ ch }) => {
		expect(linkAtColumn(line, ch)).toBeNull();
	});

	it('prefers the link that starts where the previous one ends', () => {
		expect(linkAtColumn('[[a.m4a]][[b.m4a]]', 9)?.link).toBe('b.m4a');
	});

	it('answers the span the link occupies', () => {
		expect(linkAtColumn(line, 10)).toMatchObject({ start: 5, end: 25 });
	});
});
