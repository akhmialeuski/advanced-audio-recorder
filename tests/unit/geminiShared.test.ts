/**
 * Tests for the shared Gemini helpers: request building (endpoint URL and the
 * per-model thinking config) and response parsing (candidate text, finish
 * reason, the truncation guard, and the block guard) - so a thinking-model
 * overrun or a safety stop is surfaced rather than silently mapped to an empty
 * transcript or post-processing result.
 */

import {
	assertGeminiNotBlocked,
	assertGeminiNotTruncated,
	geminiCandidateText,
	geminiFinishReason,
	geminiGenerateContentUrl,
	geminiThinkingConfig,
	geminiUsage,
	GEMINI_FINISH_MAX_TOKENS,
} from 'src/transcription/providers/geminiShared';
import { TranscriptTruncatedError } from 'src/transcription/transcriptionErrors';

describe('geminiCandidateText', () => {
	it('concatenates the text parts of the first candidate without trimming', () => {
		const text = geminiCandidateText({
			candidates: [
				{
					content: {
						parts: [{ text: ' Hello ' }, { text: 'world' }],
					},
				},
			],
		});
		expect(text).toBe(' Hello world');
	});

	it.each([
		{ name: 'the body is null', body: null },
		{ name: 'there are no candidates', body: {} },
		{ name: 'the candidate list is empty', body: { candidates: [] } },
		{
			name: 'the candidate carries no parts',
			body: { candidates: [{ content: {} }] },
		},
		{
			name: 'the parts are not an array',
			body: { candidates: [{ content: { parts: 'Hello' } }] },
		},
	])('returns empty string when $name', ({ body }) => {
		expect(geminiCandidateText(body)).toBe('');
	});

	// A part can be a function call or inline data rather than text; skipping
	// those is what keeps a tool-augmented response from stringifying into
	// the transcript.
	it('skips the parts that carry no text of their own', () => {
		const text = geminiCandidateText({
			candidates: [
				{
					content: {
						parts: [
							{ text: 'kept' },
							null,
							'Hello',
							{ functionCall: { name: 'lookup' } },
							{ text: ' and kept' },
						],
					},
				},
			],
		});

		expect(text).toBe('kept and kept');
	});
});

describe('geminiFinishReason', () => {
	it('reads the first candidate finish reason', () => {
		expect(
			geminiFinishReason({ candidates: [{ finishReason: 'STOP' }] }),
		).toBe('STOP');
	});

	it('returns undefined when absent or malformed', () => {
		expect(geminiFinishReason({})).toBeUndefined();
		expect(geminiFinishReason({ candidates: [{}] })).toBeUndefined();
		expect(geminiFinishReason(null)).toBeUndefined();
	});
});

