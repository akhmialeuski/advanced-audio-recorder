/**
 * Isolated adapter for the page stack of Obsidian's settings modal.
 *
 * From 1.13 a settings tab can declare sub-pages, and the framework resolves an
 * open page by its name path on every re-render. A page that edits one entry of
 * a collection therefore outlives the entry it edits: delete the entry from
 * inside its own page and the path stops resolving, so the framework keeps the
 * titlebar and renders nothing under it until the user presses back. Popping the
 * page is what the back chevron does, and the modal is the only object that can
 * do it - `SettingPage` exposes no close, and the public `SettingTab` surface
 * ends at `update()`.
 *
 * That modal is internal API, absent from the public obsidian.d.ts, so every
 * access goes through this module: the shape is typed here, probed defensively
 * at runtime, and reported back so the caller can fall back to leaving the page
 * open rather than failing.
 * @module obsidian/settingsNavigation
 */

import type { App } from 'obsidian';

/**
 * The half of the internal settings modal used here. Members are optional so
 * the runtime guard can detect a removed or renamed API.
 */
export interface SettingsModal {
	/** Pops the open sub-page and re-renders whatever it was opened from. */
	closePage?(): void;
	/** Opens the settings dialog itself. */
	open?(): void;
	/** Shows one tab of it, by the id the plugin is registered under. */
	openTabById?(id: string): void;
}

declare module 'obsidian' {
	interface App {
		setting?: SettingsModal;
	}
}

/**
 * Closes the settings sub-page that is open, if any.
 *
 * Safe to call when no page is open: the modal pops an empty stack without
 * effect. Also safe when the internal API is gone, which is the case this
 * returns false for.
 * @param app - The Obsidian App instance
 * @returns Whether the close could be requested
 */
export function closeSettingsPage(app: App): boolean {
	const modal = app.setting;
	if (!modal || typeof modal.closePage !== 'function') {
		return false;
	}
	// Called on the modal rather than through a captured reference: it is the
	// modal that owns the page stack the close operates on.
	modal.closePage();
	return true;
}

/**
 * Opens a plugin's own tab of the settings dialog.
 *
 * Used where the plugin has a reason to put the user in front of its settings
 * rather than to wait for them to find it - the deliberate enable, which is the
 * one moment Obsidian tells a plugin it may engage with the user.
 *
 * The dialog is opened before the tab is selected. It is already open when a
 * plugin is enabled from Community plugins, where opening it again does
 * nothing; from anywhere else, selecting a tab of a closed dialog would leave
 * the user looking at nothing.
 * @param app - The Obsidian App instance
 * @param pluginId - Id the plugin's settings tab is registered under
 * @returns Whether the tab could be opened
 */
export function openPluginSettings(app: App, pluginId: string): boolean {
	const modal = app.setting;
	if (
		!modal ||
		typeof modal.open !== 'function' ||
		typeof modal.openTabById !== 'function'
	) {
		return false;
	}
	modal.open();
	modal.openTabById(pluginId);
	return true;
}
