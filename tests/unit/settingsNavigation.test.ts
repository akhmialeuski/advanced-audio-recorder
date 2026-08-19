/**
 * Tests the adapter for the settings modal's page stack. The API is internal,
 * so the contract worth pinning is the defensive half: a build without it must
 * report that rather than throw, since the caller falls back to leaving the
 * page open.
 * @module tests/unit/settingsNavigation.test
 */

import {
	closeSettingsPage,
	openPluginSettings,
} from 'src/obsidian/settingsNavigation';
import type { App } from 'obsidian';

/**
 * An App whose settings modal is whatever a test hands it.
 * @param setting - The modal half of the App, or nothing
 */
const appWith = (setting?: {
	closePage?: unknown;
	open?: unknown;
	openTabById?: unknown;
}): App => ({ setting }) as unknown as App;

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

describe('openPluginSettings', () => {
	/** A modal that records the calls, in the order they arrived. */
	const modal = (): {
		calls: string[];
		open: () => void;
		openTabById: (id: string) => void;
	} => {
		const calls: string[] = [];
		return {
			calls,
			open: (): void => {
				calls.push('open');
			},
			openTabById: (id: string): void => {
				calls.push(`tab:${id}`);
			},
		};
	};

	it('opens the dialog before selecting the tab', () => {
		// Selecting a tab of a closed dialog leaves the user looking at
		// nothing, and re-opening an open one does nothing.
		const setting = modal();

		expect(openPluginSettings(appWith(setting), 'a-plugin')).toBe(true);
		expect(setting.calls).toEqual(['open', 'tab:a-plugin']);
	});

	it.each([
		['no open', { openTabById: (): void => undefined }],
		['no openTabById', { open: (): void => undefined }],
		['neither', {}],
	])('reports a build with %s', (_case, setting) => {
		expect(openPluginSettings(appWith(setting), 'a-plugin')).toBe(false);
	});

	it('reports a build with no settings modal at all', () => {
		expect(openPluginSettings(appWith(), 'a-plugin')).toBe(false);
	});
});
