/**
 * Which name the OpenAI chat provider sends its output-token ceiling under.
 *
 * OpenAI superseded `max_tokens` with `max_completion_tokens` and its current
 * models refuse the old name outright, so post-processing and chapters failed
 * with "Unsupported parameter" before generating anything. Every
 * OpenAI-compatible server that is not OpenAI still speaks the original name,
 * and the same base URL setting points at all of them, so neither name can
 * simply replace the other and a list of "new" model families would go stale
 * with the next release. The endpoint is asked instead, and its refusal is what
 * selects the other name.
 * @module tests/unit/llmOutputTokenParam.test
 */

import { OpenAiCompatibleLlmProvider } from 'src/transcription/llm/LlmProvider';
import { HttpError } from 'src/transcription/httpClient';
import { jsonBody } from '../helpers/assertions';
import type { LlmPrompt } from 'src/transcription/llmPostProcess';
import {
	__setRequestUrlHandler,
	type MockRequestUrlParam,
	type MockRequestUrlResponse,
} from '../mocks/obsidian';

const PROMPT: LlmPrompt = { system: 'You write chapters.', user: 'transcript' };

const OK_BODY = JSON.stringify({ choices: [{ message: { content: 'ok' } }] });

/** What OpenAI answers a current model asked with the superseded name. */
const REFUSES_OLD_NAME = JSON.stringify({
	error: {
		message:
			"Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
		type: 'invalid_request_error',
		param: 'max_tokens',
	},
});

/** What a server that predates the rename answers the current name. */
const REFUSES_NEW_NAME = JSON.stringify({
	error: {
		message:
			'Unrecognized request argument supplied: max_completion_tokens',
		type: 'invalid_request_error',
	},
});

/** A provider pointed at a stub endpoint. */
function provider(): OpenAiCompatibleLlmProvider {
	return new OpenAiCompatibleLlmProvider({
		baseUrl: 'https://api.example.com/v1',
		apiKey: 'sk-test',
		model: 'gpt-5.6-sol',
	});
}

/**
 * Answers each request from a scripted list and records what was sent.
 * @param responses - One response per request, in order
 */
function script(responses: ReadonlyArray<{ status: number; text: string }>): {
	bodies: () => Array<Record<string, unknown>>;
} {
	const seen: MockRequestUrlParam[] = [];
	__setRequestUrlHandler((param): MockRequestUrlResponse => {
		seen.push(param);
		const answer = responses[seen.length - 1] ?? {
			status: 500,
			text: '{}',
		};
		return { status: answer.status, headers: {}, text: answer.text };
	});
	return {
		bodies: (): Array<Record<string, unknown>> =>
			seen.map((param) => jsonBody<Record<string, unknown>>(param)),
	};
}

afterEach(() => {
	__setRequestUrlHandler(null);
});

describe('the output-token parameter the OpenAI provider sends', () => {
	it('asks with the current name first, and asks only once when it is taken', async () => {
		const sent = script([{ status: 200, text: OK_BODY }]);

		expect(await provider().complete(PROMPT, 4096)).toBe('ok');

		const bodies = sent.bodies();
		expect(bodies).toHaveLength(1);
		expect(bodies[0]?.max_completion_tokens).toBe(4096);
		// Not both: OpenAI refuses the superseded name rather than ignoring it,
		// so carrying it alongside would fail every request it was added to.
		expect(bodies[0]).not.toHaveProperty('max_tokens');
	});

	it('falls back to the original name when the endpoint does not know the new one', async () => {
		// Groq, LM Studio, llama.cpp and the rest predate the rename, and the
		// same base URL setting points at them.
		const sent = script([
			{ status: 400, text: REFUSES_NEW_NAME },
			{ status: 200, text: OK_BODY },
		]);

		expect(await provider().complete(PROMPT, 2048)).toBe('ok');

		const bodies = sent.bodies();
		expect(bodies).toHaveLength(2);
		expect(bodies[0]?.max_completion_tokens).toBe(2048);
		expect(bodies[1]?.max_tokens).toBe(2048);
		expect(bodies[1]).not.toHaveProperty('max_completion_tokens');
	});

	it('keeps the per-call temperature across the fallback', async () => {
		// The context agents pin it to 0 for a reproducible bias prompt, and a
		// retry that dropped it would make the second attempt a different call.
		const sent = script([
			{ status: 400, text: REFUSES_NEW_NAME },
			{ status: 200, text: OK_BODY },
		]);

		await provider().complete(PROMPT, 512, { temperature: 0 });

		expect(sent.bodies()[1]?.temperature).toBe(0);
	});

	it('raises any other refusal instead of asking again under another name', async () => {
		// A bad key, a missing model, a rate limit: re-sending under the other
		// name would fail identically and cost a second request to learn it.
		const sent = script([
			{
				status: 400,
				text: JSON.stringify({
					error: { message: 'The model `nope` does not exist.' },
				}),
			},
		]);

		await expect(provider().complete(PROMPT, 512)).rejects.toBeInstanceOf(
			HttpError,
		);
		expect(sent.bodies()).toHaveLength(1);
	});

	it('reports the endpoint refusing both names rather than looping', async () => {
		const sent = script([
			{ status: 400, text: REFUSES_NEW_NAME },
			{ status: 400, text: REFUSES_OLD_NAME },
		]);

		await expect(provider().complete(PROMPT, 512)).rejects.toThrow(
			/max_tokens/,
		);
		expect(sent.bodies()).toHaveLength(2);
	});
});
