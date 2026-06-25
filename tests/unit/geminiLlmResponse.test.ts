/**
 * Tests for the Gemini LLM text extractor: concatenating the candidate text
 * parts, and tolerance of missing parts or a non-record body.
 */

import { extractGeminiText } from 'src/transcription/llm/llmResponse';

describe('extractGeminiText', () => {
	it('concatenates the text parts of the first candidate', () => {
		const text = extractGeminiText({
			candidates: [
				{ content: { parts: [{ text: 'Hello ' }, { text: 'world' }] } },
			],
		});
		expect(text).toBe('Hello world');
	});

	it('trims surrounding whitespace', () => {
		const text = extractGeminiText({
			candidates: [{ content: { parts: [{ text: '  spaced  ' }] } }],
		});
		expect(text).toBe('spaced');
	});

	it('returns empty string when parts or candidates are absent', () => {
		expect(extractGeminiText({})).toBe('');
		expect(extractGeminiText({ candidates: [] })).toBe('');
		expect(extractGeminiText({ candidates: [{ content: {} }] })).toBe('');
		expect(extractGeminiText(null)).toBe('');
		expect(extractGeminiText('nope')).toBe('');
	});
});
