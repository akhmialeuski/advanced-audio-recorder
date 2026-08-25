/**
 * Tests for the shared cancellation primitives: the token every long job
 * carries, the never-cancelled token, and the source a dialog owns.
 *
 * The point of the source is that one object answers both questions a job
 * asks - "was I cancelled?" between steps, and "abort this request now" while
 * one is in flight - so the two can never disagree the way a separate boolean
 * flag and AbortController could.
 * @module tests/unit/cancellation.test
 */

import { CancellationSource, NEVER_CANCELLED } from 'src/utils/cancellation';

describe('NEVER_CANCELLED', () => {
	it('never reports a cancellation', () => {
		expect(NEVER_CANCELLED.isCancelled()).toBe(false);
	});

	// A job that only aborts requests must still run when nobody can cancel it.
	it('carries no signal at all', () => {
		expect(NEVER_CANCELLED.signal).toBeUndefined();
	});
});

describe('CancellationSource', () => {
	it('starts uncancelled with an unaborted signal', () => {
		const source = new CancellationSource();

		expect(source.isCancelled()).toBe(false);
		expect(source.token.isCancelled()).toBe(false);
		expect(source.token.signal?.aborted).toBe(false);
	});

	it('reports the cancellation through the token and the signal alike', () => {
		const source = new CancellationSource();

		source.cancel();

		expect(source.isCancelled()).toBe(true);
		expect(source.token.isCancelled()).toBe(true);
		expect(source.token.signal?.aborted).toBe(true);
	});

	// The reason travels to whatever was waiting on the signal, which is what
	// lets a paused retry reject with the cancel rather than a bare abort.
	it('hands the given reason to the signal', () => {
		const source = new CancellationSource();
		const reason = new Error('the user pressed Cancel');

		source.cancel(reason);

		expect(source.token.signal?.reason).toBe(reason);
	});

	// Cancel is wired to a button, and a second press must not throw.
	it('stays cancelled when cancelled twice', () => {
		const source = new CancellationSource();
		const first = new Error('first');

		source.cancel(first);
		source.cancel(new Error('second'));

		expect(source.token.signal?.reason).toBe(first);
		expect(source.isCancelled()).toBe(true);
	});

	it('gives every source its own signal', () => {
		const one = new CancellationSource();
		const other = new CancellationSource();

		one.cancel();

		expect(other.isCancelled()).toBe(false);
	});
});
