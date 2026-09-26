/**
 * Tests for the pure model behind splitting a transcript line between
 * speakers: cutting the text at the selection, finding the segments behind a
 * rendered line, estimating the selection's times, validating entered times,
 * the speaker picks, and the transcript with the row replaced.
 */

import { mergeSettings } from 'src/settings/settingsSerialization';
import {
	afterSelection,
	buildSplitPieces,
	estimateSplitTimes,
	formatSplitTime,
	locateRowSegments,
	nextSpeakerLabel,
	noteMarkdownOptions,
	readSplitTimes,
	resolveSplitSpeakers,
	rowTiming,
	splitLineText,
	splitSpeakerOptions,
	splitTimesProblem,
	splitTranscriptRow,
	type SplitSpeakerSources,
	type SplitTexts,
} from 'src/speakers/transcriptSplit';
import type {
	Transcript,
	TranscriptSegment,
	TranscriptWord,
} from 'src/transcription/TranscriptTypes';
import { wordsOf } from '../helpers/transcriptFixtures';

function seg(
	start: number,
	end: number,
	text: string,
	speaker?: string,
	words?: TranscriptWord[],
): TranscriptSegment {
	return {
		start,
		end,
		text,
		...(speaker ? { speaker } : {}),
		...(words ? { words } : {}),
	};
}

function transcriptOf(...segments: TranscriptSegment[]): Transcript {
	return { segments, speakers: [] };
}

function sourcesOf(
	overrides: Partial<SplitSpeakerSources> = {},
): SplitSpeakerSources {
	return {
		roster: [{ label: 'Speaker 1' }, { label: 'Speaker 2', name: 'Bob' }],
		participants: [],
		shown: ['Speaker 1', 'Bob'],
		...overrides,
	};
}

const texts = (
	before: string,
	selected: string,
	after: string,
): SplitTexts => ({
	before,
	selected,
	after,
});

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

