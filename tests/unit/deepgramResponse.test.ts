/**
 * Tests for the Deepgram response mapper: utterances (with/without
 * diarization), the word-grouping fallback, the flat-transcript fallback,
 * and tolerance of malformed bodies.
 */

import { mapDeepgramResponse } from 'src/transcription/providers/deepgramResponse';
import { at, defined } from '../helpers/assertions';

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
		expect(at(result.segments, 0).text).toBe('Hello there.');
		expect(at(result.segments, 0).speaker).toBe('Speaker 1');
		expect(at(defined(at(result.segments, 0).words), 0).text).toBe('Hello');
		expect(at(result.segments, 1).speaker).toBe('Speaker 2');
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
		expect(at(result.segments, 0).speaker).toBeUndefined();
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
		expect(at(result.segments, 0).text).toBe('kept');
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
		expect(at(result.segments, 0).text).toBe('A b');
		expect(at(result.segments, 0).speaker).toBe('Speaker 1');
		expect(at(result.segments, 1).text).toBe('C');
		expect(at(result.segments, 1).speaker).toBe('Speaker 2');
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

	it.each([
		{ name: 'null', body: null },
		{ name: 'a string', body: 'nope' },
		{ name: 'an array', body: [{ results: {} }] },
		{ name: 'a body with no results', body: {} },
		{ name: 'results that are not an object', body: { results: 'nope' } },
		{ name: 'results with nothing in them', body: { results: {} } },
	])('maps $name to no segments', ({ body }) => {
		expect(mapDeepgramResponse(body, false).segments).toEqual([]);
	});

	describe('entries the response should not contain', () => {
		it.each([
			{ name: 'a null utterance', entry: null },
			{ name: 'a string utterance', entry: 'Hello' },
			{ name: 'an utterance with no transcript', entry: { start: 0 } },
			{
				name: 'an utterance whose transcript is a number',
				entry: { start: 0, transcript: 7 },
			},
		])('drops $name and keeps the rest', ({ entry }) => {
			const result = mapDeepgramResponse(
				{
					results: {
						utterances: [entry, { start: 1, transcript: 'kept' }],
					},
				},
				false,
			);

			expect(result.segments).toHaveLength(1);
			expect(at(result.segments, 0).text).toBe('kept');
		});

		it.each([
			{ name: 'a null word', word: null },
			{ name: 'a string word', word: 'Hello' },
			{ name: 'a word with no text at all', word: { start: 0 } },
			{ name: 'a word whose text is a number', word: { word: 7 } },
		])('drops $name from an utterance word list', ({ word }) => {
			const result = mapDeepgramResponse(
				{
					results: {
						utterances: [
							{
								start: 0,
								transcript: 'hi',
								words: [word, { word: 'hi', start: 0, end: 1 }],
							},
						],
					},
				},
				false,
			);

			expect(defined(at(result.segments, 0).words)).toHaveLength(1);
		});

		it.each([
			{ name: 'every word was unusable', words: [null, 5] },
			{ name: 'the word list is empty', words: [] },
			{ name: 'the word list is not an array', words: 'Hello' },
		])('reports no words at all when $name', ({ words }) => {
			const result = mapDeepgramResponse(
				{
					results: {
						utterances: [{ start: 0, transcript: 'hi', words }],
					},
				},
				false,
			);

			expect(at(result.segments, 0)).not.toHaveProperty('words');
		});

		it.each([
			{ name: 'a null word', word: null },
			{ name: 'a string word', word: 'Hello' },
			{ name: 'a word whose text is a number', word: { word: 7 } },
			{
				name: 'a word that is only whitespace',
				word: { punctuated_word: '   ' },
			},
		])('drops $name while grouping by speaker', ({ word }) => {
			const result = mapDeepgramResponse(
				{
					results: {
						channels: [
							{
								alternatives: [
									{
										words: [
											word,
											{
												punctuated_word: 'kept',
												start: 0,
												end: 1,
												speaker: 0,
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

			expect(result.segments).toHaveLength(1);
			expect(at(result.segments, 0).text).toBe('kept');
		});

		it('groups words the response gave no speaker index at all', () => {
			const result = mapDeepgramResponse(
				{
					results: {
						channels: [
							{
								alternatives: [
									{
										words: [
											{ word: 'A', start: 0, end: 0.5 },
											{ word: 'b', start: 0.5, end: 1 },
										],
									},
								],
							},
						],
					},
				},
				true,
			);

			expect(result.segments).toEqual([
				{ start: 0, end: 1, text: 'A b' },
			]);
		});
	});

	describe('falling through from one strategy to the next', () => {
		it('reaches the words when every utterance was unusable', () => {
			const result = mapDeepgramResponse(
				{
					results: {
						utterances: [{ start: 0, transcript: '   ' }],
						channels: [
							{
								alternatives: [
									{
										transcript: 'from the words',
										words: [
											{
												word: 'from',
												start: 0,
												end: 1,
												speaker: 0,
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

			expect(at(result.segments, 0).text).toBe('from');
		});

		it('reaches the flat transcript when the words group into nothing', () => {
			const result = mapDeepgramResponse(
				{
					results: {
						channels: [
							{
								alternatives: [
									{ transcript: 'flat', words: [null] },
								],
							},
						],
					},
				},
				true,
			);

			expect(result.segments).toEqual([
				{ start: 0, end: 0, text: 'flat' },
			]);
		});

		it.each([
			{ name: 'is missing', transcript: undefined },
			{ name: 'is not a string', transcript: 42 },
			{ name: 'is only whitespace', transcript: '   ' },
		])(
			'reports no segments when the transcript $name',
			({ transcript }) => {
				const result = mapDeepgramResponse(
					{
						results: {
							channels: [{ alternatives: [{ transcript }] }],
						},
					},
					false,
				);

				expect(result.segments).toEqual([]);
			},
		);

		it.each([
			{ name: 'the channel list is not an array', channels: 'nope' },
			{ name: 'the channel list is empty', channels: [] },
			{ name: 'the first channel is not an object', channels: ['nope'] },
			{
				name: 'the channel carries no alternatives',
				channels: [{ detected_language: 'en' }],
			},
			{
				name: 'the alternatives are not an array',
				channels: [{ alternatives: 'nope' }],
			},
			{
				name: 'the first alternative is not an object',
				channels: [{ alternatives: ['nope'] }],
			},
		])('reports no segments when $name', ({ channels }) => {
			const result = mapDeepgramResponse(
				{ results: { channels } },
				false,
			);

			expect(result.segments).toEqual([]);
		});
	});

	describe('the billed duration', () => {
		const words = [{ punctuated_word: 'hi', start: 0, end: 1, speaker: 0 }];

		it.each([
			{
				name: 'a run that produced utterances',
				results: { utterances: [{ start: 0, transcript: 'hi' }] },
			},
			{
				name: 'a run that fell through to grouped words',
				results: { channels: [{ alternatives: [{ words }] }] },
			},
			{
				name: 'a run that fell through to the flat transcript',
				results: {
					channels: [{ alternatives: [{ transcript: 'hi' }] }],
				},
			},
			{
				name: 'a run that produced nothing at all',
				results: { channels: [{ alternatives: [{}] }] },
			},
		])('carries the metadata duration out of $name', ({ results }) => {
			const result = mapDeepgramResponse(
				{ metadata: { duration: 42.5 }, results },
				true,
			);

			expect(result.usage).toEqual({ audioSeconds: 42.5 });
		});

		it.each([
			{ name: 'there is no metadata', metadata: undefined },
			{ name: 'the metadata is not an object', metadata: 'nope' },
			{ name: 'the duration is missing', metadata: {} },
			{
				name: 'the duration is not a number',
				metadata: { duration: '4' },
			},
			{ name: 'the duration is negative', metadata: { duration: -1 } },
			{
				name: 'the duration is NaN',
				metadata: { duration: Number.NaN },
			},
			{
				name: 'the duration is infinite',
				metadata: { duration: Number.POSITIVE_INFINITY },
			},
		])('reports no usage when $name', ({ metadata }) => {
			const result = mapDeepgramResponse(
				{
					metadata,
					results: { utterances: [{ start: 0, transcript: 'hi' }] },
				},
				false,
			);

			expect(result).not.toHaveProperty('usage');
		});
	});
});
