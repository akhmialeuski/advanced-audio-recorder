/**
 * Tests for the scanner of a note's timecode references and for the builder
 * of the links it reads back.
 */

import {
	audioTimecodeRefs,
	lineTimecodeRef,
	timecodeLinkBuilder,
} from 'src/obsidian/timecodeRefs';
import { createFile, createMockApp } from '../helpers/createApp';
import { cachedLink } from '../helpers/transcriptFixtures';

const note = createFile('Notes/meeting.md');
const audio = createFile('audio/rec.m4a');

/** An app whose note carries the given links; only rec.m4a resolves. */
function appWithLinks(links: unknown[]) {
	return createMockApp({
		metadataCache: {
			getFileCache: () => ({ links }),
			getFirstLinkpathDest: (path: string) =>
				path === 'rec.m4a' ? audio : null,
		},
	}).app;
}

describe('audioTimecodeRefs', () => {
	it('skips a timecode link that resolves to no file', () => {
		const app = appWithLinks([
			cachedLink('gone.m4a#t=5', 0, 0, 20),
			cachedLink('rec.m4a#t=9', 1, 0, 20),
		]);

		expect(audioTimecodeRefs(app, note, audio.path)).toEqual([
			{ startLine: 1, endLine: 1, seconds: 9 },
		]);
	});
});

describe('lineTimecodeRef', () => {
	it('takes the first timecode link on the line', () => {
		const app = appWithLinks([]);

		expect(
			lineTimecodeRef(
				app,
				note,
				'[[rec.m4a#t=12|0:12]] **Bob** see [[rec.m4a#t=30|0:30]]',
			),
		).toEqual({ file: audio, seconds: 12 });
	});

	it('skips a timecode link that resolves to no file', () => {
		const app = appWithLinks([]);

		expect(
			lineTimecodeRef(
				app,
				note,
				'[[gone.m4a#t=5|0:05]] [[rec.m4a#t=9|0:09]] Hello',
			),
		).toEqual({ file: audio, seconds: 9 });
	});

	it('finds nothing on a line without a timecode link', () => {
		const app = appWithLinks([]);

		expect(lineTimecodeRef(app, note, '![[rec.m4a]] Hello')).toBeNull();
	});

	it('keeps a Markdown link target whose escape is malformed as written', () => {
		const app = createMockApp({
			metadataCache: {
				getFirstLinkpathDest: (path: string) =>
					path === 'audio/rec%zz.m4a' ? audio : null,
			},
		}).app;

		expect(
			lineTimecodeRef(app, note, '[0:05](audio/rec%zz.m4a#t=5) Hello'),
		).toEqual({ file: audio, seconds: 5 });
	});

	it.each([
		['an encoded', '[0:05](audio/rec%20one.m4a#t=5) Hello'],
		['a bracketed', '[0:05](<audio/rec one.m4a#t=5>) Hello'],
	])('reads %s Markdown link target', (_kind, line) => {
		const app = createMockApp({
			metadataCache: {
				getFirstLinkpathDest: (path: string) =>
					path === 'audio/rec one.m4a' ? audio : null,
			},
		}).app;

		expect(lineTimecodeRef(app, note, line)).toEqual({
			file: audio,
			seconds: 5,
		});
	});
});

describe('timecodeLinkBuilder', () => {
	it('links whole seconds into the recording', () => {
		const app = createMockApp().app;
		jest.mocked(app.fileManager.generateMarkdownLink).mockImplementation(
			(_file, _source, subpath, alias) =>
				`[[rec.m4a${subpath}|${alias}]]`,
		);

		expect(timecodeLinkBuilder(app, audio, note.path)(83.7, '1:23')).toBe(
			'[[rec.m4a#t=83|1:23]]',
		);
	});
});
