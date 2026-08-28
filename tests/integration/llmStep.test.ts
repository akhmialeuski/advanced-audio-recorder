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
import { billed, completed } from '../helpers/llmDoubles';
import type { LlmUsage } from 'src/transcription/llm/llmResponse';

/**
 * A provider that returns fixed text and records how it was called.
 * @param text - What the provider answers with
 * @param fail - Rejects the call with this instead of answering
 * @param usage - Token counts to report, as a vendor that reports them does
 * @returns The provider double and the calls it recorded
 */
function stubLlm(
	text = 'answer',
	fail?: Error,
	usage?: LlmUsage,
): LlmProvider & { calls: unknown[][] } {
	const calls: unknown[][] = [];
	return {
		id: LLM_PROVIDER_IDS.GEMINI,
		label: 'Google Gemini',
		calls,
		complete: (prompt, maxTokens, options) => {
			calls.push([prompt, maxTokens, options]);
			return fail
				? Promise.reject(fail)
				: Promise.resolve(
						usage ? billed(text, usage) : completed(text),
					);
		},
	};
}

/** A sink that records every reported call. */
function stubSink(): LlmCostSink & {
	records: [string, RunCostStepId, number | null, boolean][];
} {
	const records: [string, RunCostStepId, number | null, boolean][] = [];
	return {
		records,
		recordLlmCall: (providerId, step, usd, estimated) => {
			records.push([providerId, step, usd, estimated]);
		},
	};
}

const settings = mergeSettings({
	llmProvider: LLM_PROVIDER_IDS.GEMINI,
	llmGeminiModel: 'gemini-2.5-flash',
	llmMaxTokens: 32000,
});

/**
 * The same run against a model with a known rate. The Gemini vendor reads
 * `geminiModel`, which is the key the accounting prices from, so a case about
 * what a call was billed has to set that one.
 */
const pricedSettings = mergeSettings({
	...settings,
	geminiModel: 'gemini-2.5-flash',
});

/**
 * One chapter step, which is the call every accounting case makes. Named
 * once so a case says only what it varies: the provider and where the cost
 * is reported.
 * @param llm - The provider to call
 * @param costSink - Where the cost is reported
 * @param stepSettings - The run's settings; the unpriced default by default
 * @returns The step's text
 */
