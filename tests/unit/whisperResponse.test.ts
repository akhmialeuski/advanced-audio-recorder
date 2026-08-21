/**
 * Tests for the Whisper `verbose_json` response mapper: the segment array,
 * the flat-transcript fallback, the billed duration, and what it does with
 * the shapes a provider is not supposed to send but sometimes does.
 *
 * The mapper is documented as degrading to "best available" rather than
 * throwing, which makes every malformed shape a behaviour with an expected
 * output rather than a case that merely must not crash.
 */

import { mapWhisperResponse } from 'src/transcription/providers/whisperResponse';
import { at, defined } from '../helpers/assertions';

describe('mapWhisperResponse', () => {
	describe('a body that is not an object', () => {
		it.each([
			{ name: 'null', body: null },
			{ name: 'a string', body: 'nope' },
			{ name: 'a number', body: 42 },
			{ name: 'an array', body: [{ text: 'ignored' }] },
			{ name: 'undefined', body: undefined },
		])('maps $name to no segments', ({ body }) => {
			expect(mapWhisperResponse(body)).toEqual({ segments: [] });
		});
	});

	describe('the segment array', () => {
		it('maps segments with their language, speaker, and words', () => {
			const result = mapWhisperResponse({
				language: 'en',
				segments: [
					{
						start: 0,
						end: 1.5,
						text: '  Hello there.  ',
						speaker: 'Speaker 1',
						words: [
							{ word: 'Hello', start: 0, end: 0.7 },
							{ word: 'there', start: 0.7, end: 1.5 },
						],
					},
				],
			});

			expect(result.language).toBe('en');
			expect(result.segments).toEqual([
				{
					start: 0,
					end: 1.5,
					text: 'Hello there.',
					speaker: 'Speaker 1',
					words: [
						{ text: 'Hello', start: 0, end: 0.7 },
						{ text: 'there', start: 0.7, end: 1.5 },
					],
				},
			]);
		});

		it('ends a segment at its own start when no end is reported', () => {
			const result = mapWhisperResponse({
				segments: [{ start: 4, text: 'no end' }],
			});

			expect(at(result.segments, 0).end).toBe(4);
		});

		it.each([
			{ name: 'a null entry', entry: null },
			{ name: 'a string entry', entry: 'Hello' },
			{ name: 'an entry with no text', entry: { start: 0, end: 1 } },
			{
				name: 'an entry whose text is not a string',
				entry: { start: 0, end: 1, text: 12 },
			},
			{
				name: 'an entry whose text is only whitespace',
				entry: { start: 0, end: 1, text: '   ' },
			},
		])('drops $name and keeps the rest', ({ entry }) => {
			const result = mapWhisperResponse({
				segments: [entry, { start: 1, end: 2, text: 'kept' }],
			});

			expect(result.segments).toHaveLength(1);
			expect(at(result.segments, 0).text).toBe('kept');
		});

		it('omits the speaker when the provider labelled it with a non-string', () => {
			const result = mapWhisperResponse({
				segments: [{ start: 0, end: 1, text: 'x', speaker: 3 }],
			});

			expect(at(result.segments, 0).speaker).toBeUndefined();
		});
	});

	describe('the words within a segment', () => {
		it('reads a word written under `text` rather than `word`', () => {
			const result = mapWhisperResponse({
				segments: [
					{
						start: 0,
						end: 1,
						text: 'hi',
						words: [{ text: ' hi ', start: 0, end: 1 }],
					},
				],
			});

			expect(at(defined(at(result.segments, 0).words), 0).text).toBe(
				'hi',
			);
		});

		it.each([
			{ name: 'a null word', word: null },
			{ name: 'a bare string word', word: 'hi' },
			{
				name: 'a word with neither `word` nor `text`',
				word: { start: 0 },
			},
			{ name: 'a word whose text is a number', word: { word: 7 } },
		])('drops $name from the word list', ({ word }) => {
			const result = mapWhisperResponse({
				segments: [
					{
						start: 0,
						end: 1,
						text: 'hi',
						words: [word, { word: 'hi', start: 0, end: 1 }],
					},
				],
			});

			expect(defined(at(result.segments, 0).words)).toHaveLength(1);
		});

		it.each([
			{ name: 'every word entry was unusable', words: [null, 5] },
			{ name: 'the word list is empty', words: [] },
			{ name: 'the word list is not an array', words: 'Hello' },
			{ name: 'no word list was sent', words: undefined },
		])('reports no words at all when $name', ({ words }) => {
			const result = mapWhisperResponse({
				segments: [{ start: 0, end: 1, text: 'hi', words }],
			});

			expect(at(result.segments, 0)).not.toHaveProperty('words');
		});

		it('defaults a word with no timings to zero rather than dropping it', () => {
			const result = mapWhisperResponse({
				segments: [
					{ start: 0, end: 1, text: 'hi', words: [{ word: 'hi' }] },
				],
			});

			expect(at(defined(at(result.segments, 0).words), 0)).toEqual({
				text: 'hi',
				start: 0,
				end: 0,
			});
		});
	});

	describe('the flat-transcript fallback', () => {
		it.each([
			{ name: 'no segment array is sent', segments: undefined },
			{ name: 'the segment array is empty', segments: [] },
			{ name: 'the segment array is not an array', segments: 'Hello' },
		])('falls back to the top-level text when $name', ({ segments }) => {
			const result = mapWhisperResponse({
				segments,
				text: '  the whole thing  ',
			});

			expect(result.segments).toEqual([
				{ start: 0, end: 0, text: 'the whole thing' },
			]);
		});

		it.each([
			{ name: 'the text is missing', text: undefined },
			{ name: 'the text is not a string', text: 99 },
			{ name: 'the text is only whitespace', text: '  ' },
		])('reports no segments when $name', ({ text }) => {
			expect(mapWhisperResponse({ text }).segments).toEqual([]);
		});

		it('keeps the language even when there is nothing to transcribe', () => {
			expect(
				mapWhisperResponse({ language: 'de', text: '' }).language,
			).toBe('de');
		});
	});

	describe('the billed duration', () => {
		it('carries the reported duration out as usage', () => {
			const result = mapWhisperResponse({
				duration: 12.5,
				segments: [{ start: 0, end: 1, text: 'hi' }],
			});

			expect(result.usage).toEqual({ audioSeconds: 12.5 });
		});

		it('carries usage out of the flat-transcript fallback too', () => {
			expect(
				mapWhisperResponse({ duration: 3, text: 'hi' }).usage,
			).toEqual({
				audioSeconds: 3,
			});
		});

		it.each([
			{ name: 'missing', duration: undefined },
			{ name: 'not a number', duration: '12' },
			{ name: 'negative', duration: -1 },
			{ name: 'NaN', duration: Number.NaN },
			{ name: 'infinite', duration: Number.POSITIVE_INFINITY },
		])('reports no usage when the duration is $name', ({ duration }) => {
			const result = mapWhisperResponse({ duration, text: 'hi' });

			expect(result).not.toHaveProperty('usage');
		});

		it('accepts a zero duration, which is billable and not missing', () => {
			expect(
				mapWhisperResponse({ duration: 0, text: 'hi' }).usage,
			).toEqual({
				audioSeconds: 0,
			});
		});
	});
});
