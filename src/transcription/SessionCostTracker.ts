/**
 * Session-scoped accumulator of paid API spending, kept per provider. One
 * tracker lives on the plugin for the whole Obsidian session; the transcribe
 * dialog shows the running total so paid usage is never invisible. Work whose
 * cost could not be priced (an unknown model, no usage reported) is counted
 * separately rather than silently added as zero.
 *
 * It covers both kinds of provider, and both report their actual cost where
 * the vendor gave one: a transcription run from the usage it reports, an LLM
 * call from the token counts in the same body its text came from. Either falls
 * back to an estimate when the vendor reported nothing, and how many entries
 * were priced that way is counted, so the total can say what it is made of
 * instead of presenting a guess as a measurement. The counter used to track
 * only the transcription engine, which left the two-pass context agents, the
 * post-processing pass, and auto chapters spending money that never appeared
 * anywhere after the pre-run estimate.
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
	/**
	 * Number of priced runs whose figure came from an estimate rather than
	 * from what the vendor reported.
	 */
	estimatedRuns: number;
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
	 * @param estimated - True when the figure came from an estimate rather
	 *   than from what the vendor reported. Defaulted, so a caller that has
	 *   only ever recorded actuals stays as it is.
	 */
	add(engineId: string, usd: number | null, estimated = false): void {
		const entry = this.totals.get(engineId) ?? {
			engineId,
			usd: 0,
			runs: 0,
			unpricedRuns: 0,
			estimatedRuns: 0,
		};
		if (usd === null) {
			entry.unpricedRuns++;
		} else {
			entry.usd += usd;
			entry.runs++;
			if (estimated) {
				entry.estimatedRuns++;
			}
		}
		this.totals.set(engineId, entry);
	}

	/**
	 * Records one completed LLM call, satisfying {@link LlmCostSink} so every
	 * accounted step reaches the same total as the transcription runs.
	 * @param providerId - LLM vendor billed for the call
	 * @param _step - Which billable step made it (kept for future breakdowns)
	 * @param usd - Cost in USD, or null when it could not be priced
	 * @param estimated - True when the figure came from the step model rather
	 *   than from token counts the vendor reported
	 */
	recordLlmCall(
		providerId: string,
		_step: RunCostStepId,
		usd: number | null,
		estimated: boolean,
	): void {
		this.add(providerId, usd, estimated);
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

	/**
	 * Number of priced runs across all engines whose figure is an estimate.
	 * Zero means every dollar in the total was reported by a vendor.
	 */
	estimatedRuns(): number {
		let count = 0;
		for (const entry of this.totals.values()) {
			count += entry.estimatedRuns;
		}
		return count;
	}
}
