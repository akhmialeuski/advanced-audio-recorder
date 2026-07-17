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
			{ engineId: 'deepgram', usd: 0.05, runs: 2, unpricedRuns: 0 },
			{ engineId: 'gemini', usd: 0.02, runs: 1, unpricedRuns: 0 },
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
