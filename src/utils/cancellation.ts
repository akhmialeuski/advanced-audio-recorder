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

import { PLUGIN_LOG_PREFIX } from '../constants';

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
 * What work an aborted signal stopped rejects with: the reason the signal
 * was aborted with when that is an Error, which it is whenever the platform
 * filled it in, and otherwise an `AbortError` carrying the reason's words
 * when it was given as text, or a generic one, which is also what a
 * cooperative token with no signal at all gets.
 *
 * One rule for every wait, request and step, so a cancelled pause and a
 * cancelled conversion reject with the same thing. What it is matters less
 * than it seems, though. A cancel reaches a catch in whatever shape the step
 * it interrupted fails with - mediabunny's `ConversionCanceledError`, a
 * worker's error message, this reason - so a caller that has to tell a
 * cancel from a failure asks the token, which is the one answer all of them
 * agree on.
 * @param signal - The aborted signal, or none for a cooperative token
 * @returns The error to reject with
 */
export function cancellationReason(signal: AbortSignal | undefined): Error {
	const reason: unknown = signal?.reason;
	if (reason instanceof Error) {
		return reason;
	}
	return new DOMException(
		typeof reason === 'string' ? reason : 'The job was cancelled.',
		'AbortError',
	);
}

/**
 * Stops a job at a step boundary once its token is cancelled.
 * @param token - The job's cancellation
 * @throws The {@link cancellationReason} when the token is cancelled
 */
export function throwIfCancelled(token: CancellationToken): void {
	if (token.isCancelled()) {
		throw cancellationReason(token.signal);
	}
}

/**
 * Runs a callback when a job is cancelled, for work a step boundary cannot
 * reach: a mediabunny conversion mid-execute, a request in a worker. Runs
 * it at once when the job is already cancelled, since the event has fired.
 *
 * The callback may be asynchronous, as mediabunny's `cancel()` is. Its
 * rejection is logged here rather than left to each caller: a cancel that
 * could not be carried out leaves nothing for the user to act on, and the
 * job ends on the cancel either way.
 * @param token - The job's cancellation
 * @param onCancel - What stops the work in flight
 * @returns Detaches the callback once the work is over
 */
export function onCancelled(
	token: CancellationToken,
	onCancel: () => void | Promise<void>,
): () => void {
	// Called at once, so the work stops in the same turn the cancel came in.
	const run = (): void => {
		Promise.resolve(onCancel()).catch((error: unknown) => {
			console.warn(
				`${PLUGIN_LOG_PREFIX} The cancelled work could not be stopped:`,
				error,
			);
		});
	};
	const { signal } = token;
	if (token.isCancelled()) {
		run();
		return () => undefined;
	}
	if (!signal) {
		return () => undefined;
	}
	signal.addEventListener('abort', run, { once: true });
	return () => {
		signal.removeEventListener('abort', run);
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
