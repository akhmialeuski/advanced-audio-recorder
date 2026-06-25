/**
 * Tests for the shared Gemini response helpers: concatenating the candidate
 * text parts, reading the finish reason, and the truncation guard that turns a
 * MAX_TOKENS stop into a clear error (so a thinking-model output overrun is not
 * silently mapped to an empty transcript or post-processing result).
 */

import {
	assertGeminiNotTruncated,
	geminiCandidateText,
	geminiFinishReason,
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
