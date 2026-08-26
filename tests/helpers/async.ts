/**
 * Waiting primitives shared by the whole suite.
 *
 * Nine files had grown their own `flush`, `tick`, `flushAsync`, or
 * `flushMicrotasks`, and two dozen more inlined
 * `await new Promise((resolve) => setTimeout(resolve, 0))`. They all mean the
 * same thing - let whatever the code just started actually run - so they belong
 * in one place with one name.
 *
 * Prefer {@link waitFor} over a fixed sleep whenever there is something to
 * assert on: a fixed sleep is a guess that passes on a fast machine and fails
 * on a loaded one, while a poll finishes as soon as the condition holds.
 * @module tests/helpers/async
 */

/** Options for {@link waitFor}. */
export interface WaitForOptions {
	/** Give up after this many milliseconds. */
	timeout?: number;
	/** Delay between polls. */
	interval?: number;
	/** What the caller was waiting for, used in the timeout message. */
	message?: string;
}

/**
 * Yields one macrotask turn, letting already-resolved promise chains run.
 * @returns A promise that resolves on the next timer turn
 */
export const tick = (): Promise<void> =>
	new Promise((resolve) => {
		setTimeout(resolve, 0);
	});

/**
 * Yields several macrotask turns in a row, for a chain that resumes a few
 * awaits deep.
 * @param turns - How many turns to yield
 */
export const tickTimes = async (turns: number): Promise<void> => {
	for (let i = 0; i < turns; i++) {
		await tick();
	}
};

/**
 * Drains the microtask queue without yielding a macrotask turn, for a
 * fire-and-forget promise chain that never touches a timer.
 * @param turns - How many microtask turns to drain
 */
export const flushMicrotasks = async (turns = 5): Promise<void> => {
	for (let i = 0; i < turns; i++) {
		await Promise.resolve();
	}
};

/** How a watched promise ended: with a value, or with what it threw. */
export type Outcome<T> = { value: T } | { error: unknown };

/**
 * Captures how a promise ends without leaving its rejection unhandled.
 *
 * Work driven by fake timers settles inside `advanceTimersByTimeAsync`, and a
 * handler attached after that call arrives too late: the rejection is already
 * loose and jest reports it against whichever test was running. Attaching one
 * up front and reporting the outcome as a value lets the assertion come
 * afterwards, in the order a test reads best.
 * @param work - The promise to watch
 * @returns Its value, or the error it threw
 */
export function outcomeOf<T>(work: Promise<T>): Promise<Outcome<T>> {
	return work.then(
		(value) => ({ value }),
		(error: unknown) => ({ error }),
	);
}

/**
 * Polls until the condition holds, then returns. Throws a readable error if it
 * never does, so a hung expectation names what it was waiting for instead of
 * failing later on an unrelated assertion.
 * @param condition - Checked on every poll; truthy ends the wait
 * @param options - Timeout, poll interval, and the message on failure
 */
export async function waitFor(
	condition: () => boolean | Promise<boolean>,
	options: WaitForOptions = {},
): Promise<void> {
	const { timeout = 1000, interval = 5, message } = options;
	const deadline = Date.now() + timeout;
	for (;;) {
		if (await condition()) {
			return;
		}
		if (Date.now() >= deadline) {
			throw new Error(
				`waitFor timed out after ${String(timeout)}ms: ${message ?? 'condition never became true'}`,
			);
		}
		await new Promise((resolve) => {
			setTimeout(resolve, interval);
		});
	}
}

/**
 * Advances past a debounce window and drains what it scheduled.
 *
 * A debounced callback needs both halves: the clock moved past the window and
 * the microtasks its body queues drained. Fake timers move the clock; only
 * awaiting the timer API drains the rest.
 * @param windowMs - The debounce window to clear
 */
export const pastDebounce = (windowMs: number): Promise<void> =>
	jest.advanceTimersByTimeAsync(windowMs * 2);
