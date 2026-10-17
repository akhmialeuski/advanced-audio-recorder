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

import {
	CancellationSource,
	NEVER_CANCELLED,
	cancellationReason,
	onCancelled,
	throwIfCancelled,
	type CancellationToken,
} from 'src/utils/cancellation';

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

		expect(source.token.isCancelled()).toBe(false);
		expect(source.token.isCancelled()).toBe(false);
		expect(source.token.signal?.aborted).toBe(false);
	});

	it('reports the cancellation through the token and the signal alike', () => {
		const source = new CancellationSource();

		source.cancel();

		expect(source.token.isCancelled()).toBe(true);
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
		expect(source.token.isCancelled()).toBe(true);
	});

	it('gives every source its own signal', () => {
		const one = new CancellationSource();
		const other = new CancellationSource();

		one.cancel();

		expect(other.token.isCancelled()).toBe(false);
	});
});

describe('stopping a job at a step boundary', () => {
	it('lets an uncancelled job go on', () => {
		expect(() => {
			throwIfCancelled(new CancellationSource().token);
		}).not.toThrow();
	});

	it('throws the reason the source was cancelled with', () => {
		const source = new CancellationSource();
		const reason = new Error('closed the dialog');
		source.cancel(reason);

		expect(() => {
			throwIfCancelled(source.token);
		}).toThrow(reason);
	});

	// A test may cancel cooperatively, with no controller behind the token.
	it('throws an AbortError for a token that carries no signal', () => {
		const token: CancellationToken = { isCancelled: () => true };

		expect(cancellationReason(token.signal)).toMatchObject({
			name: 'AbortError',
		});
		expect(() => {
			throwIfCancelled(token);
		}).toThrow('The job was cancelled.');
	});

	// A canceller may name its reason with words rather than an Error. The
	// rejection is an Error by rule, and an AbortError like the platform's
	// own, so every step a cancel stops rejects with one shape: a wait in
	// delay() and a conversion step share this rule.
	it('keeps the words of a reason that is not an Error, as an AbortError', () => {
		const controller = new AbortController();
		controller.abort('pulled the plug');

		expect(cancellationReason(controller.signal)).toMatchObject({
			name: 'AbortError',
			message: 'pulled the plug',
		});
	});
});

describe('reaching work a step boundary cannot', () => {
	it('runs the callback when the job is cancelled, once', () => {
		const source = new CancellationSource();
		const stop = jest.fn();
		onCancelled(source.token, stop);

		source.cancel();
		source.cancel();

		expect(stop).toHaveBeenCalledTimes(1);
	});

	// The event has already fired, so waiting for it would wait forever.
	it('runs it at once for a job already cancelled', () => {
		const source = new CancellationSource();
		source.cancel();
		const stop = jest.fn();

		onCancelled(source.token, stop);

		expect(stop).toHaveBeenCalledTimes(1);
	});

	// mediabunny's cancel() is asynchronous and can fail. Nothing is left
	// for the user to do about it, but an unhandled rejection would surface
	// far from the cancel, so the one place every caller goes through logs it.
	it('logs a cancel that rejects instead of leaving it unhandled', async () => {
		const warn = jest.spyOn(console, 'warn').mockImplementation();
		const source = new CancellationSource();
		onCancelled(source.token, () => Promise.reject(new Error('busy')));

		source.cancel();
		await Promise.resolve();
		await Promise.resolve();

		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining('could not be stopped'),
			expect.objectContaining({ message: 'busy' }),
		);
	});

	it('runs nothing once the work it guarded is over', () => {
		const source = new CancellationSource();
		const stop = jest.fn();
		const detach = onCancelled(source.token, stop);

		detach();
		source.cancel();

		expect(stop).not.toHaveBeenCalled();
	});
});

describe('a token that cannot be listened to', () => {
	// A cooperative token has no signal to fire, so only a step boundary
	// can see its cancel.
	it('runs nothing and detaches nothing for a token with no signal', () => {
		const stop = jest.fn();
		const detach = onCancelled({ isCancelled: () => false }, stop);

		detach();

		expect(stop).not.toHaveBeenCalled();
	});

	it('runs the callback at once for a cancelled token with no signal', () => {
		const stop = jest.fn();
		const detach = onCancelled({ isCancelled: () => true }, stop);

		detach();

		expect(stop).toHaveBeenCalledTimes(1);
	});
});
