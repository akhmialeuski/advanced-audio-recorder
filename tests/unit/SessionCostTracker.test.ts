/**
 * Tests for the session-wide per-engine cost accumulator.
 */

import { SessionCostTracker } from 'src/transcription/SessionCostTracker';

describe('SessionCostTracker', () => {
	it('starts empty', () => {
		const tracker = new SessionCostTracker();
		expect(tracker.hasEntries()).toBe(false);
		expect(tracker.totalUsd()).toBe(0);
		expect(tracker.engineTotals()).toEqual([]);
		expect(tracker.unpricedRuns()).toBe(0);
	});

	it('accumulates priced runs per engine', () => {
		const tracker = new SessionCostTracker();
		tracker.add('deepgram', 0.04);
		tracker.add('deepgram', 0.01);
		tracker.add('gemini', 0.02);

		expect(tracker.hasEntries()).toBe(true);
		expect(tracker.totalUsd()).toBeCloseTo(0.07, 10);
		expect(tracker.engineTotals()).toEqual([
			{
				engineId: 'deepgram',
				usd: 0.05,
				runs: 2,
				unpricedRuns: 0,
				estimatedRuns: 0,
			},
			{
				engineId: 'gemini',
				usd: 0.02,
				runs: 1,
				unpricedRuns: 0,
				estimatedRuns: 0,
			},
		]);
	});

	it('counts unpriced runs separately instead of adding zero', () => {
		const tracker = new SessionCostTracker();
		tracker.add('deepgram', 0.04);
		tracker.add('deepgram', null);

		const totals = tracker.engineTotals();
		expect(totals[0]?.runs).toBe(1);
		expect(totals[0]?.unpricedRuns).toBe(1);
		expect(tracker.unpricedRuns()).toBe(1);
		expect(tracker.totalUsd()).toBeCloseTo(0.04, 10);
	});

	it('returns copies so callers cannot mutate the totals', () => {
		const tracker = new SessionCostTracker();
		tracker.add('deepgram', 0.04);
		const totals = tracker.engineTotals();
		const first = totals[0];
		if (!first) {
			throw new Error('missing engine total');
		}
		first.usd = 999;
		expect(tracker.totalUsd()).toBeCloseTo(0.04, 10);
	});
});

describe('telling a measured total from an estimated one', () => {
	it('counts the entries whose figure came from an estimate', () => {
		const tracker = new SessionCostTracker();
		tracker.add('gemini', 0.04, false);
		tracker.add('gemini', 0.01, true);
		tracker.add('deepgram', 0.02, true);

		expect(tracker.estimatedRuns()).toBe(2);
		expect(tracker.totalUsd()).toBeCloseTo(0.07, 10);
	});

	it('counts none when every figure came from a vendor', () => {
		const tracker = new SessionCostTracker();
		tracker.add('gemini', 0.04);
		tracker.recordLlmCall('gemini', 'autoChapters', 0.01, false);

		expect(tracker.estimatedRuns()).toBe(0);
	});

	it('leaves an unpriced run out of the estimated count', () => {
		// It is neither measured nor estimated: nothing was recorded for it
		const tracker = new SessionCostTracker();
		tracker.add('gemini', null, true);

		expect(tracker.estimatedRuns()).toBe(0);
		expect(tracker.unpricedRuns()).toBe(1);
	});

	it('carries an estimated LLM call through to the count', () => {
		const tracker = new SessionCostTracker();
		tracker.recordLlmCall('openai', 'postProcess', 0.03, true);

		expect(tracker.estimatedRuns()).toBe(1);
		expect(tracker.totalUsd()).toBeCloseTo(0.03, 10);
	});
});
