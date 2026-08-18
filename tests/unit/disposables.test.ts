/**
 * The `using` adapters for platform resources that have no dispose of their own.
 *
 * They exist so a release cannot be forgotten on a throw path, which makes the
 * uninteresting-looking branch - a context that is already closed - the one
 * that matters: closing one twice throws, and that throw would surface from a
 * block that had otherwise succeeded.
 * @module tests/unit/disposables.test
 */

import { autoClosing, disposableOf } from 'src/utils/disposables';

describe('disposableOf', () => {
	it('releases the resource when the block exits', () => {
		const dispose = jest.fn();

		{
			using _resource = disposableOf({ dispose });
			expect(dispose).not.toHaveBeenCalled();
		}

		expect(dispose).toHaveBeenCalledTimes(1);
	});

	it('releases it on the way out of a throw', () => {
		const dispose = jest.fn();

		expect(() => {
			using _resource = disposableOf({ dispose });
			throw new Error('mid-block failure');
		}).toThrow('mid-block failure');
		expect(dispose).toHaveBeenCalledTimes(1);
	});

	it('hands back the same object, so the block still uses it', () => {
		const resource = { dispose: jest.fn(), read: (): string => 'data' };

		expect(disposableOf(resource).read()).toBe('data');
	});
});

describe('autoClosing', () => {
	/** An AudioContext-like resource that tracks its own state. */
	function fakeContext(state: AudioContextState = 'running'): {
		state: AudioContextState;
		close: jest.Mock;
	} {
		const context = {
			state,
			close: jest.fn(async () => {
				context.state = 'closed';
				return Promise.resolve();
			}),
		};
		return context;
	}

	it('closes the context when the block exits', async () => {
		const context = fakeContext();

		{
			await using _managed = autoClosing(context);
		}

		expect(context.close).toHaveBeenCalledTimes(1);
	});

	it('closes it on the way out of a throw', async () => {
		const context = fakeContext();

		await expect(
			(async (): Promise<void> => {
				await using _managed = autoClosing(context);
				throw new Error('decode failed');
			})(),
		).rejects.toThrow('decode failed');
		expect(context.close).toHaveBeenCalledTimes(1);
	});

	it('leaves an already-closed context alone', async () => {
		// Closing an AudioContext twice throws, and that throw would surface
		// from a block that had otherwise succeeded.
		const context = fakeContext('closed');

		{
			await using _managed = autoClosing(context);
		}

		expect(context.close).not.toHaveBeenCalled();
	});

	it('closes it only once when the block closed it already', async () => {
		const context = fakeContext();

		{
			await using managed = autoClosing(context);
			await managed.close();
		}

		expect(context.close).toHaveBeenCalledTimes(1);
	});
});
