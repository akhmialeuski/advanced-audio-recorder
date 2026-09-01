/**
 * Tests for the token counts read out of an LLM response. These are what a
 * completed step is billed at, so a count the vendor did not send has to stay
 * absent rather than become a zero the pricing would treat as free.
 */

import {
	extractAnthropicUsage,
	extractGeminiUsage,
	extractOpenAiUsage,
} from 'src/transcription/llm/llmResponse';

describe('the counts an OpenAI response reports', () => {
	it('reads the prompt and completion tokens', () => {
		expect(
			extractOpenAiUsage({
				usage: { prompt_tokens: 1200, completion_tokens: 340 },
			}),
		).toEqual({ inputTokens: 1200, outputTokens: 340 });
	});

	it('does not add a reasoning breakdown back onto the completion total', () => {
		// OpenAI bills reasoning as output and reports it as a breakdown of
		// `completion_tokens`, not beside it. Carrying the breakdown out
		// separately made the pricing add it to a total it was already inside,
		// which on a reasoning model is most of the charge counted twice.
		expect(
			extractOpenAiUsage({
				usage: {
					prompt_tokens: 1200,
					completion_tokens: 340,
					completion_tokens_details: { reasoning_tokens: 256 },
				},
			}),
		).toEqual({ inputTokens: 1200, outputTokens: 340 });
	});

	it.each([
		{ case: 'a body that is not an object', body: 'nope' },
		{ case: 'a response with no usage section', body: { choices: [] } },
		{ case: 'a usage section that is not an object', body: { usage: 7 } },
		{
			case: 'counts that are not numbers',
			body: { usage: { prompt_tokens: 'many' } },
		},
		{
			case: 'a negative count',
			body: { usage: { prompt_tokens: -1 } },
		},
	])('reports nothing for $case', ({ body }) => {
		expect(extractOpenAiUsage(body)).toEqual({});
	});
});

describe('the counts an Anthropic response reports', () => {
	it('reads the input and output tokens', () => {
		expect(
			extractAnthropicUsage({
				usage: { input_tokens: 900, output_tokens: 120 },
			}),
		).toEqual({ inputTokens: 900, outputTokens: 120 });
	});

	it('keeps the half a truncated response did report', () => {
		expect(extractAnthropicUsage({ usage: { input_tokens: 900 } })).toEqual(
			{ inputTokens: 900 },
		);
	});

	it('reports nothing for a response with no usage section', () => {
		expect(extractAnthropicUsage({ content: [] })).toEqual({});
	});
});

describe('the counts a Gemini response reports', () => {
	it('bills the thinking tokens on top of the candidate ones', () => {
		// Gemini prices a thinking response as the sum of its output and
		// thinking tokens, so the two are added at extraction and the caller
		// sees the one output total every vendor is normalised to.
		expect(
			extractGeminiUsage({
				usageMetadata: {
					promptTokenCount: 5000,
					candidatesTokenCount: 400,
					thoughtsTokenCount: 900,
				},
			}),
		).toEqual({ inputTokens: 5000, outputTokens: 1300 });
	});

	it('bills the thinking a response that produced no candidates still did', () => {
		// A model can spend its whole output budget thinking and be cut off
		// before it writes an answer. Gemini bills that thinking, so a missing
		// candidate count must not take the thoughts down with it.
		expect(
			extractGeminiUsage({
				usageMetadata: {
					promptTokenCount: 5000,
					thoughtsTokenCount: 900,
				},
			}),
		).toEqual({ inputTokens: 5000, outputTokens: 900 });
	});

	it('leaves out the thinking tokens a non-reasoning model omits', () => {
		expect(
			extractGeminiUsage({
				usageMetadata: {
					promptTokenCount: 5000,
					candidatesTokenCount: 400,
				},
			}),
		).toEqual({ inputTokens: 5000, outputTokens: 400 });
	});

	it('reports nothing for a response with no usage metadata', () => {
		expect(extractGeminiUsage({ candidates: [] })).toEqual({});
	});
});
