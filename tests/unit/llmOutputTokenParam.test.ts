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
 *
 * The original is asked first, because the two ways of not understanding a field
 * are not equally safe: a server that refuses one costs a request, a server that
 * ignores one drops the ceiling and says nothing. The answer is then remembered,
 * so a run that drives six agent calls through one provider negotiates once.
 * @module tests/unit/llmOutputTokenParam.test
 */

import { OpenAiCompatibleLlmProvider } from 'src/transcription/llm/LlmProvider';
import { HttpError } from 'src/transcription/httpClient';
import { jsonBody } from '../helpers/assertions';
import type { LlmPrompt } from 'src/transcription/llmPostProcess';
import {
	type MockRequestUrlParam,
	type MockRequestUrlResponse,
} from '../mocks/obsidian';
import { withRequestUrl } from '../helpers/network';

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
	withRequestUrl((param): MockRequestUrlResponse => {
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

describe('the output-token parameter the OpenAI provider sends', () => {
	it('asks with the original name first, and asks only once when it is taken', async () => {
		const sent = script([{ status: 200, text: OK_BODY }]);

		expect((await provider().complete(PROMPT, 4096)).text).toBe('ok');

		const bodies = sent.bodies();
		expect(bodies).toHaveLength(1);
		expect(bodies[0]?.max_tokens).toBe(4096);
		// Not both: OpenAI refuses the superseded name rather than ignoring it,
		// so carrying it alongside would fail every request it was added to.
		expect(bodies[0]).not.toHaveProperty('max_completion_tokens');
	});

	it('never leaves an endpoint that ignores unknown fields with no ceiling at all', async () => {
		// The reason the original name goes first. A server that drops a field it
		// does not know answers 200, so asking with the superseded name second
		// would be the only way the budget could be quietly discarded - and the
		// name that reaches such a server first is the one they all understand.
		const sent = script([{ status: 200, text: OK_BODY }]);

		await provider().complete(PROMPT, 1234);

		const first = sent.bodies()[0];
		expect(first?.max_tokens).toBe(1234);
	});

	it('falls back to the current name when the endpoint refuses the original', async () => {
		// OpenAI's own current models, which is the one endpoint that refuses it.
		const sent = script([
			{ status: 400, text: REFUSES_OLD_NAME },
			{ status: 200, text: OK_BODY },
		]);

		expect((await provider().complete(PROMPT, 2048)).text).toBe('ok');

		const bodies = sent.bodies();
		expect(bodies).toHaveLength(2);
		expect(bodies[0]?.max_tokens).toBe(2048);
		expect(bodies[1]?.max_completion_tokens).toBe(2048);
		expect(bodies[1]).not.toHaveProperty('max_tokens');
	});

	it('keeps the per-call temperature across the fallback', async () => {
		// The context agents pin it to 0 for a reproducible bias prompt, and a
		// retry that dropped it would make the second attempt a different call.
		const sent = script([
			{ status: 400, text: REFUSES_OLD_NAME },
			{ status: 200, text: OK_BODY },
		]);

		await provider().complete(PROMPT, 512, { temperature: 0 });

		expect(sent.bodies()[1]?.temperature).toBe(0);
	});

	it('remembers the name the endpoint took, so a second call asks once', async () => {
		// The advanced two-pass mode drives six sequential agent calls through one
		// provider; renegotiating on each would pay the refused request six times.
		const sent = script([
			{ status: 400, text: REFUSES_OLD_NAME },
			{ status: 200, text: OK_BODY },
			{ status: 200, text: OK_BODY },
			{ status: 200, text: OK_BODY },
		]);
		const llm = provider();

		await llm.complete(PROMPT, 512);
		await llm.complete(PROMPT, 512);
		await llm.complete(PROMPT, 512);

		const bodies = sent.bodies();
		// One negotiation, then one request per call under the accepted name.
		expect(bodies).toHaveLength(4);
		expect(bodies[2]?.max_completion_tokens).toBe(512);
		expect(bodies[3]?.max_completion_tokens).toBe(512);
		expect(bodies[3]).not.toHaveProperty('max_tokens');
	});

	it('renegotiates when the remembered name stops being taken', async () => {
		// A base URL repointed at another server between runs: the memory is about
		// an endpoint, so it has to give way when the endpoint disagrees rather
		// than fail on an answer that was true of a different host.
		const sent = script([
			{ status: 200, text: OK_BODY },
			{ status: 400, text: REFUSES_OLD_NAME },
			{ status: 200, text: OK_BODY },
		]);
		const llm = provider();

		await llm.complete(PROMPT, 512);
		expect((await llm.complete(PROMPT, 512)).text).toBe('ok');

		const bodies = sent.bodies();
		expect(bodies).toHaveLength(3);
		expect(bodies[1]?.max_tokens).toBe(512);
		expect(bodies[2]?.max_completion_tokens).toBe(512);
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
			{ status: 400, text: REFUSES_OLD_NAME },
			{ status: 400, text: REFUSES_NEW_NAME },
		]);

		await expect(provider().complete(PROMPT, 512)).rejects.toThrow(
			/max_completion_tokens/,
		);
		expect(sent.bodies()).toHaveLength(2);
	});

	it('does not remember a name the endpoint never accepted', async () => {
		// Both attempts failed, so there is nothing to lead with next time: a
		// memory written on a refusal would make the next call ask in the order
		// that just did not work.
		const llm = provider();
		const failing = script([
			{ status: 400, text: REFUSES_OLD_NAME },
			{ status: 400, text: REFUSES_NEW_NAME },
		]);
		await expect(llm.complete(PROMPT, 512)).rejects.toBeInstanceOf(
			HttpError,
		);
		expect(failing.bodies()).toHaveLength(2);

		const retry = script([{ status: 200, text: OK_BODY }]);
		await llm.complete(PROMPT, 512);

		expect(retry.bodies()[0]?.max_tokens).toBe(512);
	});
});
