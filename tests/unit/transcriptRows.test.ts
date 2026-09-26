/**
 * Tests for the pure model of rendered transcript lines that the split and
 * the merge share: the templates a note's lines are read with, finding the
 * segments behind a rendered line, their timing, the time fields' format,
 * the speaker picks, and the transcript with a line's segments replaced.
 */

import { mergeSettings } from 'src/settings/settingsSerialization';
import {
	formatLineTime,
	lineSpeakerOptions,
	locateRowSegments,
	nextSpeakerLabel,
	noteMarkdownOptions,
	replaceTranscriptRow,
	resolveLineSpeakers,
	rowTiming,
	type LineSpeakerSources,
} from 'src/speakers/transcriptRows';
import { seg, transcriptOf, wordsOf } from '../helpers/transcriptFixtures';

function sourcesOf(
	overrides: Partial<LineSpeakerSources> = {},
): LineSpeakerSources {
	return {
		roster: [{ label: 'Speaker 1' }, { label: 'Speaker 2', name: 'Bob' }],
		participants: [],
		shown: ['Speaker 1', 'Bob'],
		...overrides,
	};
}

describe('noteMarkdownOptions', () => {
	const settings = mergeSettings({
		transcriptTimestampFormat: '[{time}]',
		transcriptIncludeSpeakers: false,
	});

	it('renders speakers even where the settings leave them out', () => {
		expect(noteMarkdownOptions(undefined, settings).includeSpeakers).toBe(
			true,
		);
	});

	it('reads the timestamp template an older record did not store', () => {
		expect(
			noteMarkdownOptions(
				{
					lineFormat: '{timestamp} {speaker} {text}',
					speakerFormat: '{speaker}:',
					includeTimestamps: true,
					timestampLinks: true,
					mergeConsecutiveSpeaker: false,
				},
				settings,
			),
		).toMatchObject({
			speakerFormat: '{speaker}:',
			timestampFormat: '[{time}]',
			mergeConsecutiveSpeaker: false,
		});
	});
});

describe('locateRowSegments', () => {
	const transcript = transcriptOf(
		seg(3.2, 4, 'Earlier', 'Bob'),
		seg(5.4, 7, 'one', 'Anna'),
		seg(7, 9, 'two', 'Anna'),
		seg(9, 10, 'three', 'Anna'),
		seg(12, 13, 'Later', 'Bob'),
	);

	it('finds the merged turn the line was rendered from', () => {
		expect(
			locateRowSegments(transcript, {
				seconds: 5,
				speaker: 'Anna',
				nextSeconds: 12,
				merge: true,
				text: 'one two three',
			}),
		).toEqual({ first: 1, last: 3 });
	});

	it('takes a single segment when the note did not merge', () => {
		expect(
			locateRowSegments(transcript, {
				seconds: 5,
				speaker: 'Anna',
				nextSeconds: 7,
				merge: false,
				text: 'one',
			}),
		).toEqual({ first: 1, last: 1 });
	});

	it('stops where the next line of the note starts', () => {
		expect(
			locateRowSegments(transcript, {
				seconds: 5,
				speaker: 'Anna',
				nextSeconds: 9,
				merge: true,
				text: 'one two',
			}),
		).toEqual({ first: 1, last: 2 });
	});

	it('finds nothing for a speaker the second does not hold', () => {
		expect(
			locateRowSegments(transcript, {
				seconds: 5,
				speaker: 'Bob',
				nextSeconds: null,
				merge: true,
				text: 'one two three',
			}),
		).toBeNull();
	});

	it('finds nothing for a line whose text was edited by hand', () => {
		expect(
			locateRowSegments(transcript, {
				seconds: 5,
				speaker: 'Anna',
				nextSeconds: 12,
				merge: true,
				text: 'one two three four',
			}),
		).toBeNull();
	});
});

/**
 * One speaker can open two lines in the same second, and the timecode link
 * carries whole seconds only, so the line's text is what tells them apart.
 * Taking the first line of that second would split another turn in every
 * transcript file.
 */
describe('locateRowSegments with two lines of a speaker in one second', () => {
	it('finds the turn after an interruption, not the one before it', () => {
		const transcript = transcriptOf(
			seg(45.1, 45.3, 'Yeah.', 'Bob'),
			seg(45.3, 45.5, 'What?', 'Anna'),
			seg(45.6, 47, 'I said hello there.', 'Bob'),
		);

		expect(
			locateRowSegments(transcript, {
				seconds: 45,
				speaker: 'Bob',
				nextSeconds: null,
				merge: true,
				text: 'I said hello there.',
			}),
		).toEqual({ first: 2, last: 2 });
	});

	it('finds the second of two unmerged segments', () => {
		const transcript = transcriptOf(
			seg(45.1, 45.5, 'Yeah.', 'Bob'),
			seg(45.6, 47, 'I said hello there.', 'Bob'),
		);

		expect(
			locateRowSegments(transcript, {
				seconds: 45,
				speaker: 'Bob',
				nextSeconds: null,
				merge: false,
				text: 'I said hello there.',
			}),
		).toEqual({ first: 1, last: 1 });
	});

	it('finds nothing when both lines read the same', () => {
		const transcript = transcriptOf(
			seg(45.1, 45.3, 'Yeah.', 'Bob'),
			seg(45.3, 45.5, 'What?', 'Anna'),
			seg(45.6, 46, 'Yeah.', 'Bob'),
		);

		expect(
			locateRowSegments(transcript, {
				seconds: 45,
				speaker: 'Bob',
				nextSeconds: null,
				merge: true,
				text: 'Yeah.',
			}),
		).toBeNull();
	});
});

