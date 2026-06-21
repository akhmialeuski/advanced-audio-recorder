/**
 * Tests for the Deepgram response mapper: utterances (with/without
 * diarization), the word-grouping fallback, the flat-transcript fallback,
 * and tolerance of malformed bodies.
 */

import { mapDeepgramResponse } from 'src/transcription/providers/deepgramResponse';

describe('mapDeepgramResponse', () => {
	it('maps utterances with speaker labels when diarizing', () => {
		const result = mapDeepgramResponse(
			{
				results: {
					channels: [{ detected_language: 'en' }],
					utterances: [
						{
							start: 0,
							end: 1.2,
							transcript: ' Hello there. ',
							speaker: 0,
							words: [
								{
									punctuated_word: 'Hello',
									start: 0,
									end: 0.6,
								},
								{ word: 'there', start: 0.6, end: 1.2 },
							],
						},
						{ start: 1.2, end: 2, transcript: 'Hi.', speaker: 1 },
					],
				},
			},
			true,
		);
		expect(result.language).toBe('en');
		expect(result.segments).toHaveLength(2);
		expect(result.segments[0].text).toBe('Hello there.');
		expect(result.segments[0].speaker).toBe('Speaker 1');
		expect(result.segments[0].words?.[0].text).toBe('Hello');
		expect(result.segments[1].speaker).toBe('Speaker 2');
	});

	it('omits speaker labels when diarization is off', () => {
		const result = mapDeepgramResponse(
			{
				results: {
					utterances: [
						{ start: 0, end: 1, transcript: 'x', speaker: 0 },
					],
				},
			},
			false,
		);
		expect(result.segments[0].speaker).toBeUndefined();
	});

	it('skips empty utterances', () => {
		const result = mapDeepgramResponse(
			{
				results: {
					utterances: [
						{ start: 0, end: 1, transcript: '   ', speaker: 0 },
						{ start: 1, end: 2, transcript: 'kept', speaker: 0 },
					],
				},
			},
			false,
		);
		expect(result.segments).toHaveLength(1);
		expect(result.segments[0].text).toBe('kept');
	});

	it('groups words by speaker when diarizing without utterances', () => {
		const result = mapDeepgramResponse(
			{
				results: {
					channels: [
						{
							alternatives: [
								{
									transcript: 'A b C',
									words: [
										{
											punctuated_word: 'A',
											start: 0,
											end: 0.5,
											speaker: 0,
										},
										{
											punctuated_word: 'b',
											start: 0.5,
											end: 1,
											speaker: 0,
										},
										{
											punctuated_word: 'C',
											start: 1,
											end: 1.5,
											speaker: 1,
										},
									],
								},
							],
						},
					],
				},
			},
			true,
		);
		expect(result.segments).toHaveLength(2);
		expect(result.segments[0].text).toBe('A b');
		expect(result.segments[0].speaker).toBe('Speaker 1');
		expect(result.segments[1].text).toBe('C');
		expect(result.segments[1].speaker).toBe('Speaker 2');
	});

	it('falls back to the flat transcript without utterances or diarization', () => {
		const result = mapDeepgramResponse(
			{
				results: {
					channels: [
						{ alternatives: [{ transcript: ' just text ' }] },
					],
				},
			},
			false,
		);
		expect(result.segments).toEqual([
			{ start: 0, end: 0, text: 'just text' },
		]);
	});

	it('tolerates malformed bodies', () => {
		expect(mapDeepgramResponse(null, false).segments).toEqual([]);
		expect(mapDeepgramResponse('nope', false).segments).toEqual([]);
		expect(mapDeepgramResponse({}, false).segments).toEqual([]);
		expect(mapDeepgramResponse({ results: {} }, false).segments).toEqual(
			[],
		);
	});
});
