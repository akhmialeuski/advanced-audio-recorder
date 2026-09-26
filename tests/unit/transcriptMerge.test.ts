/**
 * Tests for the pure model behind merging consecutive transcript lines into
 * one: when a merge is asked about, whether a selection holds consecutive
 * lines of one transcript, finding the one unbroken run of segments behind
 * them, the merged text and span, the merged segment, and the transcript with
 * the run replaced by it.
 */

import {
	buildMergedSegment,
	locateMergedSegments,
	MERGE_CONFIRMATION_MIN_LINES,
	mergedLineText,
	mergedSpan,
	mergeConfirmationMessage,
	mergeNeedsConfirmation,
	mergeSelectionProblem,
} from 'src/speakers/transcriptMerge';
import {
	replaceTranscriptRow,
	type RowLocation,
} from 'src/speakers/transcriptRows';
import { seg, transcriptOf, wordsOf } from '../helpers/transcriptFixtures';

/** A line of the note, found by its second, speaker, text and successor. */
function row(
	seconds: number,
	speaker: string | undefined,
	text: string,
	nextSeconds: number | null,
	merge = true,
): RowLocation {
	return { seconds, speaker, text, nextSeconds, merge };
}

describe('mergeNeedsConfirmation', () => {
	it('asks nothing about merging two lines', () => {
		expect(mergeNeedsConfirmation(2)).toBe(false);
	});

	it('asks about merging three lines', () => {
		expect(mergeNeedsConfirmation(3)).toBe(true);
	});

	it('asks about merging any more than that', () => {
		expect(mergeNeedsConfirmation(12)).toBe(true);
	});

	it('starts asking at three lines', () => {
		expect(MERGE_CONFIRMATION_MIN_LINES).toBe(3);
	});
});

describe('mergeConfirmationMessage', () => {
	it('names the lines and the speaker already in the transcript', () => {
		expect(
			mergeConfirmationMessage(3, { kind: 'existing', name: 'Anna' }),
		).toBe(
			"3 transcript lines become one line spoken by Anna, starting at the first line's time. The speakers and times of the other lines are dropped. The note can be undone with the editor, the transcript files cannot.",
		);
	});

	it('names a participant picked for the line', () => {
		expect(
			mergeConfirmationMessage(4, { kind: 'participant', name: 'Carol' }),
		).toContain('4 transcript lines become one line spoken by Carol,');
	});

	it('says a new speaker is given the line', () => {
		expect(mergeConfirmationMessage(3, { kind: 'new' })).toContain(
			'become one line spoken by a new speaker,',
		);
	});

	it('says the line is left without a speaker', () => {
		expect(mergeConfirmationMessage(3, { kind: 'none' })).toContain(
			'become one line without a speaker,',
		);
	});
});

describe('mergeSelectionProblem', () => {
	it('accepts two transcript lines with a blank line between them', () => {
		expect(mergeSelectionProblem(['row', 'blank', 'row'])).toBeNull();
	});

	it('accepts transcript lines that follow each other directly', () => {
		expect(mergeSelectionProblem(['row', 'row', 'row'])).toBeNull();
	});

	it('refuses a line that is not part of the transcript between them', () => {
		expect(
			mergeSelectionProblem(['row', 'blank', 'other', 'blank', 'row']),
		).toContain('not a line of this recording');
	});

	it('refuses a selection that ends on such a line', () => {
		expect(mergeSelectionProblem(['row', 'row', 'other'])).toContain(
			'not a line of this recording',
		);
	});

	it('refuses a single transcript line among blank ones', () => {
		expect(mergeSelectionProblem(['blank', 'row', 'blank'])).toBe(
			'Select at least two consecutive transcript lines to merge.',
		);
	});

	it('refuses a selection of blank lines only', () => {
		expect(mergeSelectionProblem(['blank', 'blank'])).toBe(
			'Select at least two consecutive transcript lines to merge.',
		);
	});
});

