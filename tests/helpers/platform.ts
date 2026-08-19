/**
 * Platform switching for tests, restored automatically.
 *
 * Obsidian exposes `Platform` as a module-level object, and the mock mirrors
 * that. Assigning to its fields leaks: `clearMocks`/`restoreMocks` reset mocks
 * and spies, not plain object properties, so a test that turned mobile on had
 * to remember to turn it off - and a failing assertion before the reset left
 * every later test on a mobile device.
 *
 * `jest.replaceProperty` records the previous value and `restoreMocks: true`
 * puts it back after each test, which makes the reset structural instead of a
 * convention.
 * @module tests/helpers/platform
 */

import { Platform } from 'obsidian';

/** Platform flags a test can pin for its duration. */
export interface PlatformFlags {
	isMobile?: boolean;
	isMobileApp?: boolean;
}

/**
 * Pins the platform flags for the current test.
 * @param flags - Flags to pin; omitted flags keep their current value
 */
export function setPlatform(flags: PlatformFlags): void {
	if (flags.isMobile !== undefined) {
		jest.replaceProperty(Platform, 'isMobile', flags.isMobile);
	}
	if (flags.isMobileApp !== undefined) {
		jest.replaceProperty(Platform, 'isMobileApp', flags.isMobileApp);
	}
}

/**
 * Runs the current test as a mobile app (both flags on).
 */
export function useMobilePlatform(): void {
	setPlatform({ isMobile: true, isMobileApp: true });
}

/**
 * Runs the current test as a desktop app (both flags off).
 *
 * The mock already defaults to desktop, so this is for tests that want the
 * platform stated rather than assumed - typically the desktop half of a
 * `describe.each` matrix.
 */
export function useDesktopPlatform(): void {
	setPlatform({ isMobile: false, isMobileApp: false });
}
