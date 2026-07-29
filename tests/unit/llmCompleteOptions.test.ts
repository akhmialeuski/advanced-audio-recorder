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
// Mock-only surface: these exist on the test double, not on Obsidian's
// API, so they are imported from the mock by path. Jest maps 'obsidian'
// to the same module, so both imports share one instance.
import {
	__setRequestUrlHandler,
	type MockRequestUrlParam,
	type MockRequestUrlResponse,
} from '../mocks/obsidian';

const PROMPT: LlmPrompt = { system: 'You extract terms.', user: 'hello' };

/** Captures the single request and answers with the provider-shaped text. */
function capture(responseText: string): {
	body: () => Record<string, unknown>;
} {
	let seen: MockRequestUrlParam | undefined;
	__setRequestUrlHandler((param): MockRequestUrlResponse => {
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

afterEach(() => {
	__setRequestUrlHandler(null);
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
