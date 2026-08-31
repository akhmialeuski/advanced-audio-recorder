/**
 * Tests for the part filter a restricted run uses. A top-up has to send the
 * parts that failed and nothing else: sending one part too many bills the
 * user for audio they already paid to transcribe, and sending one too few
 * leaves the gap it was called to close.
 */

import { selectRanges } from 'src/transcription/TranscriptionService';
import type { PreparedPayload } from 'src/transcription/audioPrep';

/** A prepared part covering the given stretch. */
function part(offsetSeconds: number, endSeconds?: number): PreparedPayload {
	return {
		contentType: 'audio/wav',
		filename: 'part.wav',
		offsetSeconds,
		...(endSeconds === undefined ? {} : { endSeconds }),
		createData: () => new ArrayBuffer(0),
	};
}

/** Three parts of a three-minute recording, a minute each. */
const PARTS = [part(0, 60), part(60, 120), part(120, 180)];

/** The offsets of whatever the filter kept. */
function kept(
	payloads: PreparedPayload[],
	ranges?: { startSeconds: number; endSeconds: number }[],
): number[] {
	return selectRanges(payloads, ranges).map((p) => p.offsetSeconds);
}

describe('choosing the parts a restricted run sends', () => {
	it.each([
		{ case: 'no restriction at all', ranges: undefined },
		{ case: 'an empty restriction', ranges: [] },
	])('sends every part for $case', ({ ranges }) => {
		expect(kept(PARTS, ranges)).toEqual([0, 60, 120]);
	});

	it('sends the one part a stretch covers', () => {
		expect(kept(PARTS, [{ startSeconds: 60, endSeconds: 120 }])).toEqual([
			60,
		]);
	});

	it('sends every part a stretch overlaps, even partly', () => {
		expect(kept(PARTS, [{ startSeconds: 90, endSeconds: 130 }])).toEqual([
			60, 120,
		]);
	});

	it('sends the parts of every stretch it was given', () => {
		expect(
			kept(PARTS, [
				{ startSeconds: 0, endSeconds: 60 },
				{ startSeconds: 120, endSeconds: 180 },
			]),
		).toEqual([0, 120]);
	});

	it.each([
		{ case: 'ends exactly where a part starts', start: 0, end: 60 },
		{ case: 'starts exactly where a part ends', start: 120, end: 180 },
	])('sends no neighbour for a stretch that $case', ({ start, end }) => {
		expect(kept(PARTS, [{ startSeconds: start, endSeconds: end }])).toEqual(
			[start],
		);
	});

	it('sends nothing for a stretch no part covers', () => {
		expect(kept(PARTS, [{ startSeconds: 300, endSeconds: 360 }])).toEqual(
			[],
		);
	});

	it('sends a part with no measured end whatever was asked for', () => {
		// The whole-file path never measures a duration, and it has nothing
		// smaller to send than the one part it prepared
		expect(
			kept([part(0)], [{ startSeconds: 300, endSeconds: 360 }]),
		).toEqual([0]);
	});
});