function chapterStep(
	llm: LlmProvider,
	costSink: LlmCostSink,
	stepSettings = settings,
): Promise<string> {
	return runLlmStep({
		step: 'autoChapters',
		llm,
		prompt: { system: 's', user: 'u' },
		maxTokens: 100,
		settings: stepSettings,
		durationSeconds: 600,
		costSink,
	});
}

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

	// Cancellation used to reach the transcription request and nothing else,
	// so pressing Cancel during post-processing, the context agents, or
	// chapter generation stopped nothing and the run was billed in full. The
	// signal is carried on the request itself rather than inside `options`, so
	// no caller can forget to assemble the options object.
	it('carries the signal into the provider call', async () => {
		const llm = stubLlm();
		const controller = new AbortController();

		await runLlmStep({
			step: 'postProcess',
			llm,
			prompt: { system: 's', user: 'u' },
			maxTokens: 100,
			settings,
			durationSeconds: 60,
			signal: controller.signal,
		});

		expect(at(at(llm.calls, 0), 2)).toEqual({
			signal: controller.signal,
		});
	});

	it("keeps the caller's own options alongside the signal", async () => {
		const llm = stubLlm();
		const controller = new AbortController();

		await runLlmStep({
			step: 'contextAgents',
			llm,
			prompt: { system: 's', user: 'u' },
			maxTokens: 100,
			settings,
			durationSeconds: 60,
			options: { temperature: 0 },
			signal: controller.signal,
		});

		expect(at(at(llm.calls, 0), 2)).toEqual({
			temperature: 0,
			signal: controller.signal,
		});
	});

	it('leaves options untouched when there is nothing to cancel with', async () => {
		const llm = stubLlm();

		await runLlmStep({
			step: 'contextAgents',
			llm,
			prompt: { system: 's', user: 'u' },
			maxTokens: 100,
			settings,
			durationSeconds: 60,
			options: { temperature: 0 },
		});

		expect(at(at(llm.calls, 0), 2)).toEqual({ temperature: 0 });
	});

	// A run cancelled between two agent calls must not pay for the next one.
	it('refuses to spend on a call the user already cancelled', async () => {
		const llm = stubLlm();
		const sink = stubSink();
		const controller = new AbortController();
		controller.abort(new Error('cancelled'));

		await expect(
			runLlmStep({
				step: 'contextAgents',
				llm,
				prompt: { system: 's', user: 'u' },
				maxTokens: 100,
				settings,
				durationSeconds: 60,
				costSink: sink,
				signal: controller.signal,
			}),
		).rejects.toThrow('cancelled');
		expect(llm.calls).toHaveLength(0);
		expect(sink.records).toHaveLength(0);
	});

	// A cancelled call was never answered, so it is not spending the session
	// counter should show.
	it('accounts nothing for a call the provider aborted', async () => {
		const llm = stubLlm('unused', new Error('The user aborted a request.'));
		const sink = stubSink();

		await expect(
			runLlmStep({
				step: 'postProcess',
				llm,
				prompt: { system: 's', user: 'u' },
				maxTokens: 100,
				settings,
				durationSeconds: 60,
				costSink: sink,
			}),
		).rejects.toThrow('aborted');
		expect(sink.records).toHaveLength(0);
	});

	it('falls back to the step model when the vendor reported nothing', async () => {
		const sink = stubSink();

		await chapterStep(stubLlm(), sink);

		// The same figure the pre-run breakdown shows for this step, so the
		// estimate the user saw is the one that lands in the total, and it is
		// marked as an estimate rather than passed off as a measurement.
		const expected = estimateStepCost('autoChapters', settings, 600).usd;
		expect(at(sink.records, 0)).toEqual([
			LLM_PROVIDER_IDS.GEMINI,
			'autoChapters',
			expected,
			true,
		]);
	});

	it('bills what the vendor reported, not what the step model expected', async () => {
		const sink = stubSink();

		// gemini-2.5-flash is $0.30 per million in, $2.50 per million out
		await chapterStep(
			stubLlm('answer', undefined, {
				inputTokens: 1_000_000,
				outputTokens: 1_000_000,
			}),
			sink,
			pricedSettings,
		);

		// The vendor's own counts, and not marked as an estimate: this is what
		// the call cost, not what it was expected to cost
		expect(at(sink.records, 0)).toEqual([
			LLM_PROVIDER_IDS.GEMINI,
			'autoChapters',
			2.8,
			false,
		]);
	});

	it('bills the reasoning tokens a model reports at the output rate', async () => {
		const sink = stubSink();

		await chapterStep(
			stubLlm('answer', undefined, {
				inputTokens: 0,
				outputTokens: 0,
				reasoningTokens: 1_000_000,
			}),
			sink,
			pricedSettings,
		);

		expect(at(sink.records, 0)[2]).toBeCloseTo(2.5, 10);
	});

	it('falls back to the estimate for a model with no built-in rate', async () => {
		const sink = stubSink();

		await chapterStep(
			stubLlm('answer', undefined, { inputTokens: 1000 }),
			sink,
			mergeSettings({
				llmProvider: LLM_PROVIDER_IDS.GEMINI,
				geminiModel: 'gemini-from-the-future',
			}),
		);

		// Counts the pricing cannot use are the same case as no counts at all
		expect(at(sink.records, 0)[3]).toBe(true);
	});

	it('prices nothing when no one is accounting the call', async () => {
		const llm = stubLlm('answer', undefined, { inputTokens: 1000 });

		const text = await runLlmStep({
			step: 'autoChapters',
			llm,
			prompt: { system: 's', user: 'u' },
			maxTokens: 100,
			settings,
			durationSeconds: 600,
		});

		expect(text).toBe('answer');
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

		await chapterStep(stubLlm(), tracker);

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
			// An id with no built-in rate, set the way a user sets one: the
			// legacy field it used to be written through is only offered to
			// the catalogue now, never selected on an engine that transcribes.
			settings: mergeSettings({
				llmProvider: LLM_PROVIDER_IDS.GEMINI,
				chaptersLlmProvider: LLM_PROVIDER_IDS.GEMINI,
				geminiModel: 'mystery-model',
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
