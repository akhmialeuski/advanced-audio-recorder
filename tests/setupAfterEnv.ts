/**
 * Per-test reset for state the mock keeps at module level.
 *
 * `clearMocks` and `restoreMocks` cover mocks and spies, but the obsidian mock
 * also holds plain module state: the handler `requestUrl` delegates to, the app
 * version `requireApiVersion` answers from, and the notices and menus raised so
 * far. A
 * test that installed one used to be responsible for taking it back down, which
 * is a convention rather than a guarantee - and one that a failing assertion
 * skips.
 *
 * Resetting here makes every test start from the same place no matter what ran
 * before it, which is what lets the suite run in a random order.
 *
 * It is also where the domain matchers are registered, so every test has
 * `toHaveControl` and friends without importing them.
 * @module tests/setupAfterEnv
 */

import './helpers/matchers';
import { __resetMicrophone } from './helpers/memoryCapture';
import { __resetStopFailure } from './mocks/modules/pcmStreamRecorder';
import {
	DEFAULT_MOCK_API_VERSION,
	__setApiVersion,
	__setRequestUrlHandler,
	menuInstances,
	modalInstances,
	noticeInstances,
} from './mocks/obsidian';

beforeEach(() => {
	__setRequestUrlHandler(null);
	__setApiVersion(DEFAULT_MOCK_API_VERSION);
	noticeInstances.length = 0;
	menuInstances.length = 0;
	modalInstances.length = 0;
	// An armed stop failure is module state no mock reset reaches, and a test
	// that armed one without building a recorder would hand it to the next.
	__resetStopFailure();
	// The capture double replaces two globals, and a case that ran after an
	// install found them still in place.
	__resetMicrophone();
	defaultsBefore = describeDefaults();
});

/**
 * The default settings as text, Maps included, so an in-place edit anywhere
 * in them shows as a different string.
 * @returns The defaults, serialised
 */
function describeDefaults(): string {
	const { DEFAULT_SETTINGS } = jest.requireActual<
		typeof import('src/settings/settingsSchema')
	>('src/settings/settingsSchema');
	return JSON.stringify(DEFAULT_SETTINGS, (_key, value: unknown) =>
		value instanceof Map ? [...value] : value,
	);
}

/** The defaults as the current test found them. */
let defaultsBefore = '';

afterEach(() => {
	// A test that edits a shallow copy of DEFAULT_SETTINGS edits the defaults
	// themselves, and every case after it in the file then starts from its
	// values. Which cases see them turns on the order the suite runs in, so
	// the leak is failed here, at the test that made it.
	if (describeDefaults() !== defaultsBefore) {
		throw new Error(
			'This test changed DEFAULT_SETTINGS in place. Build its settings with defaultSettings() from tests/helpers/settingsFixtures.',
		);
	}
});
