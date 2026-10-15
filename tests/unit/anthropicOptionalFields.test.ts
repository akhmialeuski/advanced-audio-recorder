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
import type { MockRequestUrlParam } from '../mocks/obsidian';
import { queueResponses } from '../helpers/network';
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

/** A refusal that names only the body key the effort travels under. */
const REFUSES_OUTPUT_CONFIG = JSON.stringify({
	type: 'error',
	error: {
		type: 'invalid_request_error',
		message: 'output_config: Extra inputs are not permitted',
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
 * The JSON bodies of the captured requests, in the order they were sent.
 * @param sent - The requests a queue recorded
 */
function bodiesOf(sent: MockRequestUrlParam[]): Array<Record<string, unknown>> {
	return sent.map((param) => jsonBody<Record<string, unknown>>(param));
}

describe('the optional fields the Anthropic provider sends', () => {
	it('asks for the lowest reasoning effort and forwards the temperature', async () => {
		const sent = queueResponses([{ status: 200, text: OK_BODY }]);

		await provider().complete(PROMPT, 512, { temperature: 0 });

		const [body] = bodiesOf(sent);
		expect(body?.output_config).toEqual({ effort: ANTHROPIC_LOW_EFFORT });
		expect(body?.temperature).toBe(0);
	});

	it('drops the temperature a model refuses and still answers', async () => {
		const sent = queueResponses([
			{ status: 400, text: REFUSES_TEMPERATURE },
			{ status: 200, text: OK_BODY },
		]);

		const answer = await provider().complete(PROMPT, 512, {
			temperature: 0,
		});

		expect(answer.text).toBe('ok');
		const bodies = bodiesOf(sent);
		expect(bodies).toHaveLength(2);
		expect(bodies[1]).not.toHaveProperty('temperature');
		// Only the refused field goes: the effort was never the problem.
		expect(bodies[1]?.output_config).toEqual({
			effort: ANTHROPIC_LOW_EFFORT,
		});
	});

	it.each([
		{ wording: 'naming the effort itself', refusal: REFUSES_EFFORT },
		{
			// The real wording is undocumented; the body key is the one name
			// certain to be on the wire.
			wording: 'naming only the body key it travels under',
			refusal: REFUSES_OUTPUT_CONFIG,
		},
	])(
		'drops the effort on a refusal $wording and keeps the temperature',
		async ({ refusal }) => {
			const sent = queueResponses([
				{ status: 400, text: refusal },
				{ status: 200, text: OK_BODY },
			]);

			await provider().complete(PROMPT, 512, { temperature: 0 });

			const bodies = bodiesOf(sent);
			expect(bodies).toHaveLength(2);
			expect(bodies[1]).not.toHaveProperty('output_config');
			expect(bodies[1]?.temperature).toBe(0);
		},
	);

	it('remembers a refusal, so the next call on the same provider is not refused again', async () => {
		// The advanced mode drives six sequential agent calls through one
		// provider; renegotiating on each would pay the refused request six times.
		const sent = queueResponses([
			{ status: 400, text: REFUSES_TEMPERATURE },
			{ status: 200, text: OK_BODY },
			{ status: 200, text: OK_BODY },
		]);
		const claude = provider();

		await claude.complete(PROMPT, 512, { temperature: 0 });
		await claude.complete(PROMPT, 512, { temperature: 0 });

		const bodies = bodiesOf(sent);
		expect(bodies).toHaveLength(3);
		expect(bodies[2]).not.toHaveProperty('temperature');
	});

	it('raises any other refusal as it came, without a retry', async () => {
		const sent = queueResponses([{ status: 401, text: BAD_KEY }]);

		const outcome = await outcomeOf(
			provider().complete(PROMPT, 512, { temperature: 0 }),
		);

		expect(outcome).toEqual({
			error: expect.objectContaining({ status: 401 }),
		});
		expect(bodiesOf(sent)).toHaveLength(1);
	});
});
