/**
 * Tests for the mapping of an AssemblyAI answer: sentences in milliseconds
 * become segments in seconds, lettered speakers become the numbered labels the
 * rest of the plugin reads, and a surprising body degrades to what it does
 * carry instead of throwing.
 */

import { mapAssemblyAiResponse } from 'src/transcription/providers/assemblyAiResponse';
import { at } from '../helpers/assertions';

/**
 * A sentences body holding the given entries.
 * @param sentences - The entries of the `sentences` array
 * @returns The body as the endpoint shapes it
 */
const sentencesOf = (sentences: unknown[]): unknown => ({ sentences });

describe('mapAssemblyAiResponse', () => {
	it('turns each sentence into a segment timed in seconds', () => {
		const result = mapAssemblyAiResponse(
			{ language_code: 'pl', audio_duration: 3600 },
			sentencesOf([
				{
					text: ' Dzień dobry. ',
					start: 1000,
					end: 2500,
					speaker: 'B',
				},
				{ text: 'Tak.', start: 3000, end: 3400, speaker: 'A' },
			]),
			true,
		);

		expect(result).toEqual({
			language: 'pl',
			segments: [
				{
					start: 1,
					end: 2.5,
					text: 'Dzień dobry.',
					speaker: 'Speaker 2',
				},
				{ start: 3, end: 3.4, text: 'Tak.', speaker: 'Speaker 1' },
			],
			usage: { audioSeconds: 3600 },
		});
	});

	it('leaves the speakers out of a run that did not ask for them', () => {
		const result = mapAssemblyAiResponse(
			{},
			sentencesOf([{ text: 'Hi.', start: 0, end: 400, speaker: 'A' }]),
			false,
		);

		expect(at(result.segments, 0).speaker).toBeUndefined();
	});

	it('keeps a speaker name that is not one capital letter', () => {
		const result = mapAssemblyAiResponse(
			{},
			sentencesOf([{ text: 'Hi.', start: 0, end: 400, speaker: 'AB' }]),
			true,
		);

		expect(at(result.segments, 0).speaker).toBe('Speaker AB');
	});

	it('carries the words of a sentence, skipping entries with no text', () => {
		const result = mapAssemblyAiResponse(
			{},
			sentencesOf([
				{
					text: 'Hi you.',
					start: 0,
					end: 900,
					words: [
						{ text: 'Hi', start: 0, end: 300 },
						{ start: 300, end: 400 },
						'not a word',
						// A word with no end degenerates onto its start
						{ text: 'you.', start: 500 },
					],
				},
			]),
			false,
		);

		expect(at(result.segments, 0).words).toEqual([
			{ text: 'Hi', start: 0, end: 0.3 },
			{ text: 'you.', start: 0.5, end: 0.5 },
		]);
	});

	it('passes over a sentence with no text, and one that is not an object', () => {
		const result = mapAssemblyAiResponse(
			{},
			sentencesOf([
				{ text: '   ', start: 0, end: 100 },
				{ start: 0, end: 100 },
				null,
				// An empty word list adds no words field
				{ text: 'Kept.', start: 200, end: 600, words: [] },
			]),
			false,
		);

		expect(result.segments).toEqual([
			{ start: 0.2, end: 0.6, text: 'Kept.' },
		]);
	});

	it('falls back to the flat text when no sentence came back', () => {
		const result = mapAssemblyAiResponse(
			{ text: ' Whole transcript. ' },
			{ sentences: 'unexpected' },
			false,
		);

		expect(result.segments).toEqual([
			{ start: 0, end: 0, text: 'Whole transcript.' },
		]);
	});

	it('returns no segments and no usage for bodies it cannot read', () => {
		expect(mapAssemblyAiResponse(null, undefined, true)).toEqual({
			language: undefined,
			segments: [],
		});
		expect(
			mapAssemblyAiResponse({ audio_duration: -1, text: 5 }, [], true),
		).toEqual({ language: undefined, segments: [] });
	});
});
