/**
 * Tests for the three ways a recording's markers leave the plugin. Pure
 * functions, so the awkward cases are cheap to pin: a recording over an hour,
 * a chapter of no length, a title carrying the one character a cue sheet
 * cannot escape.
 */

import {
	formatChapterList,
	formatChapterOutline,
	formatCueSheet,
} from 'src/chapters/chapterExport';
import type { PlayerMarker } from 'src/markers/markerModel';

/** A marker of the given kind at the given offset. */
function marker(
	time: number,
	label: string,
	kind: PlayerMarker['kind'] = 'chapter',
	note?: string,
): PlayerMarker {
	return {
		id: `m${String(time)}`,
		time,
		label,
		kind,
		...(note ? { note } : {}),
	};
}

const TALK: PlayerMarker[] = [
	marker(0, 'Intro'),
	marker(125, 'The middle'),
	marker(3725, 'Questions'),
];

/** A link builder that renders what a vault link would carry. */
const link = (seconds: number, label: string): string =>
	`[[rec#t=${String(Math.floor(seconds))}|${label}]]`;

describe('the timecoded list a description box takes', () => {
	it('writes one line per marker, timecode first', () => {
		expect(formatChapterList([marker(0, 'Intro'), marker(125, 'Middle')]))
			.toBe(`0:00 Intro
2:05 Middle`);
	});

	it('widens every timecode to the longest, so the list reads as a column', () => {
		// A recording over an hour makes every line h:mm:ss, including 0:00
		expect(formatChapterList(TALK)).toBe(`0:00:00 Intro
0:02:05 The middle
1:02:05 Questions`);
	});

	it('puts the markers in time order whatever order they came in', () => {
		expect(
			formatChapterList([marker(125, 'Middle'), marker(0, 'Intro')]),
		).toBe('0:00 Intro\n2:05 Middle');
	});

	it('takes bookmarks as well as chapters, which a description box does not tell apart', () => {
		expect(
			formatChapterList([
				marker(0, 'Intro'),
				marker(60, 'A point', 'bookmark'),
			]),
		).toBe('0:00 Intro\n1:00 A point');
	});

	it('appends the note a marker carries', () => {
		expect(
			formatChapterList([marker(0, 'Intro', 'chapter', 'Say hello')]),
		).toBe('0:00 Intro - Say hello');
	});

	it('writes nothing for a recording with no markers', () => {
		expect(formatChapterList([])).toBe('');
	});

	it('keeps two chapters that start together, which is a chapter of no length', () => {
		expect(
			formatChapterList([marker(60, 'First'), marker(60, 'Second')]),
		).toBe('1:00 First\n1:00 Second');
	});
});

describe('the cue sheet', () => {
	const META = { fileName: 'talk.wav', title: 'The talk' };

	it('names the recording and its file above the tracks', () => {
		expect(formatCueSheet([marker(0, 'Intro')], META)).toBe(
			`TITLE "The talk"
FILE "talk.wav" WAVE
  TRACK 01 AUDIO
    TITLE "Intro"
    INDEX 01 00:00:00
`,
		);
	});

	it('credits a performer when the recording names one', () => {
		expect(
			formatCueSheet([], { ...META, performer: 'A speaker' }),
		).toContain('PERFORMER "A speaker"');
	});

	it('counts in minutes and frames, with no hours field at all', () => {
		// An hour and two minutes is 62 minutes, not 1:02
		expect(formatCueSheet([marker(3725, 'Questions')], META)).toContain(
			'INDEX 01 62:05:00',
		);
	});

	it('converts the fraction of a second into frames', () => {
		expect(formatCueSheet([marker(1.5, 'Half')], META)).toContain(
			'INDEX 01 00:01:38',
		);
	});

	it('carries a rounded-up frame into the next second', () => {
		// 75 frames is the next second, not a frame number that exists
		expect(formatCueSheet([marker(1.9999, 'Nearly')], META)).toContain(
			'INDEX 01 00:02:00',
		);
	});

	it('numbers the tracks from one, in time order', () => {
		const sheet = formatCueSheet(
			[marker(125, 'Second'), marker(0, 'First')],
			META,
		);

		expect(sheet).toContain('TRACK 01 AUDIO\n    TITLE "First"');
		expect(sheet).toContain('TRACK 02 AUDIO\n    TITLE "Second"');
	});

	it('leaves bookmarks out, which mark a point and not a track', () => {
		const sheet = formatCueSheet(
			[marker(0, 'Intro'), marker(60, 'A point', 'bookmark')],
			META,
		);

		expect(sheet).toContain('TRACK 01');
		expect(sheet).not.toContain('TRACK 02');
	});

	it('drops a quotation mark, which the format cannot escape', () => {
		// Left in, it would end the field early and make the line unreadable
		expect(formatCueSheet([marker(0, 'The "big" one')], META)).toContain(
			'TITLE "The big one"',
		);
	});

	it('writes a header alone for a recording with no chapters', () => {
		expect(formatCueSheet([], META)).toBe(
			'TITLE "The talk"\nFILE "talk.wav" WAVE\n',
		);
	});
});

describe('the Markdown outline', () => {
	it('makes every timecode a link into the recording', () => {
		expect(formatChapterOutline([marker(125, 'Middle')], link)).toBe(
			'- [[rec#t=125|2:05]] Middle',
		);
	});

	it('widens the timecodes together, as the list does', () => {
		expect(formatChapterOutline(TALK, link)).toBe(
			`- [[rec#t=0|0:00:00]] Intro
- [[rec#t=125|0:02:05]] The middle
- [[rec#t=3725|1:02:05]] Questions`,
		);
	});

	it('says which entries are bookmarks rather than chapters', () => {
		expect(
			formatChapterOutline([marker(60, 'A point', 'bookmark')], link),
		).toBe('- [[rec#t=60|1:00]] A point (bookmark)');
	});

	it('appends the note a marker carries', () => {
		expect(
			formatChapterOutline(
				[marker(0, 'Intro', 'chapter', 'Say hello')],
				link,
			),
		).toBe('- [[rec#t=0|0:00]] Intro - Say hello');
	});

	it('floors a fractional offset, which is what the link takes', () => {
		expect(formatChapterOutline([marker(9.7, 'Nearly ten')], link)).toBe(
			'- [[rec#t=9|0:09]] Nearly ten',
		);
	});

	it('writes nothing for a recording with no markers', () => {
		expect(formatChapterOutline([], link)).toBe('');
	});
});
