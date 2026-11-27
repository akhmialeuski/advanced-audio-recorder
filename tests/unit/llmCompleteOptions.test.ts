/**
 * Tests that every LLM provider forwards the optional per-call temperature
 * (used by the advanced transcription context agents to pin deterministic
 * output) and omits the field entirely when the caller does not set it, so
 * each API keeps its own default. Outgoing requests are captured through the
 * shared requestUrl mock.
 * @module tests/unit/llmCompleteOptions.test
 */

import {
	AnthropicLlmProvider,
	GeminiLlmProvider,
	OpenAiCompatibleLlmProvider,
} from 'src/transcription/llm/LlmProvider';
import { jsonBody } from '../helpers/assertions';
import type { LlmPrompt } from 'src/transcription/llmPostProcess';
import type { LlmProvider } from 'src/transcription/llm/LlmProvider';
// Mock-only surface: these exist on the test double, not on Obsidian's
// API, so they are imported from the mock by path. Jest maps 'obsidian'
// to the same module, so both imports share one instance.
import {
	type MockRequestUrlParam,
	type MockRequestUrlResponse,
} from '../mocks/obsidian';
import { withRequestUrl } from '../helpers/network';
import { geminiCutAnswer, OPENAI_IDENTITY } from '../helpers/llmDoubles';
import { outcomeOf } from '../helpers/async';
import { EngineLabel } from 'src/providers/providers';

const PROMPT: LlmPrompt = { system: 'You extract terms.', user: 'hello' };

/** Captures the single request and answers with the provider-shaped text. */
function capture(responseText: string): {
	body: () => Record<string, unknown>;
} {
	let seen: MockRequestUrlParam | undefined;
	withRequestUrl((param): MockRequestUrlResponse => {
		seen = param;
		return { status: 200, headers: {}, text: responseText };
	});
	return {
		body: (): Record<string, unknown> =>
			jsonBody<Record<string, unknown>>(seen),
	};
}

/**
 * The client under test, built as every case here builds it.
 *
 * What these tests vary is the call, not the vendor, so the endpoint, the key,
 * the model, and the identity the client answers as are settled once.
 * @returns A provider pointed at the stub endpoint
 */
function openAiProvider(): OpenAiCompatibleLlmProvider {
	return new OpenAiCompatibleLlmProvider(
		{
			baseUrl: 'https://openai.example',
			apiKey: 'k',
			model: 'gpt-4o-mini',
		},
		OPENAI_IDENTITY,
	);
}

const OPENAI_RESPONSE = JSON.stringify({
	choices: [{ message: { content: 'ok' } }],
});
const ANTHROPIC_RESPONSE = JSON.stringify({
	content: [{ type: 'text', text: 'ok' }],
});
const GEMINI_RESPONSE = JSON.stringify({
	candidates: [
		{ finishReason: 'STOP', content: { parts: [{ text: 'ok' }] } },
	],
});

/**
 * The three vendors, each with a response that reports no usage and one that
 * reports 1200 prompt and 340 completion tokens. Named once so a case that
 * walks the vendors says only what it is checking.
 */
const VENDORS = [
	{
		name: EngineLabel.OpenAi,
		build: (): LlmProvider => openAiProvider(),
		response: OPENAI_RESPONSE,
		withUsage: JSON.stringify({
			choices: [{ message: { content: 'ok' } }],
			usage: { prompt_tokens: 1200, completion_tokens: 340 },
		}),
	},
	{
		name: 'Anthropic',
		build: (): LlmProvider =>
			new AnthropicLlmProvider({
				baseUrl: 'https://anthropic.example',
				apiKey: 'k',
				model: 'claude-sonnet-5',
			}),
		response: ANTHROPIC_RESPONSE,
		withUsage: JSON.stringify({
			content: [{ type: 'text', text: 'ok' }],
			usage: { input_tokens: 1200, output_tokens: 340 },
		}),
	},
	{
		name: 'Gemini',
		build: (): LlmProvider =>
			new GeminiLlmProvider({
				baseUrl: 'https://gemini.example',
				apiKey: 'k',
				model: 'gemini-2.5-flash',
			}),
		response: GEMINI_RESPONSE,
		withUsage: JSON.stringify({
			candidates: [
				{
					finishReason: 'STOP',
					content: { parts: [{ text: 'ok' }] },
				},
			],
			usageMetadata: {
				promptTokenCount: 1200,
				candidatesTokenCount: 340,
			},
		}),
	},
] as const;

