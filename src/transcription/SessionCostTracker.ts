/**
 * Session-scoped accumulator of transcription spending, kept per engine.
 * One tracker lives on the plugin for the whole Obsidian session; every
 * completed cloud transcription reports its (actual or estimated) cost
 * here, and the transcribe dialog shows the running totals so paid API
 * usage is never invisible. Runs whose cost could not be priced (an
 * unknown model, no usage reported) are counted separately rather than
 * silently added as zero.
 * @module transcription/SessionCostTracker
 */

/** Accumulated spending for one engine in this session. */
export interface SessionEngineCost {
	/** Transcription engine id. */
	engineId: string;
	/** Total priced spending in USD. */
	usd: number;
	/** Number of priced runs. */
	runs: number;
	/** Number of runs whose cost could not be priced. */
	unpricedRuns: number;
}

/**
 * Accumulates per-engine transcription costs for the current session.
 */
export class SessionCostTracker {
	private readonly totals = new Map<string, SessionEngineCost>();

	/**
	 * Records one completed run. A null cost counts the run as unpriced so
	 * the totals stay honest about what they cover.
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

	/** Per-engine totals, in first-use order. */
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
