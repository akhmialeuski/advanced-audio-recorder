/**
 * Tests for the Gemini response mapper: structured JSON carried in the
 * candidate text part, speaker gating by the diarize flag, numeric and
 * "HH:MM:SS"/"MM:SS" timecode parsing, empty-segment skipping, and tolerance
 * of malformed bodies.
 */

import {
	mapGeminiResponse,
	parseTimecode,
} from 'src/transcription/providers/geminiResponse';

/** Wraps a structured transcript object as a Gemini generateContent body. */
function geminiBody(structured: unknown): unknown {
	return {
		candidates: [
			{ content: { parts: [{ text: JSON.stringify(structured) }] } },
		],
	};
}

describe('mapGeminiResponse', () => {
	it('maps segments with speaker labels when diarizing', () => {
		const result = mapGeminiResponse(
			geminiBody({
				language: 'en',
				segments: [
					{
						start: 0,
						end: 1.2,
						speaker: 'Speaker 1',
						text: ' Hello there. ',
					},
					{ start: 1.2, end: 2, speaker: 'Speaker 2', text: 'Hi.' },
				],
			}),
			true,
		);
		expect(result.language).toBe('en');
		expect(result.segments).toHaveLength(2);
		expect(result.segments[0].text).toBe('Hello there.');
		expect(result.segments[0].speaker).toBe('Speaker 1');
		expect(result.segments[1].speaker).toBe('Speaker 2');
	});

	it('omits speaker labels when diarization is off', () => {
		const result = mapGeminiResponse(
			geminiBody({
				segments: [
					{ start: 0, end: 1, speaker: 'Speaker 1', text: 'x' },
				],
			}),
			false,
		);
		expect(result.segments[0].speaker).toBeUndefined();
	});

	it('skips empty segments and defaults end to start', () => {
		const result = mapGeminiResponse(
			geminiBody({
				segments: [
					{ start: 0, text: '   ' },
					{ start: 3, text: 'kept' },
				],
			}),
			false,
		);
		expect(result.segments).toHaveLength(1);
		expect(result.segments[0].text).toBe('kept');
		expect(result.segments[0].start).toBe(3);
		expect(result.segments[0].end).toBe(3);
	});

	it('parses string timecodes (HH:MM:SS / MM:SS) defensively', () => {
		const result = mapGeminiResponse(
			geminiBody({
				segments: [
					{ start: '00:01:30', end: '00:01:32', text: 'a' },
					{ start: '02:05', text: 'b' },
				],
			}),
			false,
		);
		expect(result.segments[0].start).toBe(90);
		expect(result.segments[0].end).toBe(92);
		expect(result.segments[1].start).toBe(125);
	});

	it('tolerates malformed bodies', () => {
		expect(mapGeminiResponse(null, false).segments).toEqual([]);
		expect(mapGeminiResponse('nope', false).segments).toEqual([]);
		expect(mapGeminiResponse({}, false).segments).toEqual([]);
		expect(mapGeminiResponse({ candidates: [] }, false).segments).toEqual(
			[],
		);
		// Candidate text that is not valid JSON.
		expect(
			mapGeminiResponse(
				{
					candidates: [
						{ content: { parts: [{ text: 'not json' }] } },
					],
				},
				false,
			).segments,
		).toEqual([]);
		// Valid JSON but no segments array.
		expect(mapGeminiResponse(geminiBody({}), false).segments).toEqual([]);
	});
});

describe('parseTimecode', () => {
	it('passes finite numbers through as seconds', () => {
		expect(parseTimecode(42)).toBe(42);
		expect(parseTimecode(0)).toBe(0);
	});

	it('parses MM:SS and HH:MM:SS strings', () => {
		expect(parseTimecode('02:05')).toBe(125);
		expect(parseTimecode('01:00:00')).toBe(3600);
	});

	it('parses a bare numeric string', () => {
		expect(parseTimecode('12.5')).toBe(12.5);
	});

	it('returns the fallback for unparseable values', () => {
		expect(parseTimecode(undefined, 7)).toBe(7);
		expect(parseTimecode('aa:bb', 7)).toBe(7);
		expect(parseTimecode(Number.NaN, 7)).toBe(7);
	});
});
