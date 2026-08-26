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
	geminiGenerationControls,
	geminiUsage,
	GEMINI_FINISH_MAX_TOKENS,
} from 'src/transcription/providers/geminiShared';
import { TranscriptTruncatedError } from 'src/transcription/transcriptionErrors';
import { DEFAULT_GEMINI_MODEL, GEMINI_MODEL_SUGGESTIONS } from 'src/constants';

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

/**
 * The reasoning control a model is sent, read off the generation controls the
 * request actually carries.
 * @param model - Gemini model id
 * @returns The thinkingConfig for it, or undefined when it takes none
 */
function thinkingFor(model: string): object | undefined {
	return geminiGenerationControls(model).thinkingConfig;
}

describe('the reasoning control per generation', () => {
	it('turns thinking off for 2.5 flash-family models', () => {
		expect(thinkingFor('gemini-2.5-flash')).toEqual({
			thinkingBudget: 0,
		});
		expect(thinkingFor('gemini-2.5-flash-lite')).toEqual({
			thinkingBudget: 0,
		});
	});

	it('uses the minimum budget for 2.5 Pro, which cannot disable thinking', () => {
		expect(thinkingFor('gemini-2.5-pro')).toEqual({
			thinkingBudget: 128,
		});
		expect(thinkingFor('GEMINI-2.5-PRO')).toEqual({
			thinkingBudget: 128,
		});
	});

	it('returns undefined for models without a thinking budget (2.0 and earlier)', () => {
		// thinkingBudget is a 2.5-series feature; sending thinkingConfig to a
		// 2.0 model is rejected by the API, so the config must be omitted.
		expect(thinkingFor('gemini-2.0-flash')).toBeUndefined();
		// "pro" alone must not enable thinking - the generation decides.
		expect(thinkingFor('gemini-1.5-pro')).toBeUndefined();
	});
});

// The 3.x generation controls reasoning through a level rather than a budget,
// and the plugin sent neither: the default model ran with dynamic thinking,
// spent part of its output budget on it, and hit the cap before finishing the
// transcript often enough that parts were subdivided and re-sent, with the
// discarded request billed in full.
describe('which reasoning control each Gemini generation takes', () => {
	/**
	 * What the generation in an id calls for, worked out here rather than read
	 * from the code under test, so the two have to agree.
	 * @param model - Gemini model id
	 * @returns The control that model should be sent, or undefined for none
	 */
	function controlFor(model: string): object | undefined {
		const version = /^gemini-(\d+)(?:\.(\d+))?/.exec(model);
		const major = Number(version?.[1] ?? '0');
		const minor = Number(version?.[2] ?? '0');
		if (major >= 3) {
			return { thinkingLevel: 'low' };
		}
		if (major === 2 && minor >= 5) {
			return { thinkingBudget: model.includes('pro') ? 128 : 0 };
		}
		// 2.0 and earlier reject a thinkingConfig outright.
		return undefined;
	}

	// The whole seeded catalogue, so a model added to it arrives with an
	// answer rather than with whichever branch its id happens to match.
	it.each(GEMINI_MODEL_SUGGESTIONS)('decides for %s', (model) => {
		expect(thinkingFor(model)).toEqual(controlFor(model));
	});

	it('sends the level rather than a budget on the default model', () => {
		expect(thinkingFor(DEFAULT_GEMINI_MODEL)).toEqual({
			thinkingLevel: 'low',
		});
	});

	// The API refuses a request that carries both, so whichever generation is
	// in play, exactly one control goes out.
	it.each([...GEMINI_MODEL_SUGGESTIONS, 'gemini-2.0-flash', 'my-own-model'])(
		'never sends both controls for %s',
		(model) => {
			const config = thinkingFor(model) ?? {};

			expect(
				'thinkingLevel' in config && 'thinkingBudget' in config,
			).toBe(false);
		},
	);

	// A model id typed into the picker by hand is not something the plugin
	// knows the reasoning contract of, and a control the endpoint does not
	// take is a 400 before anything is transcribed. Saying nothing leaves the
	// model on its own defaults, which is the one answer that always works.
	it.each([
		{ name: 'a name from another vendor', model: 'my-own-model' },
		{ name: 'a bare family name', model: 'gemini-flash' },
		{ name: 'a version-less id', model: 'gemini' },
		{ name: 'a name that only starts alike', model: 'geminix-3-flash' },
		{ name: 'an empty id', model: '' },
	])('sends no control for $name', ({ model }) => {
		expect(thinkingFor(model)).toBeUndefined();
	});

	// A generation named without a minor is still a generation, and the next
	// one may well be published that way.
	it('reads a generation given without a minor version', () => {
		expect(thinkingFor('gemini-4-flash')).toEqual({
			thinkingLevel: 'low',
		});
		expect(thinkingFor('gemini-2-flash')).toBeUndefined();
	});

	// The picker stores whatever the user typed, including the case.
	it('reads the generation whatever case the id came in', () => {
		expect(thinkingFor('GEMINI-3.5-FLASH')).toEqual({
			thinkingLevel: 'low',
		});
	});
});

// Google's guidance for every Gemini 3.x model is to leave the temperature at
// its default of 1.0: reasoning there is tuned for it, and a lowered one
// "can cause unexpected behavior, looping, or degraded performance". On a
// transcription that shows up as a part that overran its output cap and was
// sent again - the exact cost the reasoning level was added to stop paying.
describe('which generations are sent a temperature at all', () => {
	it('keeps the temperature for the generation that is tuned for one', () => {
		expect(geminiGenerationControls('gemini-2.5-flash', 0)).toEqual({
			thinkingConfig: { thinkingBudget: 0 },
			temperature: 0,
		});
	});

	it('drops it for 3.x, whose reasoning is tuned for the default', () => {
		expect(geminiGenerationControls(DEFAULT_GEMINI_MODEL, 0)).toEqual({
			thinkingConfig: { thinkingLevel: 'low' },
		});
	});

	// An id the plugin cannot read is most likely another vendor behind a
	// compatible endpoint, where a temperature is ordinary and expected.
	it('keeps it for an id whose generation cannot be read', () => {
		expect(geminiGenerationControls('my-own-model', 0)).toEqual({
			temperature: 0,
		});
	});

	it('sends none when the caller named none', () => {
		expect(geminiGenerationControls('gemini-2.5-flash')).toEqual({
			thinkingConfig: { thinkingBudget: 0 },
		});
	});
});

// The API documents its ids with a `models/` prefix, and a user who copies one
// in used to get a 404 from `/v1beta/models/models/gemini-...` and a model the
// plugin could not read the generation of.
describe("a model id carrying the API's own prefix", () => {
	it('reaches the endpoint the bare id would', () => {
		expect(
			geminiGenerateContentUrl(
				'https://gen.example',
				'models/gemini-3.5-flash',
			),
		).toBe(
			'https://gen.example/v1beta/models/gemini-3.5-flash:generateContent',
		);
	});

	it('is read for its generation like any other', () => {
		expect(thinkingFor('models/gemini-3.5-flash')).toEqual({
			thinkingLevel: 'low',
		});
	});
});
