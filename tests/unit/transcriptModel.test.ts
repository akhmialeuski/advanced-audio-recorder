/**
 * Tests for the pure transcript data-model operations.
 */

import {
	buildTranscript,
	collectSpeakers,
	normalizeSegments,
	normalizeWhitespace,
	offsetSegment,
	plainText,
	stitchChunks,
	stripSpeakers,
} from 'src/transcription/transcriptModel';
import { at } from '../helpers/assertions';
import type {
	Transcript,
	TranscriptSegment,
} from 'src/transcription/TranscriptTypes';

function seg(
	start: number,
	end: number,
	text: string,
	speaker?: string,
): TranscriptSegment {
	return { start, end, text, ...(speaker ? { speaker } : {}) };
}

describe('normalizeWhitespace', () => {
	it('collapses runs of whitespace and trims', () => {
		expect(normalizeWhitespace('  a   b\n c \t')).toBe('a b c');
	});
});

describe('collectSpeakers', () => {
	it('returns distinct speakers in first-seen order', () => {
		const segments = [
			seg(0, 1, 'a', 'B'),
			seg(1, 2, 'b', 'A'),
			seg(2, 3, 'c', 'B'),
		];
		expect(collectSpeakers(segments)).toEqual(['B', 'A']);
	});
});

describe('stripSpeakers', () => {
	it('removes every segment speaker and empties the speaker list', () => {
		const transcript = buildTranscript([
			seg(0, 1, 'a', 'A'),
			seg(1, 2, 'b', 'B'),
		]);
		expect(transcript.speakers).toEqual(['A', 'B']);

		const stripped = stripSpeakers(transcript);
		expect(stripped.speakers).toEqual([]);
		expect(stripped.segments.every((s) => s.speaker === undefined)).toBe(
			true,
		);
	});

	it('preserves word-level timings and other metadata', () => {
		const transcript: Transcript = {
			language: 'en',
			model: 'fake',
			speakers: ['A'],
			segments: [
				{
					start: 0,
					end: 1,
					text: 'hi',
					speaker: 'A',
					words: [{ start: 0, end: 1, text: 'hi' }],
				},
			],
		};

		const stripped = stripSpeakers(transcript);
		expect(stripped.language).toBe('en');
		expect(stripped.model).toBe('fake');
		expect(at(stripped.segments, 0).words).toEqual([
			{ start: 0, end: 1, text: 'hi' },
		]);
		expect(at(stripped.segments, 0).speaker).toBeUndefined();
	});

	it('does not mutate the source transcript', () => {
		const transcript = buildTranscript([seg(0, 1, 'a', 'A')]);
		stripSpeakers(transcript);
		expect(transcript.speakers).toEqual(['A']);
		expect(at(transcript.segments, 0).speaker).toBe('A');
	});
});

describe('normalizeSegments', () => {
	it('sorts by start and normalizes text', () => {
		const segments = [seg(2, 3, ' x '), seg(0, 1, 'y  z')];
		const result = normalizeSegments(segments);
		expect(result.map((s) => s.text)).toEqual(['y z', 'x']);
	});
});

describe('offsetSegment', () => {
	it('shifts segment and word timestamps', () => {
		const segment: TranscriptSegment = {
			start: 1,
			end: 2,
			text: 'hi',
			words: [{ start: 1, end: 1.5, text: 'hi' }],
		};
		const shifted = offsetSegment(segment, 10);
		expect(shifted.start).toBe(11);
		expect(shifted.end).toBe(12);
		expect(shifted.words?.[0]).toEqual({
			start: 11,
			end: 11.5,
			text: 'hi',
		});
	});
});

describe('buildTranscript', () => {
	it('normalizes, sorts, and derives speakers', () => {
		const transcript = buildTranscript(
			[seg(5, 6, 'b', 'S2'), seg(0, 1, 'a', 'S1')],
			{ model: 'm' },
		);
		expect(transcript.segments.map((s) => s.text)).toEqual(['a', 'b']);
		expect(transcript.speakers).toEqual(['S1', 'S2']);
		expect(transcript.model).toBe('m');
	});
});

describe('stitchChunks', () => {
	it('offsets each chunk and concatenates in order', () => {
		const chunkA: Transcript = buildTranscript([seg(0, 1, 'one')], {
			language: 'en',
		});
		const chunkB: Transcript = buildTranscript([seg(0, 1, 'two')]);
		const combined = stitchChunks([
			{ offsetSeconds: 0, transcript: chunkA },
			{ offsetSeconds: 60, transcript: chunkB },
		]);
		expect(combined.segments.map((s) => s.start)).toEqual([0, 60]);
		expect(combined.segments.map((s) => s.text)).toEqual(['one', 'two']);
		expect(combined.language).toBe('en');
	});
});

describe('plainText', () => {
	it('joins all segment text into one normalized string', () => {
		const transcript = buildTranscript([seg(0, 1, 'a'), seg(1, 2, 'b')]);
		expect(plainText(transcript)).toBe('a b');
	});
});
