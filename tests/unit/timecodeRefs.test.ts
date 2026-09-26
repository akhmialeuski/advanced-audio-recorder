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
		const app = appWithLinks([
			cachedLink('rec.m4a#t=30', 2, 40, 60),
			cachedLink('rec.m4a#t=12', 2, 0, 20),
		]);

		expect(lineTimecodeRef(app, note, 2)).toEqual({
			file: audio,
			seconds: 12,
			startCol: 0,
			endCol: 20,
		});
	});

	it('finds nothing on a line without a timecode link', () => {
		const app = appWithLinks([cachedLink('rec.m4a', 2, 0, 12)]);

		expect(lineTimecodeRef(app, note, 2)).toBeNull();
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
