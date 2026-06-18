/**
 * Tests for the pure audio-link parsing helpers.
 */

import { TFile } from 'obsidian';
import {
	parseAudioLinkTarget,
	parseTimecodeSubpath,
	isAudioFile,
} from 'src/player/timecodeLinks';

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
		expect(isAudioFile(new TFile('a/rec.WEBM'))).toBe(true);
		expect(isAudioFile(new TFile('a/rec.mp3'))).toBe(true);
		expect(isAudioFile(new TFile('a/rec.flac'))).toBe(true);
	});

	it('rejects non-audio extensions', () => {
		expect(isAudioFile(new TFile('a/note.md'))).toBe(false);
		expect(isAudioFile(new TFile('a/image.png'))).toBe(false);
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
