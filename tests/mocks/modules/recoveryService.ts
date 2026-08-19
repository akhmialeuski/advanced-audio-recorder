/**
 * Crash recovery as the e2e suites see it: nothing was interrupted, and both
 * outcomes succeed. A suite about recovery scripts these per test.
 * @module tests/mocks/modules/recoveryService
 */

export const collectRecoverableSessions = jest.fn().mockResolvedValue([]);
export const recoverSession = jest
	.fn()
	.mockResolvedValue({ recoveredPaths: [], failedTracks: [] });
export const discardSession = jest.fn().mockResolvedValue([]);
