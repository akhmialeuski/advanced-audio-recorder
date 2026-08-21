/**
 * Tests for the Gemini response mapper: structured JSON carried in the
 * candidate text part, speaker gating by the diarize flag, numeric and
 * "HH:MM:SS"/"MM:SS" timecode parsing, empty-segment skipping, and tolerance
 * of malformed bodies.
 */

import {
	mapGeminiResponse,
	timecodeToSeconds,
} from 'src/transcription/providers/geminiResponse';
import { at } from '../helpers/assertions';

/** Wraps a structured transcript object as a Gemini generateContent body. */
function geminiBody(structured: unknown): unknown {
	return {
		candidates: [
			{ content: { parts: [{ text: JSON.stringify(structured) }] } },
		],
	};
}

/** Wraps arbitrary candidate text (not necessarily JSON) as a response body. */
function geminiTextBody(text: string): unknown {
	return { candidates: [{ content: { parts: [{ text }] } }] };
}

let warnSpy: jest.SpyInstance;

beforeEach(() => {
	// The mapper warns on unexpected (post-guard) bodies; suppress the noise and
	// let the diagnostic tests assert against it.
	warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

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
		expect(at(result.segments, 0).text).toBe('Hello there.');
		expect(at(result.segments, 0).speaker).toBe('Speaker 1');
		expect(at(result.segments, 1).speaker).toBe('Speaker 2');
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
		expect(at(result.segments, 0).speaker).toBeUndefined();
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
		expect(at(result.segments, 0).text).toBe('kept');
		expect(at(result.segments, 0).start).toBe(3);
		expect(at(result.segments, 0).end).toBe(3);
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
		expect(at(result.segments, 0).start).toBe(90);
		expect(at(result.segments, 0).end).toBe(92);
		expect(at(result.segments, 1).start).toBe(125);
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

	it.each([
		{ name: 'a null segment', entry: null },
		{ name: 'a string segment', entry: 'Hello' },
		{ name: 'a segment with no text', entry: { start: 0 } },
		{
			name: 'a segment whose text is a number',
			entry: { start: 0, text: 7 },
		},
	])('drops $name and keeps the rest', ({ entry }) => {
		const result = mapGeminiResponse(
			geminiBody({ segments: [entry, { start: 1, text: 'kept' }] }),
			false,
		);

		expect(result.segments).toHaveLength(1);
		expect(at(result.segments, 0).text).toBe('kept');
	});

	it('warns and returns empty on non-JSON candidate text', () => {
		// After the provider's truncation/block guards, a non-JSON body is
		// unexpected; it must be logged rather than silently dropped.
		expect(
			mapGeminiResponse(geminiTextBody('not json at all'), false)
				.segments,
		).toEqual([]);
		expect(warnSpy).toHaveBeenCalledTimes(1);
		expect(String(warnSpy.mock.calls[0][1])).toContain('not json at all');
	});

	it('warns and returns empty when valid JSON has no segments array', () => {
		expect(
			mapGeminiResponse(geminiBody({ language: 'en' }), false).segments,
		).toEqual([]);
		expect(warnSpy).toHaveBeenCalledTimes(1);
	});

	it('does not warn on a legitimately empty candidate', () => {
		// No text at all is a valid "nothing transcribed" result, not an error.
		expect(mapGeminiResponse({ candidates: [] }, false).segments).toEqual(
			[],
		);
		expect(mapGeminiResponse(null, false).segments).toEqual([]);
		expect(warnSpy).not.toHaveBeenCalled();
	});
});

describe('the tokens a run is billed for', () => {
	const usageMetadata = {
		promptTokenCount: 900,
		candidatesTokenCount: 100,
		totalTokenCount: 1000,
	};

	/** The same body, plus the usage counts Gemini reports beside it. */
	function billed(body: unknown): unknown {
		return { ...(body as Record<string, unknown>), usageMetadata };
	}

	// Gemini bills for the audio it read whatever came back, so a run that
	// produced no transcript still has to report its cost - otherwise the
	// session total silently under-counts exactly the runs worth noticing.
	it.each([
		{
			name: 'a transcript came back',
			body: geminiBody({ segments: [{ start: 0, text: 'hi' }] }),
		},
		{ name: 'the candidate was empty', body: geminiTextBody('  ') },
		{
			name: 'the candidate was not JSON',
			body: geminiTextBody('not json'),
		},
		{ name: 'the JSON had no segments array', body: geminiBody({}) },
	])('reports the usage when $name', ({ body }) => {
		const result = mapGeminiResponse(billed(body), false);

		expect(result.usage).toEqual(
			expect.objectContaining({ inputTokens: 900, outputTokens: 100 }),
		);
	});
});

describe('timecodeToSeconds', () => {
	it('passes finite numbers through as seconds', () => {
		expect(timecodeToSeconds(42)).toBe(42);
		expect(timecodeToSeconds(0)).toBe(0);
	});

	it('parses MM:SS and HH:MM:SS strings', () => {
		expect(timecodeToSeconds('02:05')).toBe(125);
		expect(timecodeToSeconds('01:00:00')).toBe(3600);
	});

	it('parses a bare numeric string', () => {
		expect(timecodeToSeconds('12.5')).toBe(12.5);
	});

	it('returns the fallback for unparseable values', () => {
		expect(timecodeToSeconds(undefined, 7)).toBe(7);
		expect(timecodeToSeconds('aa:bb', 7)).toBe(7);
		expect(timecodeToSeconds(Number.NaN, 7)).toBe(7);
	});
});
