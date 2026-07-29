/**
 * Tests the accounted LLM call. Every LLM-driven step goes through it, which
 * is what puts their spend into the session total: LLM vendors report no usage,
 * so before this the context agents, the post-processing pass, and auto
 * chapters cost real money that nothing recorded after the pre-run estimate.
 * @module tests/unit/llmStep.test
 */

import { runLlmStep, type LlmCostSink } from 'src/transcription/llm/llmStep';
import { SessionCostTracker } from 'src/transcription/SessionCostTracker';
import { estimateLlmCallCost, estimateStepCost } from 'src/transcription/costs';
import { mergeSettings } from 'src/settings/settingsSerialization';
import { LLM_PROVIDER_IDS } from 'src/constants';
import type { LlmProvider } from 'src/transcription/llm/LlmProvider';
import type { RunCostStepId } from 'src/transcription/costs';
import { at, defined } from '../helpers/assertions';

/** A provider that returns fixed text and records how it was called. */
function stubLlm(
	text = 'answer',
	fail?: Error,
): LlmProvider & { calls: unknown[][] } {
	const calls: unknown[][] = [];
	return {
		id: LLM_PROVIDER_IDS.GEMINI,
		label: 'Google Gemini',
		calls,
		complete: (prompt, maxTokens, options) => {
			calls.push([prompt, maxTokens, options]);
			return fail ? Promise.reject(fail) : Promise.resolve(text);
		},
	};
}

/** A sink that records every reported call. */
function stubSink(): LlmCostSink & {
	records: [string, RunCostStepId, number | null][];
} {
	const records: [string, RunCostStepId, number | null][] = [];
	return {
		records,
		recordLlmCall: (providerId, step, usd) => {
			records.push([providerId, step, usd]);
		},
	};
}

const settings = mergeSettings({
	llmProvider: LLM_PROVIDER_IDS.GEMINI,
	llmGeminiModel: 'gemini-2.5-flash',
	llmMaxTokens: 32000,
});

describe('runLlmStep', () => {
	it('returns the provider text and passes the call through unchanged', async () => {
		const llm = stubLlm('hello');
		const prompt = { system: 's', user: 'u' };

		const text = await runLlmStep({
			step: 'autoChapters',
			llm,
			prompt,
			maxTokens: 100,
			settings,
			durationSeconds: 600,
			options: { temperature: 0 },
		});

		expect(text).toBe('hello');
		expect(at(llm.calls, 0)).toEqual([prompt, 100, { temperature: 0 }]);
	});

	it('reports the step cost the shared model prices', async () => {
		const sink = stubSink();

		await runLlmStep({
			step: 'autoChapters',
			llm: stubLlm(),
			prompt: { system: 's', user: 'u' },
			maxTokens: 100,
			settings,
			durationSeconds: 600,
			costSink: sink,
		});

		// The same figure the pre-run breakdown shows for this step, so the
		// estimate the user saw is the one that lands in the total.
		const expected = estimateStepCost('autoChapters', settings, 600).usd;
		expect(at(sink.records, 0)).toEqual([
			LLM_PROVIDER_IDS.GEMINI,
			'autoChapters',
			expected,
		]);
	});

	it('records an unknown duration as unpriced rather than as free', async () => {
		const sink = stubSink();

		await runLlmStep({
			step: 'postProcess',
			llm: stubLlm(),
			prompt: { system: 's', user: 'u' },
			maxTokens: 100,
			settings,
			durationSeconds: null,
			costSink: sink,
		});

		expect(at(sink.records, 0)[2]).toBeNull();
	});

	it('does not account a failed call and lets the error through', async () => {
		const sink = stubSink();

		await expect(
			runLlmStep({
				step: 'contextAgents',
				llm: stubLlm('', new Error('upstream down')),
				prompt: { system: 's', user: 'u' },
				maxTokens: 100,
				settings,
				durationSeconds: 600,
				costSink: sink,
			}),
		).rejects.toThrow('upstream down');

		// A call that threw was not billed, and the caller's own error handling
		// decides what happens next - the wrapper must not reshape either.
		expect(sink.records).toEqual([]);
	});

	it('runs without a sink for callers that do not account spending', async () => {
		await expect(
			runLlmStep({
				step: 'postProcess',
				llm: stubLlm('ok'),
				prompt: { system: 's', user: 'u' },
				maxTokens: 100,
				settings,
				durationSeconds: 600,
			}),
		).resolves.toBe('ok');
	});
});

describe('SessionCostTracker as an LLM cost sink', () => {
	it('adds LLM calls to the same total as transcription runs', async () => {
		const tracker = new SessionCostTracker();
		tracker.add('deepgram', 0.04);

		await runLlmStep({
			step: 'autoChapters',
			llm: stubLlm(),
			prompt: { system: 's', user: 'u' },
			maxTokens: 100,
			settings,
			durationSeconds: 600,
			costSink: tracker,
		});

		const step = defined(
			estimateStepCost('autoChapters', settings, 600).usd,
		);
		expect(tracker.totalUsd()).toBeCloseTo(0.04 + step, 10);
		// Each provider keeps its own row, so the breakdown still says who was
		// billed for what.
		expect(tracker.engineTotals().map((e) => e.engineId)).toEqual([
			'deepgram',
			LLM_PROVIDER_IDS.GEMINI,
		]);
	});

	it('counts an unpriced LLM call separately instead of as zero', async () => {
		const tracker = new SessionCostTracker();

		await runLlmStep({
			step: 'autoChapters',
			llm: stubLlm(),
			prompt: { system: 's', user: 'u' },
			maxTokens: 100,
			settings: mergeSettings({
				llmProvider: LLM_PROVIDER_IDS.GEMINI,
				llmGeminiModel: 'mystery-model',
			}),
			durationSeconds: 600,
			costSink: tracker,
		});

		expect(tracker.totalUsd()).toBe(0);
		expect(tracker.unpricedRuns()).toBe(1);
	});
});

describe('estimateLlmCallCost prices one call, not the whole step', () => {
	it('equals the step cost for the single-call steps', () => {
		// Post-processing and auto chapters each make one call, so a call's cost
		// is the step's cost.
		for (const step of ['postProcess', 'autoChapters'] as const) {
			expect(estimateLlmCallCost(step, settings, 600)).toBe(
				estimateStepCost(step, settings, 600).usd,
			);
		}
	});

	it('bills a context-agent call one member share, below the team line', () => {
		const perCall = defined(
			estimateLlmCallCost('contextAgents', settings, 600),
		);
		const team = defined(
			estimateStepCost('contextAgents', settings, 600).usd,
		);
		// The team is several sequential calls, so one call must cost a fraction
		// of it; charging the team per call is what multiplied the session total.
		expect(perCall).toBeGreaterThan(0);
		expect(perCall).toBeLessThan(team);
	});

	it('records one call as one member share, so N calls sum to N shares', async () => {
		const CALLS = 3;
		const tracker = new SessionCostTracker();
		for (let i = 0; i < CALLS; i++) {
			await runLlmStep({
				step: 'contextAgents',
				llm: stubLlm(),
				prompt: { system: 's', user: 'u' },
				maxTokens: 100,
				settings,
				durationSeconds: 600,
				costSink: tracker,
			});
		}
		const perCall = defined(
			estimateLlmCallCost('contextAgents', settings, 600),
		);
		expect(tracker.totalUsd()).toBeCloseTo(perCall * CALLS, 10);
	});
});
