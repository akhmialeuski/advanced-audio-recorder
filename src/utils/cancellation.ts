/**
 * Cancellation for the long jobs the plugin runs: transcription, the LLM
 * steps around it, and chapter generation.
 *
 * A job needs two things from a cancel, and used to get them from two objects.
 * Between steps it asks a boolean whether to stop, and while a request is in
 * flight it needs an AbortSignal the transport can act on. Keeping those as a
 * flag and a controller side by side meant every dialog wired them together by
 * hand, and a path that set one without the other looked cancelled from one
 * side and running from the other. Here the flag IS the signal's state, so the
 * two cannot disagree.
 * @module utils/cancellation
 */

/** Cooperative cancellation signal a long job carries through its steps. */
export interface CancellationToken {
	/** Whether the job has been cancelled, checked between steps. */
	isCancelled(): boolean;
	/**
	 * Optional abort signal that fires when the job is cancelled, so an
	 * in-flight HTTP request or a pause between attempts ends at once instead
	 * of only being noticed at the next step boundary. Optional because a
	 * caller may cancel cooperatively without owning a controller (the tests
	 * do exactly that).
	 */
	signal?: AbortSignal;
}

/** A token that is never cancelled. */
export const NEVER_CANCELLED: CancellationToken = {
	isCancelled: () => false,
};

/**
 * Owns one job's cancellation and hands out its token.
 *
 * A dialog builds one per run and calls {@link CancellationSource.cancel} from
 * its Cancel button. Everything the run touches reads the token.
 */
export class CancellationSource {
	private readonly controller = new AbortController();

	/** The token to hand to the job this source governs. */
	readonly token: CancellationToken = {
		isCancelled: () => this.controller.signal.aborted,
		signal: this.controller.signal,
	};

	/** Whether this source has been cancelled. */
	isCancelled(): boolean {
		return this.controller.signal.aborted;
	}

	/**
	 * Cancels the job. Safe to call more than once, because the button that
	 * calls it can be pressed again before the job notices; the first reason is
	 * the one that stands.
	 * @param reason - What to reject in-flight work with
	 */
	cancel(reason?: unknown): void {
		this.controller.abort(reason);
	}
}
