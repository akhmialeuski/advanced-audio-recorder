/**
 * Tests that the provider response mappers extract billing-relevant usage:
 * OpenAI Whisper's top-level duration, Deepgram's metadata.duration, and
 * Gemini's usageMetadata token counts.
 */

import { mapWhisperResponse } from 'src/transcription/providers/whisperResponse';
import { mapDeepgramResponse } from 'src/transcription/providers/deepgramResponse';
import { mapGeminiResponse } from 'src/transcription/providers/geminiResponse';

describe('mapWhisperResponse usage', () => {
	it('reads the billed duration from verbose_json', () => {
		const result = mapWhisperResponse({
			language: 'en',
			duration: 123.4,
			segments: [{ start: 0, end: 1, text: 'hi' }],
		});
		expect(result.usage).toEqual({ audioSeconds: 123.4 });
	});

	it('carries the duration on the flat-text fallback too', () => {
		const result = mapWhisperResponse({ text: 'hi', duration: 5 });
		expect(result.usage).toEqual({ audioSeconds: 5 });
	});

	it('omits usage when the duration is missing or malformed', () => {
		expect(mapWhisperResponse({ text: 'hi' }).usage).toBeUndefined();
		expect(
			mapWhisperResponse({ text: 'hi', duration: 'long' }).usage,
		).toBeUndefined();
		expect(
			mapWhisperResponse({ text: 'hi', duration: -3 }).usage,
		).toBeUndefined();
	});
});

describe('mapDeepgramResponse usage', () => {
	const utterance = {
		start: 0,
		end: 1,
		transcript: 'hi',
	};

	it('reads the billed duration from metadata', () => {
		const result = mapDeepgramResponse(
			{
				metadata: { duration: 61.5 },
				results: { utterances: [utterance] },
			},
			false,
		);
		expect(result.usage).toEqual({ audioSeconds: 61.5 });
	});

	it('omits usage when metadata carries no finite duration', () => {
		const result = mapDeepgramResponse(
			{
				metadata: { duration: 'n/a' },
				results: { utterances: [utterance] },
			},
			false,
		);
		expect(result.usage).toBeUndefined();
	});
});

describe('mapGeminiResponse usage', () => {
	const transcriptJson = JSON.stringify({
		segments: [{ start: 0, end: 1, text: 'hi' }],
	});

	function body(usageMetadata?: Record<string, unknown>): unknown {
		return {
			candidates: [{ content: { parts: [{ text: transcriptJson }] } }],
			...(usageMetadata ? { usageMetadata } : {}),
		};
	}

	it('maps prompt tokens to input and candidate+thinking tokens to output', () => {
		const result = mapGeminiResponse(
			body({
				promptTokenCount: 20000,
				candidatesTokenCount: 900,
				thoughtsTokenCount: 100,
			}),
			false,
		);
		expect(result.usage).toEqual({
			inputTokens: 20000,
			outputTokens: 1000,
		});
	});

	it('splits the audio portion of the prompt out for modality pricing', () => {
		const result = mapGeminiResponse(
			body({
				promptTokenCount: 20000,
				promptTokensDetails: [
					{ modality: 'AUDIO', tokenCount: 19000 },
					{ modality: 'TEXT', tokenCount: 1000 },
				],
				candidatesTokenCount: 900,
				thoughtsTokenCount: 100,
			}),
			false,
		);
		expect(result.usage).toEqual({
			inputTokens: 20000,
			audioInputTokens: 19000,
			outputTokens: 1000,
		});
	});

	it('omits usage when the response reports no counts', () => {
		expect(mapGeminiResponse(body(), false).usage).toBeUndefined();
	});

	it('attaches usage even when the candidate is unparseable', () => {
		const result = mapGeminiResponse(
			{
				candidates: [{ content: { parts: [{ text: 'not json' }] } }],
				usageMetadata: { promptTokenCount: 50 },
			},
			false,
		);
		expect(result.segments).toEqual([]);
		expect(result.usage).toEqual({ inputTokens: 50, outputTokens: 0 });
	});
});
