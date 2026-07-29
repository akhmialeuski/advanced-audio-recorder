/**
 * Session-scoped accumulator of paid API spending, kept per provider. One
 * tracker lives on the plugin for the whole Obsidian session; the transcribe
 * dialog shows the running total so paid usage is never invisible. Work whose
 * cost could not be priced (an unknown model, no usage reported) is counted
 * separately rather than silently added as zero.
 *
 * It covers both kinds of provider. A transcription run reports its actual
 * (or, failing that, estimated) cost; an LLM call reports an estimate, because
 * no LLM vendor returns usage through the endpoints this plugin calls. The
 * counter used to track only the transcription engine, which left the two-pass
 * context agents, the post-processing pass, and auto chapters spending money
 * that never appeared anywhere after the pre-run estimate.
 * @module transcription/SessionCostTracker
 */

import type { RunCostStepId } from './costs';

/** Accumulated spending for one provider in this session. */
export interface SessionEngineCost {
	/** Transcription engine or LLM vendor id. */
	engineId: string;
	/** Total priced spending in USD. */
	usd: number;
	/** Number of priced runs. */
	runs: number;
	/** Number of runs whose cost could not be priced. */
	unpricedRuns: number;
}

/**
 * Accumulates per-provider costs for the current session.
 */
export class SessionCostTracker {
	private readonly totals = new Map<string, SessionEngineCost>();

	/**
	 * Records one completed transcription run. A null cost counts the run as
	 * unpriced so the totals stay honest about what they cover.
	 * @param engineId - Engine that ran
	 * @param usd - Cost in USD, or null when it could not be priced
	 */
	add(engineId: string, usd: number | null): void {
		const entry = this.totals.get(engineId) ?? {
			engineId,
			usd: 0,
			runs: 0,
			unpricedRuns: 0,
		};
		if (usd === null) {
			entry.unpricedRuns++;
		} else {
			entry.usd += usd;
			entry.runs++;
		}
		this.totals.set(engineId, entry);
	}

	/**
	 * Records one completed LLM call, satisfying {@link LlmCostSink} so every
	 * accounted step reaches the same total as the transcription runs.
	 * @param providerId - LLM vendor billed for the call
	 * @param _step - Which billable step made it (kept for future breakdowns)
	 * @param usd - Estimated cost, or null when the model has no built-in rate
	 */
	recordLlmCall(
		providerId: string,
		_step: RunCostStepId,
		usd: number | null,
	): void {
		this.add(providerId, usd);
	}

	/** Per-provider totals, in first-use order. */
	engineTotals(): SessionEngineCost[] {
		return [...this.totals.values()].map((entry) => ({ ...entry }));
	}

	/** Total priced spending across all engines, in USD. */
	totalUsd(): number {
		let total = 0;
		for (const entry of this.totals.values()) {
			total += entry.usd;
		}
		return total;
	}

	/** Whether any run has been recorded this session. */
	hasEntries(): boolean {
		return this.totals.size > 0;
	}

	/** Number of runs across all engines that could not be priced. */
	unpricedRuns(): number {
		let count = 0;
		for (const entry of this.totals.values()) {
			count += entry.unpricedRuns;
		}
		return count;
	}
}
