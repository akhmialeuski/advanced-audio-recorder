/**
 * Default double for `src/recording/InputLevelMonitor`.
 *
 * The real monitor taps a MediaStream through an AnalyserNode, which jsdom
 * does not have: its `start` catches that failure and every reading comes
 * back zero, so a suite asserting what the meter shows cannot tell "the
 * manager read the level" from "the level was zero anyway". This double
 * reports whatever the test tells it to.
 *
 * It keeps no module state - a test reaches its monitor through
 * `jest.mocked(InputLevelMonitor).mock.instances`, which `clearMocks` empties
 * between tests, rather than through a list this file would have to remember
 * to clear.
 *
 * The level maths itself is real and covered by
 * tests/unit/InputLevelMonitor.test.ts; nothing here stands in for that.
 *
 * Usage:
 * ```ts
 * jest.mock('src/recording/InputLevelMonitor', () =>
 *     require('../mocks/modules/inputLevelMonitor'),
 * );
 * ```
 * @module tests/mocks/modules/inputLevelMonitor
 */

/** The surface RecordingManager drives on a level monitor, as spies. */
export interface MockInputLevelMonitor {
	start: jest.Mock;
	stop: jest.Mock;
	getLevel: jest.Mock;
}

export const InputLevelMonitor = jest.fn(function (
	this: MockInputLevelMonitor,
): void {
	this.start = jest.fn();
	this.stop = jest.fn();
	this.getLevel = jest.fn(() => 0);
});
