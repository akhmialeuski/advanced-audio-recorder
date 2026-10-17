/**
 * Cancellation for the long jobs the plugin runs: transcription, the LLM
 * steps around it, chapter generation, and converting and splitting audio.
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
 * What a cancelled job's in-flight work rejects with: the reason its source
 * was cancelled with, or the platform's `AbortError` for a token that
 * carries no signal.
 *
 * What it is matters less than it seems. A cancel reaches a catch in
 * whatever shape the step it interrupted fails with - mediabunny's
 * `ConversionCanceledError`, a worker's error message, this reason - so a
 * caller that has to tell a cancel from a failure asks the token, which is
 * the one answer all of them agree on.
 * @param token - A cancelled job's cancellation
 * @returns The error to reject with
 */
export function cancellationReason(token: CancellationToken): Error {
	const reason: unknown = token.signal?.reason;
	return reason instanceof Error
		? reason
		: new DOMException('The job was cancelled.', 'AbortError');
}

/**
 * Stops a job at a step boundary once its token is cancelled.
 * @param token - The job's cancellation
 * @throws The {@link cancellationReason} when the token is cancelled
 */
export function throwIfCancelled(token: CancellationToken): void {
	if (token.isCancelled()) {
		throw cancellationReason(token);
	}
}

/**
 * Runs a callback when a job is cancelled, for work a step boundary cannot
 * reach: a mediabunny conversion mid-execute, a request in a worker. Runs
 * it at once when the job is already cancelled, since the event has fired.
 * @param token - The job's cancellation
 * @param onCancel - What stops the work in flight
 * @returns Detaches the callback once the work is over
 */
export function onCancelled(
	token: CancellationToken,
	onCancel: () => void,
): () => void {
	const { signal } = token;
	if (token.isCancelled()) {
		onCancel();
		return () => undefined;
	}
	if (!signal) {
		return () => undefined;
	}
	signal.addEventListener('abort', onCancel, { once: true });
	return () => {
		signal.removeEventListener('abort', onCancel);
	};
}

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

	/**
	 * Cancels the job. Safe to call more than once, because the button that
	 * calls it can be pressed again before the job notices; the first reason is
	 * the one that stands.
	 *
	 * An Error, or nothing at all - in which case the platform fills in its
	 * own `AbortError`. Everything the run has in flight rejects with this
	 * reason, and a rejection carries an Error here by rule.
	 * @param reason - What to reject in-flight work with
	 */
	cancel(reason?: Error): void {
		this.controller.abort(reason);
	}
}
