/**
 * Tests for the pure audio-link parsing helpers. Finding the link under a
 * cursor is the shared source-line reader's job, tested with it in
 * sourceLinks.test.ts.
 */

import {
	parseAudioLinkTarget,
	parseTimecodeSubpath,
	hasTimecodeSubpath,
	isAudioFile,
} from 'src/player/timecodeLinks';
import { createFile } from '../helpers/createApp';

describe('parseAudioLinkTarget', () => {
	it('returns the path and no offset when there is no subpath', () => {
		expect(parseAudioLinkTarget('rec.webm')).toEqual({
			linkPath: 'rec.webm',
			startSeconds: null,
		});
	});

	it('parses a #t= seconds offset', () => {
		expect(parseAudioLinkTarget('rec.webm#t=90')).toEqual({
			linkPath: 'rec.webm',
			startSeconds: 90,
		});
	});

	it('parses a #t= m:ss offset', () => {
		expect(parseAudioLinkTarget('folder/rec.webm#t=1:30')).toEqual({
			linkPath: 'folder/rec.webm',
			startSeconds: 90,
		});
	});

	it('ignores non-timecode subpaths', () => {
		expect(parseAudioLinkTarget('rec.webm#heading')).toEqual({
			linkPath: 'rec.webm',
			startSeconds: null,
		});
	});

	it('yields a null offset for a malformed timecode', () => {
		expect(parseAudioLinkTarget('rec.webm#t=abc')).toEqual({
			linkPath: 'rec.webm',
			startSeconds: null,
		});
	});
});

describe('isAudioFile', () => {
	it('accepts supported audio extensions regardless of case', () => {
		expect(isAudioFile(createFile('a/rec.WEBM'))).toBe(true);
		expect(isAudioFile(createFile('a/rec.mp3'))).toBe(true);
		expect(isAudioFile(createFile('a/rec.flac'))).toBe(true);
	});

	it('rejects non-audio extensions', () => {
		expect(isAudioFile(createFile('a/note.md'))).toBe(false);
		expect(isAudioFile(createFile('a/image.png'))).toBe(false);
	});
});

describe('parseTimecodeSubpath', () => {
	it('parses a t= subpath in each timecode format', () => {
		expect(parseTimecodeSubpath('t=90')).toBe(90);
		expect(parseTimecodeSubpath('t=1:30')).toBe(90);
		expect(parseTimecodeSubpath('t=1:02:03')).toBe(3723);
	});

	it('tolerates a leading hash', () => {
		expect(parseTimecodeSubpath('#t=1:30')).toBe(90);
	});

	it('returns null for non-timecode or malformed subpaths', () => {
		expect(parseTimecodeSubpath('')).toBeNull();
		expect(parseTimecodeSubpath('heading')).toBeNull();
		expect(parseTimecodeSubpath('t=abc')).toBeNull();
	});
});

describe('hasTimecodeSubpath', () => {
	it.each([
		{ name: 'a timecode', subpath: '#t=90', expected: true },
		{
			name: 'a timecode without its hash',
			subpath: 't=1:30',
			expected: true,
		},
		{ name: 'an unreadable timecode', subpath: '#t=abc', expected: true },
		{ name: 'a heading', subpath: '#Intro', expected: false },
		{
			name: 'a heading starting with t',
			subpath: '#title',
			expected: false,
		},
		{ name: 'no subpath', subpath: '', expected: false },
	])('answers $expected for $name', ({ subpath, expected }) => {
		expect(hasTimecodeSubpath(subpath)).toBe(expected);
	});
});
