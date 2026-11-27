/**
 * Tests the bounded runner: how many tasks it lets run at once, the order it
 * takes them in, and what one failure does to the rest.
 * @module tests/unit/workerPool.test
 */

import { runBounded } from 'src/utils/workerPool';

/** A task the test finishes by hand, so what runs together can be counted. */
interface Gate {
	readonly started: number[];
	release(index: number): void;
	task(index: number): Promise<void>;
}

/**
 * Tasks that start when the runner calls them and end when released.
 * @returns The gate
 */
function gate(): Gate {
	const started: number[] = [];
	const releases = new Map<number, () => void>();
	return {
		started,
		release: (index) => {
			releases.get(index)?.();
		},
		task: (index) =>
			new Promise<void>((resolve) => {
				started.push(index);
				releases.set(index, resolve);
			}),
	};
}

/** Lets every promise that is ready run. */
async function settle(): Promise<void> {
	for (let turn = 0; turn < 10; turn++) {
		await Promise.resolve();
	}
}

describe('runBounded', () => {
	it('starts no more tasks than the limit until one of them ends', async () => {
		const tasks = gate();
		const run = runBounded(5, 2, tasks.task);
		await settle();

		expect(tasks.started).toEqual([0, 1]);

		tasks.release(0);
		await settle();

		expect(tasks.started).toEqual([0, 1, 2]);

		[1, 2, 3, 4].forEach(tasks.release);
		await settle();
		[3, 4].forEach(tasks.release);
		await run;
	});

	it('runs every task once, in order, when the limit is one', async () => {
		const ran: number[] = [];

		await runBounded(4, 1, (index) => {
			ran.push(index);
			return Promise.resolve();
		});

		expect(ran).toEqual([0, 1, 2, 3]);
	});

	it('runs one at a time when the limit is not a positive number', async () => {
		const tasks = gate();
		const run = runBounded(2, 0, tasks.task);
		await settle();

		expect(tasks.started).toEqual([0]);

		tasks.release(0);
		await settle();
		tasks.release(1);
		await run;
	});

	it('takes no further task once one has failed, and rejects with its error', async () => {
		const ran: number[] = [];

		await expect(
			runBounded(5, 1, (index) => {
				ran.push(index);
				return index === 1
					? Promise.reject(new Error('part failed'))
					: Promise.resolve();
			}),
		).rejects.toThrow('part failed');
		expect(ran).toEqual([0, 1]);
	});

	it('resolves at once when there is nothing to run', async () => {
		const task = jest.fn(() => Promise.resolve());

		await runBounded(0, 4, task);

		expect(task).not.toHaveBeenCalled();
	});
});
