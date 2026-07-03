/**
 * Renders file actions into a context menu. One per-menu key set
 * replaces the per-feature WeakSet fields the menu code used to carry:
 * Obsidian can fire both editor-menu and file-menu for the same Menu
 * instance, and the player menu re-triggers file-menu, so every add
 * goes through the same dedup.
 * @module actions/renderActionsIntoMenu
 */

import type { Menu, MenuItem, TFile } from 'obsidian';
import { AAR_MENU_SECTION } from '../constants';
import type { ActionServices, FileAction } from './PluginAction';

/**
 * Adds every available action to the menu, skipping ones already
 * rendered into it.
 * @param menu - Menu being built
 * @param actions - Actions in display order
 * @param file - The audio file the menu targets
 * @param services - Injected action services
 * @param rendered - Per-menu set of action ids already added
 */
export function renderFileActionsIntoMenu(
	menu: Menu,
	actions: readonly FileAction[],
	file: TFile,
	services: ActionServices,
	rendered: Set<string>,
): void {
	for (const action of actions) {
		if (rendered.has(action.commandId)) {
			continue;
		}
		if (!action.isAvailable(file, services)) {
			continue;
		}
		rendered.add(action.commandId);
		menu.addItem((item: MenuItem) => {
			item.setTitle(action.title)
				.setIcon(action.icon)
				.setSection(AAR_MENU_SECTION)
				.onClick(() => void action.run(file, services));
		});
	}
}
