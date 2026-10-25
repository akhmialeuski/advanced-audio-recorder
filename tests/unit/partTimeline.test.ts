/**
 * Tests the judgement of a part's model-written timecodes against the part
 * they were transcribed from: where an answer counts as having left the part,
 * where it counts as having stopped early, and what is kept of one that left.
 * @module tests/unit/partTimeline.test
 */

import {
	judgePartTimeline,
	PART_OVERRUN_TOLERANCE_SECONDS,
	PART_SILENT_TAIL_MAX_SECONDS,
	TimelineFaultKind,
	timelineFaultMessage,
	trimToPart,
} from 'src/transcription/partTimeline';
import type { TranscriptSegment } from 'src/transcription/TranscriptTypes';

/** The second part of the 24:13 lesson, which is 12:06.5 long. */
const PART_SECONDS = 726.5;
const MIDDLE = { durationSeconds: PART_SECONDS, isLast: false };
const LAST = { durationSeconds: PART_SECONDS, isLast: true };

/**
 * A line of the given span.
 * @param start - Where it starts, in seconds from the start of the part
 * @param end - Where it ends
 * @returns The segment
 */
function line(start: number, end: number): TranscriptSegment {
	return { start, end, text: `at ${String(start)}` };
}

describe('judgePartTimeline', () => {
	it('accepts an answer that runs to the end of the part', () => {
		expect(
			judgePartTimeline([line(0, 300), line(300, PART_SECONDS)], MIDDLE),
		).toBeNull();
	});

	it('tolerates a last line ending a few seconds past the part', () => {
		const end = PART_SECONDS + PART_OVERRUN_TOLERANCE_SECONDS;

		expect(judgePartTimeline([line(700, end)], MIDDLE)).toBeNull();
	});

	it('reports an answer whose lines end past the tolerance', () => {
		expect(judgePartTimeline([line(0, 30), line(840, 842)], LAST)).toEqual({
			kind: TimelineFaultKind.Overrun,
			reachedSeconds: 842,
		});
	});

	it('reports a part whose lines stop more than a minute before its end', () => {
		const reached = PART_SECONDS - PART_SILENT_TAIL_MAX_SECONDS - 1;

		expect(judgePartTimeline([line(0, reached)], MIDDLE)).toEqual({
			kind: TimelineFaultKind.Short,
			reachedSeconds: reached,
		});
	});

	it('accepts a silent minute at the end of a part', () => {
		const reached = PART_SECONDS - PART_SILENT_TAIL_MAX_SECONDS;

		expect(judgePartTimeline([line(0, reached)], MIDDLE)).toBeNull();
	});

	it('never judges the last part of a recording short', () => {
		expect(judgePartTimeline([line(0, 60)], LAST)).toBeNull();
	});

	it('reports a part that came back with no lines at all as short', () => {
		expect(judgePartTimeline([], MIDDLE)).toEqual({
			kind: TimelineFaultKind.Short,
			reachedSeconds: 0,
		});
	});
});

describe('trimToPart', () => {
	it('drops the lines that start past the part and ends the rest at it', () => {
		const kept = trimToPart(
			[line(10, 20), line(720, 740), line(840, 842)],
			PART_SECONDS,
		);

		expect(kept.map(({ start, end }) => [start, end])).toEqual([
			[10, 20],
			[720, PART_SECONDS],
		]);
	});
});

describe('timelineFaultMessage', () => {
	const OVERRUN = { kind: TimelineFaultKind.Overrun, reachedSeconds: 842 };
	const SHORT = { kind: TimelineFaultKind.Short, reachedSeconds: 450 };

	it('names where the lines went and what was dropped', () => {
		expect(
			timelineFaultMessage(OVERRUN, LAST, 'Google Gemini', {
				firstFault: OVERRUN,
			}),
		).toBe(
			'Google Gemini placed lines up to 14:02 in a part 12:06 long, on both attempts, so the lines past 12:06 were dropped.',
		);
	});

	it('names the failure when the part could not be sent again', () => {
		expect(
			timelineFaultMessage(OVERRUN, LAST, 'Google Gemini', {
				retryFailure: 'HTTP 400: bad',
			}),
		).toBe(
			'Google Gemini placed lines up to 14:02 in a part 12:06 long, and sending the part again failed, so the lines past 12:06 were dropped. HTTP 400: bad',
		);
	});

	it('names where the lines stopped', () => {
		expect(
			timelineFaultMessage(SHORT, MIDDLE, 'Google Gemini', {
				firstFault: SHORT,
			}),
		).toBe(
			'Google Gemini stopped at 7:30 in a part 12:06 long, on both attempts, so the rest of the part may be missing.',
		);
	});

	it('names where the first answer went when the second stopped short', () => {
		expect(
			timelineFaultMessage(SHORT, MIDDLE, 'Google Gemini', {
				firstFault: OVERRUN,
			}),
		).toBe(
			'Google Gemini stopped at 7:30 in a part 12:06 long, after a first answer that placed lines up to 14:02, so the rest of the part may be missing.',
		);
	});
});