describe('locateMergedSegments', () => {
	const transcript = transcriptOf(
		seg(0, 4, 'Earlier', 'Bob'),
		seg(5, 6, 'one', 'Anna'),
		seg(6, 7, 'two', 'Anna'),
		seg(7, 9, 'three', 'Bob'),
		seg(10, 12, 'four', 'Anna'),
		seg(14, 15, 'Later', 'Bob'),
	);

	it('spans the segments of two consecutive lines', () => {
		expect(
			locateMergedSegments(transcript, [
				row(5, 'Anna', 'one two', 7),
				row(7, 'Bob', 'three', 14),
			]),
		).toEqual({ first: 1, last: 3 });
	});

	it('spans the segments of three lines of different speakers', () => {
		expect(
			locateMergedSegments(transcript, [
				row(5, 'Anna', 'one two', 7),
				row(7, 'Bob', 'three', 10),
				row(10, 'Anna', 'four', 14),
			]),
		).toEqual({ first: 1, last: 4 });
	});

	it('finds the segments of lines the note wrote one per segment', () => {
		expect(
			locateMergedSegments(transcript, [
				row(5, 'Anna', 'one', 6, false),
				row(6, 'Anna', 'two', 7, false),
			]),
		).toEqual({ first: 1, last: 2 });
	});

	it('finds nothing when a line is not in the transcript', () => {
		expect(
			locateMergedSegments(transcript, [
				row(5, 'Anna', 'one two', 7),
				row(7, 'Bob', 'edited by hand', 10),
			]),
		).toBeNull();
	});

	it('finds nothing when the transcript holds a turn between the lines', () => {
		// The note shows "one two" followed by "four", but "three" was spoken
		// between them: a line deleted by hand.
		expect(
			locateMergedSegments(transcript, [
				row(5, 'Anna', 'one two', 10),
				row(10, 'Anna', 'four', 14),
			]),
		).toBeNull();
	});

	it('finds nothing when the lines are out of order', () => {
		expect(
			locateMergedSegments(transcript, [
				row(7, 'Bob', 'three', 10),
				row(5, 'Anna', 'one two', 7),
			]),
		).toBeNull();
	});

	it('finds nothing for no lines at all', () => {
		expect(locateMergedSegments(transcript, [])).toBeNull();
	});
});

describe('mergedLineText', () => {
	it('joins the lines with single spaces', () => {
		expect(mergedLineText(['I think', 'we should wait'])).toBe(
			'I think we should wait',
		);
	});

	it('trims each line and leaves out an empty one', () => {
		expect(mergedLineText([' one ', '', 'two  '])).toBe('one two');
	});
});

describe('mergedSpan', () => {
	it('runs from the start to the end of the merged lines', () => {
		expect(mergedSpan({ start: 5, end: 12 })).toEqual({
			start: 5,
			end: 12,
		});
	});

	it("ends where it starts when the last line's end is unknown", () => {
		expect(mergedSpan({ start: 5, end: null })).toEqual({
			start: 5,
			end: 5,
		});
	});
});

describe('buildMergedSegment', () => {
	it('spans the lines with their joined text and the picked speaker', () => {
		expect(
			buildMergedSegment({ start: 5, end: 12 }, ['one', 'two'], 'Anna'),
		).toEqual({ start: 5, end: 12, text: 'one two', speaker: 'Anna' });
	});

	it('carries no speaker when none was picked', () => {
		expect(
			buildMergedSegment(
				{ start: 5, end: 12 },
				['one', 'two'],
				undefined,
			),
		).toEqual({ start: 5, end: 12, text: 'one two' });
	});

	it("takes the note's wikilink escaping off the text", () => {
		expect(
			buildMergedSegment(
				{ start: 0, end: 1 },
				['see \\[\\[Plan\\]\\]', 'now'],
				'Bob',
			).text,
		).toBe('see [[Plan]] now');
	});
});

describe('replaceTranscriptRow with a merged segment', () => {
	const transcript = transcriptOf(
		seg(0, 4, 'Earlier', 'Bob'),
		{ ...seg(5, 7, 'I think', 'Anna'), words: wordsOf('I think', 5) },
		{
			...seg(7, 10, 'we should wait', 'Bob'),
			words: wordsOf('we should wait', 7),
		},
		seg(14, 15, 'Later', 'Bob'),
	);
	const merged = replaceTranscriptRow(transcript, { first: 1, last: 2 }, [
		seg(5, 10, 'I think we should wait', 'Anna'),
	]);

	it('replaces the run with the one segment', () => {
		expect(merged.segments.map((segment) => segment.text)).toEqual([
			'Earlier',
			'I think we should wait',
			'Later',
		]);
	});

	it('keeps every word of the merged lines', () => {
		expect(merged.segments[1]?.words?.map((word) => word.text)).toEqual([
			'I',
			'think',
			'we',
			'should',
			'wait',
		]);
	});

	it('derives the speakers again', () => {
		expect(
			replaceTranscriptRow(transcript, { first: 0, last: 3 }, [
				seg(0, 15, 'All of it', 'Anna'),
			]).speakers,
		).toEqual(['Anna']);
	});
});