describe('splitLineText', () => {
	const line = '[[rec#t=5|0:05]] **Anna** one two three';
	const parsed = { speaker: 'Anna', textStart: 26, textEnd: line.length };

	it('cuts the text before, inside and after the selection', () => {
		const from = line.indexOf('two');

		expect(splitLineText(line, parsed, from, from + 3)).toEqual(
			texts('one', 'two', 'three'),
		);
	});

	it('clamps a selection that reaches into the speaker label', () => {
		expect(splitLineText(line, parsed, 20, line.indexOf(' two'))).toEqual(
			texts('', 'one', 'two three'),
		);
	});

	it('rejects a selection that holds no spoken text', () => {
		expect(splitLineText(line, parsed, 0, 10)).toBeNull();
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

describe('estimateSplitTimes', () => {
	it('uses the word timings when they match the line word for word', () => {
		const timing = {
			start: 10,
			end: 16,
			words: wordsOf('a b c d e f', 10),
		};

		expect(estimateSplitTimes(timing, texts('a b', 'c d', 'e f'))).toEqual({
			start: 12,
			end: 14,
		});
	});

	it('shares the span out by length without word timings', () => {
		expect(
			estimateSplitTimes(
				{ start: 10, end: 20 },
				texts('aaaaa', 'bbbbb', ''),
			),
		).toEqual({ start: 15, end: 20 });
	});

	it('ends a selection that ends the line where the line does', () => {
		const timing = { start: 10, end: 14, words: wordsOf('a b c', 10) };

		expect(estimateSplitTimes(timing, texts('a', 'b c', ''))).toEqual({
			start: 11,
			end: 14,
		});
	});

	it('ends a selection at its last word when the line end is unknown', () => {
		const timing = { start: 10, end: null, words: wordsOf('a b', 10) };

		expect(estimateSplitTimes(timing, texts('a', 'b', ''))).toEqual({
			start: 11,
			end: 12,
		});
	});

	it('offers only the start of a line whose end is unknown', () => {
		expect(
			estimateSplitTimes({ start: 10, end: null }, texts('', 'x', 'y')),
		).toEqual({ start: 10, end: 10 });
	});
});

describe('formatSplitTime', () => {
	it('adds tenths of a second when there are any', () => {
		expect(formatSplitTime(83.46)).toBe('1:23.5');
	});

	it('writes whole seconds as a plain timecode', () => {
		expect(formatSplitTime(83)).toBe('1:23');
	});
});

describe('splitTimesProblem', () => {
	const timing = { start: 10, end: 20 };

	it('accepts a span inside the line', () => {
		expect(
			splitTimesProblem(
				{ start: 12, end: 15 },
				timing,
				texts('a', 'b', 'c'),
			),
		).toBeNull();
	});

	it('rejects an end before the start', () => {
		expect(
			splitTimesProblem(
				{ start: 15, end: 12 },
				timing,
				texts('', 'b', ''),
			),
		).toMatch(/has to come after its start/);
	});

	it('keeps time for the text before the selection', () => {
		expect(
			splitTimesProblem(
				{ start: 10, end: 15 },
				timing,
				texts('a', 'b', ''),
			),
		).toMatch(/start after the line does/);
	});

	it('keeps time for the text after the selection', () => {
		expect(
			splitTimesProblem(
				{ start: 12, end: 20 },
				timing,
				texts('', 'b', 'c'),
			),
		).toMatch(/end before the line does/);
	});
});

describe('readSplitTimes', () => {
	const timing = { start: 10, end: 20 };

	it('reads the times the fields hold', () => {
		expect(
			readSplitTimes('0:12', '0:15.5', timing, texts('a', 'b', 'c')),
		).toEqual({ start: 12, end: 15.5 });
	});

	it('asks for both times', () => {
		expect(readSplitTimes('', '0:15', timing, texts('', 'b', ''))).toMatch(
			/Enter the start and the end/,
		);
	});

	it('says why times inside the field are refused', () => {
		expect(
			readSplitTimes('0:15', '0:12', timing, texts('', 'b', '')),
		).toMatch(/has to come after its start/);
	});
});

describe('nextSpeakerLabel', () => {
	it('takes the first number nobody uses', () => {
		expect(nextSpeakerLabel(new Set(['Speaker 1', 'Speaker 3']))).toBe(
			'Speaker 2',
		);
	});
});

describe('splitSpeakerOptions', () => {
	it('offers shown speakers, unused participants and a new speaker', () => {
		const options = splitSpeakerOptions(
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

describe('resolveSplitSpeakers', () => {
	const times = { start: 5, end: 8 };

	it('keeps an existing speaker without touching the roster', () => {
		expect(
			resolveSplitSpeakers(sourcesOf(), [
				{ choice: { kind: 'existing', name: 'Bob' }, times },
			]),
		).toEqual({ names: ['Bob'], added: [] });
	});

	it('adds a new speaker to the roster with its first turn', () => {
		expect(
			resolveSplitSpeakers(sourcesOf(), [
				{ choice: { kind: 'new' }, times },
			]),
		).toEqual({
			names: ['Speaker 3'],
			added: [{ label: 'Speaker 3', firstStart: 5, firstEnd: 8 }],
		});
	});

	it('names the roster entry a participant pick creates', () => {
		expect(
			resolveSplitSpeakers(sourcesOf(), [
				{ choice: { kind: 'participant', name: 'Carol' }, times },
			]).added,
		).toEqual([
			{ label: 'Speaker 3', name: 'Carol', firstStart: 5, firstEnd: 8 },
		]);
	});

	it('gives different picks different labels', () => {
		expect(
			resolveSplitSpeakers(sourcesOf(), [
				{ choice: { kind: 'participant', name: 'Carol' }, times },
				{ choice: { kind: 'new' }, times: { start: 8, end: 9 } },
			]).names,
		).toEqual(['Carol', 'Speaker 4']);
	});

	it('treats the same new speaker picked twice as one speaker', () => {
		expect(
			resolveSplitSpeakers(sourcesOf(), [
				{ choice: { kind: 'new' }, times },
				{ choice: { kind: 'new' }, times: { start: 8, end: 9 } },
			]).added,
		).toHaveLength(1);
	});
});

describe('afterSelection', () => {
	it('runs from the selection to the end of the line', () => {
		expect(
			afterSelection({ start: 0, end: 20 }, { start: 5, end: 8 }),
		).toEqual({ start: 8, end: 20 });
	});

	it('takes no time past the selection when the line end is unknown', () => {
		expect(
			afterSelection({ start: 0, end: null }, { start: 5, end: 8 }),
		).toEqual({ start: 8, end: 8 });
	});
});

describe('buildSplitPieces', () => {
	it('splits a line into three pieces around the selection', () => {
		expect(
			buildSplitPieces(
				{ start: 10, end: 20 },
				texts('one', 'two', 'three'),
				{ start: 12, end: 15 },
				{ row: 'Anna', selected: 'Bob', after: 'Anna' },
			),
		).toEqual([
			seg(10, 12, 'one', 'Anna'),
			seg(12, 15, 'two', 'Bob'),
			seg(15, 20, 'three', 'Anna'),
		]);
	});

	it('re-attributes the start of a line as a piece of its own', () => {
		expect(
			buildSplitPieces(
				{ start: 10, end: 20 },
				texts('', 'one', 'two'),
				{ start: 10, end: 12 },
				{ row: 'Anna', selected: 'Bob', after: 'Anna' },
			),
		).toEqual([seg(10, 12, 'one', 'Bob'), seg(12, 20, 'two', 'Anna')]);
	});

	it('takes the escaping the note added back off the text', () => {
		expect(
			buildSplitPieces(
				{ start: 10, end: 20 },
				texts('', '\\[\\[Topic\\]\\]', ''),
				{ start: 10, end: 20 },
				{ row: 'Anna', selected: 'Bob', after: undefined },
			)[0]?.text,
		).toBe('[[Topic]]');
	});
});

describe('splitTranscriptRow', () => {
	const transcript = transcriptOf(
		seg(0, 5, 'Before', 'Bob'),
		seg(5, 8, 'one two three', 'Anna', wordsOf('one two three', 5)),
		seg(8, 9, 'After', 'Bob'),
	);
	const pieces = [seg(5, 6, 'one', 'Anna'), seg(6, 8, 'two three', 'Carol')];

	it('replaces the row with its pieces', () => {
		const split = splitTranscriptRow(
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
		const split = splitTranscriptRow(
			transcript,
			{ first: 1, last: 1 },
			pieces,
		);

		expect(split.segments[2]?.words).toEqual(wordsOf('two three', 6));
	});

	it('adds no word timings the row did not have', () => {
		const split = splitTranscriptRow(
			transcriptOf(seg(5, 8, 'one two three', 'Anna')),
			{ first: 0, last: 0 },
			pieces,
		);

		expect(split.segments.some((segment) => segment.words)).toBe(false);
	});

	it('derives the speaker list again', () => {
		const split = splitTranscriptRow(
			transcript,
			{ first: 1, last: 1 },
			pieces,
		);

		expect(split.speakers).toEqual(['Bob', 'Anna', 'Carol']);
	});
});
