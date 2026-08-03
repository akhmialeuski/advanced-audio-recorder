/**
 * Tests the adapter for the settings modal's page stack. The API is internal,
 * so the contract worth pinning is the defensive half: a build without it must
 * report that rather than throw, since the caller falls back to leaving the
 * page open.
 * @module tests/unit/settingsNavigation.test
 */

import { closeSettingsPage } from 'src/obsidian/settingsNavigation';
import type { App } from 'obsidian';

/**
 * An App whose settings modal is whatever a test hands it.
 * @param setting - The modal half of the App, or nothing
 */
const appWith = (setting?: { closePage?: unknown }): App =>
	({ setting }) as unknown as App;

describe('closeSettingsPage', () => {
	it('closes the open page through the modal', () => {
		const closePage = jest.fn();

		expect(closeSettingsPage(appWith({ closePage }))).toBe(true);
		expect(closePage).toHaveBeenCalledTimes(1);
	});

	it('calls it on the modal, which is what owns the page stack', () => {
		const modal = {
			closed: 0,
			closePage(this: { closed: number }): void {
				this.closed += 1;
			},
		};

		closeSettingsPage(appWith(modal));

		expect(modal.closed).toBe(1);
	});

	it('reports a build whose modal has no such method', () => {
		// The caller leaves the page open rather than failing the edit that
		// asked for the close.
		expect(closeSettingsPage(appWith({}))).toBe(false);
		expect(closeSettingsPage(appWith({ closePage: 'gone' }))).toBe(false);
	});

	it('reports a build with no settings modal at all', () => {
		expect(closeSettingsPage(appWith())).toBe(false);
	});
});