describe('rowTiming', () => {
	it('spans the segments and gathers their words', () => {
		const transcript = transcriptOf(
			seg(5, 7, 'one two', 'Anna', wordsOf('one two', 5)),
			seg(7, 8, 'three', 'Anna', wordsOf('three', 7)),
		);

		expect(rowTiming(transcript, { first: 0, last: 1 })).toEqual({
			start: 5,
			end: 8,
			words: wordsOf('one two three', 5),
		});
	});
});

describe('formatLineTime', () => {
	it('adds tenths of a second when there are any', () => {
		expect(formatLineTime(83.46)).toBe('1:23.5');
	});

	it('writes whole seconds as a plain timecode', () => {
		expect(formatLineTime(83)).toBe('1:23');
	});
});

describe('nextSpeakerLabel', () => {
	it('takes the first number nobody uses', () => {
		expect(nextSpeakerLabel(new Set(['Speaker 1', 'Speaker 3']))).toBe(
			'Speaker 2',
		);
	});
});

describe('lineSpeakerOptions', () => {
	it('offers shown speakers, unused participants and a new speaker', () => {
		const options = lineSpeakerOptions(
			sourcesOf({ participants: ['Bob', 'Carol'] }),
		);

		expect(options.map((option) => option.title)).toEqual([
			'Speaker 1',
			'Bob',
			'Carol',
			'New speaker (Speaker 3)',
		]);
	});
});

describe('resolveLineSpeakers', () => {
	const times = { start: 5, end: 8 };

	it('keeps an existing speaker without touching the roster', () => {
		expect(
			resolveLineSpeakers(sourcesOf(), [
				{ choice: { kind: 'existing', name: 'Bob' }, times },
			]),
		).toEqual({ names: ['Bob'], added: [] });
	});

	it('adds a new speaker to the roster with its first turn', () => {
		expect(
			resolveLineSpeakers(sourcesOf(), [
				{ choice: { kind: 'new' }, times },
			]),
		).toEqual({
			names: ['Speaker 3'],
			added: [{ label: 'Speaker 3', firstStart: 5, firstEnd: 8 }],
		});
	});

	it('names the roster entry a participant pick creates', () => {
		expect(
			resolveLineSpeakers(sourcesOf(), [
				{ choice: { kind: 'participant', name: 'Carol' }, times },
			]).added,
		).toEqual([
			{ label: 'Speaker 3', name: 'Carol', firstStart: 5, firstEnd: 8 },
		]);
	});

	it('gives different picks different labels', () => {
		expect(
			resolveLineSpeakers(sourcesOf(), [
				{ choice: { kind: 'participant', name: 'Carol' }, times },
				{ choice: { kind: 'new' }, times: { start: 8, end: 9 } },
			]).names,
		).toEqual(['Carol', 'Speaker 4']);
	});

	it('treats the same new speaker picked twice as one speaker', () => {
		expect(
			resolveLineSpeakers(sourcesOf(), [
				{ choice: { kind: 'new' }, times },
				{ choice: { kind: 'new' }, times: { start: 8, end: 9 } },
			]).added,
		).toHaveLength(1);
	});
});

describe('replaceTranscriptRow', () => {
	const transcript = transcriptOf(
		seg(0, 5, 'Before', 'Bob'),
		seg(5, 8, 'one two three', 'Anna', wordsOf('one two three', 5)),
		seg(8, 9, 'After', 'Bob'),
	);
	const pieces = [seg(5, 6, 'one', 'Anna'), seg(6, 8, 'two three', 'Carol')];

	it('replaces the row with its pieces', () => {
		const split = replaceTranscriptRow(
			transcript,
			{ first: 1, last: 1 },
			pieces,
		);

		expect(split.segments.map((segment) => segment.text)).toEqual([
			'Before',
			'one',
			'two three',
			'After',
		]);
	});

	it('hands each piece the words spoken in it', () => {
		const split = replaceTranscriptRow(
			transcript,
			{ first: 1, last: 1 },
			pieces,
		);

		expect(split.segments[2]?.words).toEqual(wordsOf('two three', 6));
	});

	it('adds no word timings the row did not have', () => {
		const split = replaceTranscriptRow(
			transcriptOf(seg(5, 8, 'one two three', 'Anna')),
			{ first: 0, last: 0 },
			pieces,
		);

		expect(split.segments.some((segment) => segment.words)).toBe(false);
	});

	it('derives the speaker list again', () => {
		const split = replaceTranscriptRow(
			transcript,
			{ first: 1, last: 1 },
			pieces,
		);

		expect(split.speakers).toEqual(['Bob', 'Anna', 'Carol']);
	});
});
