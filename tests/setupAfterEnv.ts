/**
 * Per-test reset for state the mock keeps at module level.
 *
 * `clearMocks` and `restoreMocks` cover mocks and spies, but the obsidian mock
 * also holds plain module state: the handler `requestUrl` delegates to, the app
 * version `requireApiVersion` answers from, and the notices raised so far. A
 * test that installed one used to be responsible for taking it back down, which
 * is a convention rather than a guarantee - and one that a failing assertion
 * skips.
 *
 * Resetting here makes every test start from the same place no matter what ran
 * before it, which is what lets the suite run in a random order.
 * @module tests/setupAfterEnv
 */

import {
	DEFAULT_MOCK_API_VERSION,
	__setApiVersion,
	__setRequestUrlHandler,
	noticeInstances,
} from './mocks/obsidian';

beforeEach(() => {
	__setRequestUrlHandler(null);
	__setApiVersion(DEFAULT_MOCK_API_VERSION);
	noticeInstances.length = 0;
});
