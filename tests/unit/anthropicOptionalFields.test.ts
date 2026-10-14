/**
 * Which optional fields the Anthropic provider sends, and what it does when a
 * model refuses one.
 *
 * Claude Opus 4.7 and every later model answer a non-default `temperature`
 * with a 400, so the advanced context agents, which pin temperature 0, failed
 * on the shipped default model before transcribing anything. The reasoning
 * `effort` the provider now sends is refused the other way round, by Haiku 4.5
 * and older models. A list of model families that take each field goes stale
 * with every release, so the endpoint is asked instead: a 400 naming the field
 * drops it, and the answer is remembered for the rest of the run.
 * @module tests/unit/anthropicOptionalFields.test
 */

import { AnthropicLlmProvider } from 'src/transcription/llm/LlmProvider';
import { ANTHROPIC_LOW_EFFORT } from 'src/constants';
import { jsonBody } from '../helpers/assertions';
import type { LlmPrompt } from 'src/transcription/llmPostProcess';
import {
	type MockRequestUrlParam,
	type MockRequestUrlResponse,
} from '../mocks/obsidian';
import { withRequestUrl } from '../helpers/network';
import { outcomeOf } from '../helpers/async';

const PROMPT: LlmPrompt = { system: 'You extract terms.', user: 'hello' };

const OK_BODY = JSON.stringify({ content: [{ type: 'text', text: 'ok' }] });

/** What the Messages API answers a model that no longer takes sampling fields. */
const REFUSES_TEMPERATURE = JSON.stringify({
	type: 'error',
	error: {
		type: 'invalid_request_error',
		message: '`temperature` is deprecated for this model.',
	},
});

/** What the Messages API answers a model that predates the effort control. */
const REFUSES_EFFORT = JSON.stringify({
	type: 'error',
	error: {
		type: 'invalid_request_error',
		message: 'output_config.effort: This model does not support effort.',
	},
});

/** A refusal that names neither optional field. */
const BAD_KEY = JSON.stringify({
	type: 'error',
	error: { type: 'authentication_error', message: 'invalid x-api-key' },
});

/** A provider pointed at a stub endpoint. */
function provider(): AnthropicLlmProvider {
	return new AnthropicLlmProvider({
		baseUrl: 'https://api.anthropic.example/v1',
		apiKey: 'sk-ant-test',
		model: 'claude-opus-5-5',
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

describe('the optional fields the Anthropic provider sends', () => {
	it('asks for the lowest reasoning effort and forwards the temperature', async () => {
		const sent = script([{ status: 200, text: OK_BODY }]);

		await provider().complete(PROMPT, 512, { temperature: 0 });

		const [body] = sent.bodies();
		expect(body?.output_config).toEqual({ effort: ANTHROPIC_LOW_EFFORT });
		expect(body?.temperature).toBe(0);
	});

	it('drops the temperature a model refuses and still answers', async () => {
		const sent = script([
			{ status: 400, text: REFUSES_TEMPERATURE },
			{ status: 200, text: OK_BODY },
		]);

		const answer = await provider().complete(PROMPT, 512, {
			temperature: 0,
		});

		expect(answer.text).toBe('ok');
		const bodies = sent.bodies();
		expect(bodies).toHaveLength(2);
		expect(bodies[1]).not.toHaveProperty('temperature');
		// Only the refused field goes: the effort was never the problem.
		expect(bodies[1]?.output_config).toEqual({
			effort: ANTHROPIC_LOW_EFFORT,
		});
	});

	it('drops the effort a model refuses and keeps the temperature', async () => {
		const sent = script([
			{ status: 400, text: REFUSES_EFFORT },
			{ status: 200, text: OK_BODY },
		]);

		await provider().complete(PROMPT, 512, { temperature: 0 });

		const bodies = sent.bodies();
		expect(bodies).toHaveLength(2);
		expect(bodies[1]).not.toHaveProperty('output_config');
		expect(bodies[1]?.temperature).toBe(0);
	});

	it('remembers a refusal, so the next call on the same provider is not refused again', async () => {
		// The advanced mode drives six sequential agent calls through one
		// provider; renegotiating on each would pay the refused request six times.
		const sent = script([
			{ status: 400, text: REFUSES_TEMPERATURE },
			{ status: 200, text: OK_BODY },
			{ status: 200, text: OK_BODY },
		]);
		const claude = provider();

		await claude.complete(PROMPT, 512, { temperature: 0 });
		await claude.complete(PROMPT, 512, { temperature: 0 });

		const bodies = sent.bodies();
		expect(bodies).toHaveLength(3);
		expect(bodies[2]).not.toHaveProperty('temperature');
	});

	it('raises any other refusal as it came, without a retry', async () => {
		const sent = script([{ status: 401, text: BAD_KEY }]);

		const outcome = await outcomeOf(
			provider().complete(PROMPT, 512, { temperature: 0 }),
		);

		expect(outcome).toEqual({
			error: expect.objectContaining({ status: 401 }),
		});
		expect(sent.bodies()).toHaveLength(1);
	});
});
