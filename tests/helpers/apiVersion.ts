/**
 * Pinning the Obsidian version a test runs against.
 *
 * `requireApiVersion` answers from a module-level string in the mock, which
 * decides which of the two settings renderers the tab uses and which APIs the
 * plugin reaches for. Setting it directly is shared state a test has to undo;
 * this names the intent, and tests/setupAfterEnv.ts puts the default back
 * before every test whatever the last one pinned.
 * @module tests/helpers/apiVersion
 */

import { __setApiVersion } from '../mocks/obsidian';

/**
 * Runs the current test against a given Obsidian version.
 * @param version - The version `requireApiVersion` should answer from
 */
export function withApiVersion(version: string): void {
	__setApiVersion(version);
}
