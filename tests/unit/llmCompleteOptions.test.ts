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
import { outcomeOf } from '../helpers/async';

const PROMPT: LlmPrompt = { system: 'You extract terms.', user: 'hello' };

/** The one method these cases drive, whichever vendor implements it. */
type LlmProviderComplete = LlmProvider['complete'];

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

describe('LlmProvider.complete temperature option', () => {
	it('sends and omits temperature on the OpenAI provider', async () => {
		const provider = new OpenAiCompatibleLlmProvider({
			baseUrl: 'https://openai.example',
			apiKey: 'k',
			model: 'gpt-4o-mini',
		});

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

// Temperature reaches the body; the signal has to reach the transport, which
// is a different journey and the one that was missing. `requestUrl` cannot
// abort, so a request carrying a signal goes through `fetch` instead, and that
// is what this watches: a Cancel that does not release the socket leaves the
// provider to run the call and bill for it.
describe('LlmProvider.complete cancellation', () => {
	/** Answers one fetch and records the init it was called with. */
	function captureFetch(responseText: string): () => RequestInit {
		let seen: RequestInit | undefined;
		(globalThis as { fetch?: unknown }).fetch = jest.fn(
			(_url: string, init: RequestInit) => {
				seen = init;
				return Promise.resolve({
					status: 200,
					headers: new Headers(),
					text: () => Promise.resolve(responseText),
				});
			},
		);
		return () => {
			if (!seen) {
				throw new Error('no request was sent through fetch');
			}
			return seen;
		};
	}

	afterEach(() => {
		delete (globalThis as { fetch?: unknown }).fetch;
	});

	it.each([
		{
			name: 'OpenAI',
			build: (): { complete: LlmProviderComplete } =>
				new OpenAiCompatibleLlmProvider({
					baseUrl: 'https://openai.example',
					apiKey: 'k',
					model: 'gpt-4o-mini',
				}),
			response: OPENAI_RESPONSE,
		},
		{
			name: 'Anthropic',
			build: (): { complete: LlmProviderComplete } =>
				new AnthropicLlmProvider({
					baseUrl: 'https://anthropic.example',
					apiKey: 'k',
					model: 'claude-sonnet-5',
				}),
			response: ANTHROPIC_RESPONSE,
		},
		{
			name: 'Gemini',
			build: (): { complete: LlmProviderComplete } =>
				new GeminiLlmProvider({
					baseUrl: 'https://gemini.example',
					apiKey: 'k',
					model: 'gemini-2.5-flash',
				}),
			response: GEMINI_RESPONSE,
		},
	])(
		'sends the $name request on an abortable transport',
		async ({ build, response }) => {
			const init = captureFetch(response);

			await build().complete(PROMPT, 256, {
				signal: new AbortController().signal,
			});

			// `requestUrl` cannot abort anything, so the only way a Cancel can
			// release the socket is for the request to go out through fetch with
			// a signal on it. That it did is the whole fix.
			expect(init().signal).toBeDefined();
		},
	);

	// The point of the signal: a Cancel while the model is still writing ends
	// the request instead of leaving it to run to its own timeout and be
	// billed in full.
	it('ends an in-flight request when the caller cancels', async () => {
		(globalThis as { fetch?: unknown }).fetch = jest.fn(
			(_url: string, init: RequestInit) =>
				new Promise((_resolve, reject) => {
					init.signal?.addEventListener('abort', () => {
						reject(new Error('The user aborted a request.'));
					});
				}),
		);
		const controller = new AbortController();
		const provider = new OpenAiCompatibleLlmProvider({
			baseUrl: 'https://openai.example',
			apiKey: 'k',
			model: 'gpt-4o-mini',
		});

		const settled = outcomeOf(
			provider.complete(PROMPT, 256, { signal: controller.signal }),
		);
		controller.abort();

		expect(await settled).toEqual({
			error: expect.objectContaining({
				message: expect.stringContaining('cancelled'),
			}),
		});
	});

	// Nothing to cancel with means nothing to gain from fetch, and requestUrl
	// is the transport that is exempt from CORS, so it stays the default.
	it('keeps the CORS-exempt transport when there is nothing to cancel with', async () => {
		captureFetch(OPENAI_RESPONSE);
		capture(OPENAI_RESPONSE);

		await new OpenAiCompatibleLlmProvider({
			baseUrl: 'https://openai.example',
			apiKey: 'k',
			model: 'gpt-4o-mini',
		}).complete(PROMPT, 256);

		expect(globalThis.fetch).not.toHaveBeenCalled();
	});
});