describe('LlmProvider.complete temperature option', () => {
	it('sends and omits temperature on the OpenAI provider', async () => {
		const provider = openAiProvider();

		let captured = capture(OPENAI_RESPONSE);
		await provider.complete(PROMPT, 256, { temperature: 0 });
		expect(captured.body().temperature).toBe(0);

		captured = capture(OPENAI_RESPONSE);
		await provider.complete(PROMPT, 256);
		expect('temperature' in captured.body()).toBe(false);
	});

	it('sends and omits temperature on the Anthropic provider', async () => {
		const provider = new AnthropicLlmProvider({
			baseUrl: 'https://anthropic.example',
			apiKey: 'k',
			model: 'claude-haiku-4-5',
		});

		let captured = capture(ANTHROPIC_RESPONSE);
		await provider.complete(PROMPT, 256, { temperature: 0 });
		expect(captured.body().temperature).toBe(0);

		captured = capture(ANTHROPIC_RESPONSE);
		await provider.complete(PROMPT, 256);
		expect('temperature' in captured.body()).toBe(false);
	});

	it('sends and omits temperature in the Gemini generationConfig', async () => {
		const provider = new GeminiLlmProvider({
			baseUrl: 'https://gemini.example',
			apiKey: 'k',
			model: 'gemini-2.5-flash',
		});

		let captured = capture(GEMINI_RESPONSE);
		await provider.complete(PROMPT, 256, { temperature: 0 });
		let config = captured.body().generationConfig as Record<
			string,
			unknown
		>;
		expect(config.temperature).toBe(0);

		captured = capture(GEMINI_RESPONSE);
		await provider.complete(PROMPT, 256);
		config = captured.body().generationConfig as Record<string, unknown>;
		expect('temperature' in config).toBe(false);
	});
});

// Temperature reaches the body; the signal has to reach the request, which is
// a different journey and the one that was missing. Without it a Cancel
// pressed while the model is still writing left the run waiting out the
// five-minute timeout.
describe('LlmProvider.complete cancellation', () => {
	it.each(VENDORS)(
		'releases the $name request the moment the caller cancels',
		async ({ build }) => {
			withRequestUrl(() => new Promise(() => undefined));
			const controller = new AbortController();

			const settled = outcomeOf(
				build().complete(PROMPT, 256, { signal: controller.signal }),
			);
			controller.abort();

			expect(await settled).toEqual({
				error: expect.objectContaining({
					message: expect.stringContaining('cancelled'),
				}),
			});
		},
	);
});

// A completed step is billed at what the vendor says it cost, so what each
// provider hands back has to carry the counts the response reported and to
// carry nothing when it reported none.
describe('the usage each provider hands back', () => {
	it.each(VENDORS)(
		'carries the counts a $name response reported',
		async ({ build, withUsage }) => {
			capture(withUsage);

			expect(await build().complete(PROMPT, 512)).toEqual({
				text: 'ok',
				usage: { inputTokens: 1200, outputTokens: 340 },
			});
		},
	);

	it.each(VENDORS)(
		'carries no usage where a $name response reported none',
		async ({ build, response }) => {
			capture(response);

			// Absent, not empty: "billed nothing" is a different claim from
			// "said nothing", and only the second may fall back to an estimate
			expect(await build().complete(PROMPT, 512)).toEqual({ text: 'ok' });
		},
	);
});