describe('assertGeminiNotTruncated', () => {
	const REMEDY = 'Shorten the input or pick a bigger model.';

	it('throws when the response was cut off at the output token limit', () => {
		expect(() =>
			assertGeminiNotTruncated(
				{ candidates: [{ finishReason: GEMINI_FINISH_MAX_TOKENS }] },
				REMEDY,
			),
		).toThrow(/output token limit/i);
	});

	it('throws a TranscriptTruncatedError so callers can subdivide on it', () => {
		// The transcription orchestrator branches on this exact type to retry a
		// part as smaller pieces, so the thrown class is part of the contract.
		expect(() =>
			assertGeminiNotTruncated(
				{ candidates: [{ finishReason: GEMINI_FINISH_MAX_TOKENS }] },
				REMEDY,
			),
		).toThrow(TranscriptTruncatedError);
	});

	it('appends the caller-supplied remedy to the message', () => {
		// The advice differs by task (transcription cannot raise a token limit),
		// so the caller passes it rather than the shared helper hardcoding one.
		expect(() =>
			assertGeminiNotTruncated(
				{ candidates: [{ finishReason: GEMINI_FINISH_MAX_TOKENS }] },
				REMEDY,
			),
		).toThrow(REMEDY);
	});

	it('does not throw for a normal stop or an absent finish reason', () => {
		expect(() =>
			assertGeminiNotTruncated(
				{ candidates: [{ finishReason: 'STOP' }] },
				REMEDY,
			),
		).not.toThrow();
		expect(() => assertGeminiNotTruncated({}, REMEDY)).not.toThrow();
	});

	it('embeds the reported output and total token counts in the message', () => {
		// The user needs to know how far the response ran before the cap.
		expect(() =>
			assertGeminiNotTruncated(
				{
					candidates: [{ finishReason: GEMINI_FINISH_MAX_TOKENS }],
					usageMetadata: {
						candidatesTokenCount: 65536,
						totalTokenCount: 78000,
					},
				},
				REMEDY,
			),
		).toThrow(/65536 output tokens, 78000 total/);
	});

	it('notes the thinking-token share when the model reports it', () => {
		expect(() =>
			assertGeminiNotTruncated(
				{
					candidates: [{ finishReason: GEMINI_FINISH_MAX_TOKENS }],
					usageMetadata: {
						candidatesTokenCount: 4096,
						thoughtsTokenCount: 4000,
						totalTokenCount: 9000,
					},
				},
				REMEDY,
			),
		).toThrow(/4096 output tokens plus 4000 on thinking/);
	});

	it('omits the usage parenthetical when no counts are reported', () => {
		// A response without usageMetadata must still read as a clean sentence.
		const assertTruncated = (): void => {
			assertGeminiNotTruncated(
				{ candidates: [{ finishReason: GEMINI_FINISH_MAX_TOKENS }] },
				REMEDY,
			);
		};

		expect(assertTruncated).toThrow(/output token limit, so the response/);
		// No usage counts means no parenthetical, not an empty one.
		expect(assertTruncated).not.toThrow(/\(/);
	});
});

describe('geminiUsage', () => {
	it('reads the finite token counts from usageMetadata', () => {
		expect(
			geminiUsage({
				usageMetadata: {
					promptTokenCount: 10,
					candidatesTokenCount: 20,
					totalTokenCount: 30,
					thoughtsTokenCount: 5,
				},
			}),
		).toEqual({
			promptTokenCount: 10,
			candidatesTokenCount: 20,
			totalTokenCount: 30,
			thoughtsTokenCount: 5,
		});
	});

	it('returns an empty object when usageMetadata is absent or malformed', () => {
		expect(geminiUsage({})).toEqual({});
		expect(geminiUsage(null)).toEqual({});
		// A non-numeric count is dropped rather than coerced to a number.
		expect(
			geminiUsage({ usageMetadata: { candidatesTokenCount: 'lots' } }),
		).toEqual({});
	});
});

describe('assertGeminiNotBlocked', () => {
	it('throws on a prompt-level block reason', () => {
		expect(() =>
			assertGeminiNotBlocked({
				promptFeedback: { blockReason: 'SAFETY' },
			}),
		).toThrow(/blocked the request \(SAFETY\)/i);
	});

	it('throws on a safety/recitation finish reason', () => {
		expect(() =>
			assertGeminiNotBlocked({
				candidates: [{ finishReason: 'RECITATION' }],
			}),
		).toThrow(/without usable output \(RECITATION\)/i);
	});

	// promptFeedback is present but says nothing usable: treated as no block
	// rather than as a block with an unprintable reason.
	it.each([
		{ name: 'not a string', blockReason: 7 },
		{ name: 'missing', blockReason: undefined },
		{ name: 'an empty string', blockReason: '' },
	])('does not throw when the block reason is $name', ({ blockReason }) => {
		expect(() =>
			assertGeminiNotBlocked({ promptFeedback: { blockReason } }),
		).not.toThrow();
	});

	it('does not throw when promptFeedback is not an object', () => {
		expect(() =>
			assertGeminiNotBlocked({ promptFeedback: 'SAFETY' }),
		).not.toThrow();
	});

	it('does not throw for a normal stop, MAX_TOKENS, or an empty body', () => {
		expect(() =>
			assertGeminiNotBlocked({ candidates: [{ finishReason: 'STOP' }] }),
		).not.toThrow();
		// MAX_TOKENS is the truncation guard's responsibility, not this one.
		expect(() =>
			assertGeminiNotBlocked({
				candidates: [{ finishReason: GEMINI_FINISH_MAX_TOKENS }],
			}),
		).not.toThrow();
		expect(() => assertGeminiNotBlocked({})).not.toThrow();
	});
});

describe('geminiGenerateContentUrl', () => {
	it('appends the v1beta generateContent path to the base URL', () => {
		expect(
			geminiGenerateContentUrl('https://gen.example', 'gemini-2.5-flash'),
		).toBe(
			'https://gen.example/v1beta/models/gemini-2.5-flash:generateContent',
		);
	});

	it('trims a trailing slash on the base URL', () => {
		expect(geminiGenerateContentUrl('https://gen.example/', 'm')).toBe(
			'https://gen.example/v1beta/models/m:generateContent',
		);
	});
});

describe('geminiThinkingConfig', () => {
	it('turns thinking off for 2.5 flash-family models', () => {
		expect(geminiThinkingConfig('gemini-2.5-flash')).toEqual({
			thinkingBudget: 0,
		});
		expect(geminiThinkingConfig('gemini-2.5-flash-lite')).toEqual({
			thinkingBudget: 0,
		});
	});

	it('uses the minimum budget for 2.5 Pro, which cannot disable thinking', () => {
		expect(geminiThinkingConfig('gemini-2.5-pro')).toEqual({
			thinkingBudget: 128,
		});
		expect(geminiThinkingConfig('GEMINI-2.5-PRO')).toEqual({
			thinkingBudget: 128,
		});
	});

	it('returns undefined for models without a thinking budget (2.0 and earlier)', () => {
		// thinkingBudget is a 2.5-series feature; sending thinkingConfig to a
		// 2.0 model is rejected by the API, so the config must be omitted.
		expect(geminiThinkingConfig('gemini-2.0-flash')).toBeUndefined();
		// "pro" alone must not enable thinking - the 2.5 marker is required.
		expect(geminiThinkingConfig('gemini-1.5-pro')).toBeUndefined();
	});
});
