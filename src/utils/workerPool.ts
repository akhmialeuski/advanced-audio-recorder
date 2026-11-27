/**
 * Runs numbered tasks a few at a time.
 * @module utils/workerPool
 */

/**
 * Runs `task` for every index below `count`, at most `limit` of them at once,
 * taking the indexes in order. The first task to throw ends the run: tasks
 * already started run to their end, no further index is taken, and the error
 * is the one the returned promise rejects with.
 * @param count - How many tasks there are
 * @param limit - How many may run at the same time, at least one
 * @param task - Runs the task with the given index
 */
export async function runBounded(
	count: number,
	limit: number,
	task: (index: number) => Promise<void>,
): Promise<void> {
	let next = 0;
	let stopped = false;
	const worker = async (): Promise<void> => {
		while (!stopped && next < count) {
			const index = next++;
			try {
				await task(index);
			} catch (error) {
				stopped = true;
				throw error;
			}
		}
	};
	await Promise.all(
		Array.from({ length: Math.min(count, Math.max(1, limit)) }, worker),
	);
}