// An answer cut at the output limit is not the answer: taken as one, a
// cleanup that stopped at 8:57 of an hour-long lesson replaced the whole
// transcript with its first tenth.
describe('an answer the vendor cut at its output limit', () => {
	it('is refused on the OpenAI wire format, naming the limit', async () => {
		capture(
			JSON.stringify({
				choices: [
					{
						finish_reason: 'length',
						message: { content: '[[recording' },
					},
				],
			}),
		);

		await expect(openAiProvider().complete(PROMPT, 512)).rejects.toThrow(
			/output token limit/,
		);
	});

	// The refusal has to say enough to act on: whose limit, how large it is,
	// how much of it went to reasoning, and where the limit is set.
	it('names the engine, the limit, the reasoning share and where to raise it', async () => {
		capture(
			JSON.stringify({
				choices: [
					{
						finish_reason: 'length',
						message: { content: '[[recording' },
					},
				],
				usage: {
					prompt_tokens: 36626,
					completion_tokens: 512,
					completion_tokens_details: { reasoning_tokens: 300 },
				},
			}),
		);

		const outcome = await outcomeOf(openAiProvider().complete(PROMPT, 512));

		expect(outcome).toEqual({
			error: expect.objectContaining({
				message: `${OPENAI_IDENTITY.label} stopped at its output token limit of 512, 300 of them spent on reasoning, so the answer is incomplete. Raise Max output tokens on the ${OPENAI_IDENTITY.label} page under Engines, or choose a model with a larger output limit.`,
				inputTokens: 36626,
				reasoningTokens: 300,
				usage: { inputTokens: 36626, outputTokens: 512 },
			}),
		});
	});

	it('is refused on the Anthropic wire format, naming the limit', async () => {
		capture(
			JSON.stringify({
				stop_reason: 'max_tokens',
				content: [{ type: 'text', text: '[[recording' }],
			}),
		);
		const anthropic = new AnthropicLlmProvider({
			baseUrl: 'https://anthropic.example',
			apiKey: 'k',
			model: 'claude-sonnet-5',
		});

		await expect(anthropic.complete(PROMPT, 512)).rejects.toThrow(
			/output token limit/,
		);
	});

	it('carries the counts an Anthropic response reported', async () => {
		capture(
			JSON.stringify({
				stop_reason: 'max_tokens',
				content: [{ type: 'text', text: '[[recording' }],
				usage: { input_tokens: 900, output_tokens: 512 },
			}),
		);
		const anthropic = new AnthropicLlmProvider({
			baseUrl: 'https://anthropic.example',
			apiKey: 'k',
			model: 'claude-sonnet-5',
		});

		expect(await outcomeOf(anthropic.complete(PROMPT, 512))).toEqual({
			error: expect.objectContaining({
				inputTokens: 900,
				usage: { inputTokens: 900, outputTokens: 512 },
			}),
		});
	});

	// The Gemini client refused the same stop with an error of its own, which
	// carried no counts, so the notice could not say how large the limit has
	// to be for a cleanup cut on Gemini.
	it('is refused on the Gemini wire format with the counts the notice sizes by', async () => {
		capture(
			JSON.stringify(
				geminiCutAnswer({
					promptTokenCount: 36626,
					candidatesTokenCount: 32448,
					thoughtsTokenCount: 17552,
				}),
			),
		);
		const gemini = new GeminiLlmProvider({
			baseUrl: 'https://gemini.example',
			apiKey: 'k',
			model: 'gemini-2.5-flash',
		});

		expect(await outcomeOf(gemini.complete(PROMPT, 50000))).toEqual({
			error: expect.objectContaining({
				message: `${EngineLabel.Gemini} stopped at its output token limit of 50000, 17552 of them spent on reasoning, so the answer is incomplete. Raise Max output tokens on the ${EngineLabel.Gemini} page under Engines, or choose a model with a larger output limit.`,
				inputTokens: 36626,
				reasoningTokens: 17552,
				usage: { inputTokens: 36626, outputTokens: 50000 },
			}),
		});
	});

	it('takes an answer that stopped on its own as it is', async () => {
		capture(
			JSON.stringify({
				choices: [
					{ finish_reason: 'stop', message: { content: 'ok' } },
				],
			}),
		);

		expect(await openAiProvider().complete(PROMPT, 512)).toEqual({
			text: 'ok',
		});
	});
});

// A body with no choice names no stop at all, so it is no truncated answer:
// it is read as it was before, as an answer with no text.
describe('an OpenAI-style body that carries no choice', () => {
	it('is taken as an answer with no text', async () => {
		capture(JSON.stringify({ id: 'chatcmpl-1' }));

		expect(await openAiProvider().complete(PROMPT, 512)).toEqual({
			text: '',
		});
	});
});
