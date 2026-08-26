/**
 * Tests for the GeminiLlmProvider post-processing path: the generateContent
 * request shape (endpoint URL, x-goog-api-key header, max-tokens, thinking
 * disabled), text extraction, the per-model thinking budget, and the
 * truncation/block guards - all scripted through the shared requestUrl mock.
 */

import { GeminiLlmProvider } from 'src/transcription/llm/LlmProvider';
import { jsonBody } from '../helpers/assertions';
import type { LlmPrompt } from 'src/transcription/llmPostProcess';
// Mock-only surface: these exist on the test double, not on Obsidian's
// API, so they are imported from the mock by path. Jest maps 'obsidian'
// to the same module, so both imports share one instance.
import {
	type MockRequestUrlParam,
	type MockRequestUrlResponse,
} from '../mocks/obsidian';
import { withRequestUrl } from '../helpers/network';
import { DEFAULT_GEMINI_MODEL } from 'src/constants';

const BASE_URL = 'https://gemini.example';
const API_KEY = 'gm-test';
const MODEL = 'gemini-2.5-flash';
const MAX_TOKENS = 4096;
const PROMPT: LlmPrompt = { system: 'You clean transcripts.', user: 'hello' };

/** Shape of the generateContent request body the provider posts. */
interface LlmGenerateBody {
	generationConfig: {
		maxOutputTokens: number;
		thinkingConfig?: { thinkingBudget?: number; thinkingLevel?: string };
	};
}

function provider(model = MODEL): GeminiLlmProvider {
	return new GeminiLlmProvider({ baseUrl: BASE_URL, apiKey: API_KEY, model });
}

/** Wraps assistant text as a generateContent candidate body. */
function geminiText(text: string, finishReason = 'STOP'): string {
	return JSON.stringify({
		candidates: [{ finishReason, content: { parts: [{ text }] } }],
	});
}

describe('GeminiLlmProvider.complete', () => {
	it('posts to generateContent with the api-key header and thinking disabled', async () => {
		let seen: MockRequestUrlParam | undefined;
		withRequestUrl((param): MockRequestUrlResponse => {
			seen = param;
			return { status: 200, headers: {}, text: geminiText('Cleaned.') };
		});

		const out = await provider().complete(PROMPT, MAX_TOKENS);

		expect(out).toBe('Cleaned.');
		expect(seen?.url).toBe(
			`${BASE_URL}/v1beta/models/${MODEL}:generateContent`,
		);
		expect(seen?.headers?.['x-goog-api-key']).toBe(API_KEY);
		const body = jsonBody<LlmGenerateBody>(seen);
		expect(body.generationConfig.maxOutputTokens).toBe(MAX_TOKENS);
		expect(body.generationConfig.thinkingConfig).toEqual({
			thinkingBudget: 0,
		});
	});

	it('uses the Pro minimum thinking budget for a Pro model', async () => {
		let seen: MockRequestUrlParam | undefined;
		withRequestUrl((param): MockRequestUrlResponse => {
			seen = param;
			return { status: 200, headers: {}, text: geminiText('ok') };
		});

		await provider('gemini-2.5-pro').complete(PROMPT, MAX_TOKENS);

		const body = jsonBody<LlmGenerateBody>(seen);
		expect(body.generationConfig.thinkingConfig?.thinkingBudget).toBe(128);
	});

	// Post-processing reads the same catalogue transcription does, so the
	// generation the plugin defaults to has to be handled on both paths.
	it('sends the reasoning level on a 3.x model', async () => {
		let seen: MockRequestUrlParam | undefined;
		withRequestUrl((param): MockRequestUrlResponse => {
			seen = param;
			return { status: 200, headers: {}, text: geminiText('ok') };
		});

		await provider(DEFAULT_GEMINI_MODEL).complete(PROMPT, MAX_TOKENS);

		const body = jsonBody<LlmGenerateBody>(seen);
		expect(body.generationConfig.thinkingConfig).toEqual({
			thinkingLevel: 'low',
		});
	});

	it('omits thinkingConfig for a model without a thinking budget (2.0)', async () => {
		let seen: MockRequestUrlParam | undefined;
		withRequestUrl((param): MockRequestUrlResponse => {
			seen = param;
			return { status: 200, headers: {}, text: geminiText('ok') };
		});

		await provider('gemini-2.0-flash').complete(PROMPT, MAX_TOKENS);

		// 2.0 rejects thinkingConfig, so the key must be absent entirely.
		const body = jsonBody<LlmGenerateBody>(seen);
		expect('thinkingConfig' in body.generationConfig).toBe(false);
	});

	it('throws with the LLM remedy when the answer was truncated', async () => {
		withRequestUrl(() => ({
			status: 200,
			headers: {},
			text: geminiText('partial', 'MAX_TOKENS'),
		}));

		// The LLM path does expose a max-tokens setting, so its remedy points
		// there (unlike the transcription path).
		await expect(provider().complete(PROMPT, MAX_TOKENS)).rejects.toThrow(
			/raise the max output tokens/i,
		);
	});

	it('throws when the prompt was blocked', async () => {
		withRequestUrl(() => ({
			status: 200,
			headers: {},
			text: JSON.stringify({ promptFeedback: { blockReason: 'SAFETY' } }),
		}));

		await expect(provider().complete(PROMPT, MAX_TOKENS)).rejects.toThrow(
			/blocked/i,
		);
	});
});
