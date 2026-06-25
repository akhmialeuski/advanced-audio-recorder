/**
 * Tests for the shared Gemini helpers: request building (endpoint URL and the
 * per-model thinking config) and response parsing (candidate text, finish
 * reason, the truncation guard, and the block guard) — so a thinking-model
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
	GEMINI_FINISH_MAX_TOKENS,
} from 'src/transcription/providers/geminiShared';

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

	it('returns empty string when candidates or parts are absent', () => {
		expect(geminiCandidateText({})).toBe('');
		expect(geminiCandidateText({ candidates: [] })).toBe('');
		expect(geminiCandidateText({ candidates: [{ content: {} }] })).toBe('');
		expect(geminiCandidateText(null)).toBe('');
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
	it('throws when the response was cut off at the output token limit', () => {
		expect(() =>
			assertGeminiNotTruncated({
				candidates: [{ finishReason: GEMINI_FINISH_MAX_TOKENS }],
			}),
		).toThrow(/output token limit/i);
	});

	it('does not throw for a normal stop or an absent finish reason', () => {
		expect(() =>
			assertGeminiNotTruncated({
				candidates: [{ finishReason: 'STOP' }],
			}),
		).not.toThrow();
		expect(() => assertGeminiNotTruncated({})).not.toThrow();
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
	it('turns thinking off for flash-family models', () => {
		expect(geminiThinkingConfig('gemini-2.5-flash')).toEqual({
			thinkingBudget: 0,
		});
		expect(geminiThinkingConfig('gemini-2.0-flash')).toEqual({
			thinkingBudget: 0,
		});
	});

	it('uses the minimum budget for Pro models, which cannot disable thinking', () => {
		expect(geminiThinkingConfig('gemini-2.5-pro')).toEqual({
			thinkingBudget: 128,
		});
		expect(geminiThinkingConfig('GEMINI-2.5-PRO')).toEqual({
			thinkingBudget: 128,
		});
	});
});
