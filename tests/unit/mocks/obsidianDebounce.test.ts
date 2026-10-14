/**
 * Contract tests for the debounce double in the obsidian mock.
 *
 * The plugin relies on both of Obsidian's timings: a marker rename waits for
 * the typing to stop (resetTimer on), while the transcription queue writes
 * half a second after the first change of a burst however long the burst runs
 * (resetTimer off). A double that only knew one of them would let either
 * caller pass with the wrong one, so both are pinned down here, along with
 * cancel() and run().
 * @module tests/unit/mocks/obsidianDebounce.test
 */

import { debounce } from 'obsidian';

const WINDOW_MS = 500;

/**
 * A debounced spy, with fake timers installed for the test.
 * @param resetTimer - Obsidian's third argument, or undefined to leave it out
 * @returns The debouncer and the callback behind it
 */
function createSut(resetTimer?: boolean): {
	debounced: ReturnType<typeof debounce<[string], string>>;
	callback: jest.Mock<string, [string]>;
} {
	jest.useFakeTimers();
	const callback = jest.fn((value: string) => `ran ${value}`);
	return { debounced: debounce(callback, WINDOW_MS, resetTimer), callback };
}

afterEach(() => {
	jest.useRealTimers();
});

describe('debounce with resetTimer', () => {
	it('waits out the window again after every call', () => {
		const { debounced, callback } = createSut(true);

		debounced('a');
		jest.advanceTimersByTime(300);
		debounced('b');
		jest.advanceTimersByTime(300);

		expect(callback).not.toHaveBeenCalled();
	});

	it('runs once the calls stop, with the latest arguments', () => {
		const { debounced, callback } = createSut(true);

		debounced('a');
		jest.advanceTimersByTime(300);
		debounced('b');
		jest.advanceTimersByTime(WINDOW_MS);

		expect(callback).toHaveBeenCalledTimes(1);
		expect(callback).toHaveBeenCalledWith('b');
	});
});

describe('debounce without resetTimer', () => {
	it('runs one window after the first call of a burst', () => {
		const { debounced, callback } = createSut(false);

		debounced('a');
		jest.advanceTimersByTime(300);
		debounced('b');
		jest.advanceTimersByTime(200);

		expect(callback).toHaveBeenCalledTimes(1);
		expect(callback).toHaveBeenCalledWith('b');
	});

	it('is what leaving the argument out means', () => {
		const { debounced, callback } = createSut();

		debounced('a');
		jest.advanceTimersByTime(300);
		debounced('b');
		jest.advanceTimersByTime(200);

		expect(callback).toHaveBeenCalledWith('b');
	});

	it('starts a new window for a call after the last one ran', () => {
		const { debounced, callback } = createSut(false);
		debounced('a');
		jest.advanceTimersByTime(WINDOW_MS);

		debounced('b');
		jest.advanceTimersByTime(WINDOW_MS - 1);

		expect(callback).toHaveBeenCalledTimes(1);
	});
});

describe('debounce cancel and run', () => {
	it('drops a pending call on cancel', () => {
		const { debounced, callback } = createSut(true);
		debounced('a');

		debounced.cancel();
		jest.advanceTimersByTime(WINDOW_MS);

		expect(callback).not.toHaveBeenCalled();
	});

	it('runs a pending call at once on run, and returns what it returned', () => {
		const { debounced, callback } = createSut(false);
		debounced('a');

		expect(debounced.run()).toBe('ran a');
		expect(callback).toHaveBeenCalledTimes(1);
	});

	it('does not run the call a second time once its window passes', () => {
		const { debounced, callback } = createSut(false);
		debounced('a');
		debounced.run();

		jest.advanceTimersByTime(WINDOW_MS);

		expect(callback).toHaveBeenCalledTimes(1);
	});

	it('runs nothing on run when nothing is pending', () => {
		const { debounced, callback } = createSut(false);

		expect(debounced.run()).toBeUndefined();
		expect(callback).not.toHaveBeenCalled();
	});

	// Obsidian's typings return the debouncer from both, so a call can be
	// chained into a cancel or a run.
	it('hands the debouncer back from a call and from cancel', () => {
		const { debounced } = createSut(false);

		expect(debounced('a')).toBe(debounced);
		expect(debounced.cancel()).toBe(debounced);
	});
});
