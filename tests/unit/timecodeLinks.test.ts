/**
 * Tests for the pure audio-link parsing helpers.
 */

import { TFile } from 'obsidian';
import {
	parseAudioLinkTarget,
	parseTimecodeSubpath,
	isAudioFile,
	wikiLinkTargetAtCursor,
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

describe('wikiLinkTargetAtCursor', () => {
	const line = '[[rec.mp4#t=30|0:30]] - Speaker 1: hello there';

	it('returns the link target without the alias when the cursor is inside', () => {
		// Cursor on the alias text still resolves to the underlying target
		expect(wikiLinkTargetAtCursor(line, 16)).toBe('rec.mp4#t=30');
		// Cursor at the very start of the link
		expect(wikiLinkTargetAtCursor(line, 0)).toBe('rec.mp4#t=30');
	});

	it('returns null when the cursor is outside every link', () => {
		expect(wikiLinkTargetAtCursor(line, 30)).toBeNull();
		expect(wikiLinkTargetAtCursor('no link here', 3)).toBeNull();
	});

	it('handles an embed link and a link without an alias', () => {
		expect(wikiLinkTargetAtCursor('![[rec.mp4#t=5]]', 6)).toBe(
			'rec.mp4#t=5',
		);
		expect(wikiLinkTargetAtCursor('[[rec.mp4#t=5]]', 5)).toBe(
			'rec.mp4#t=5',
		);
	});

	it('picks the link under the cursor when a line has several', () => {
		const many = '[[a.mp4#t=1|0:01]] and [[b.mp4#t=2|0:02]]';
		expect(wikiLinkTargetAtCursor(many, 3)).toBe('a.mp4#t=1');
		expect(wikiLinkTargetAtCursor(many, 26)).toBe('b.mp4#t=2');
	});
});
