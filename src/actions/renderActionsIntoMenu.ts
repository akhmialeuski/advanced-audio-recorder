/**
 * Renders actions into a context menu. One per-menu key set replaces the
 * per-feature WeakSet fields the menu code used to carry: Obsidian can
 * fire both editor-menu and file-menu for the same Menu instance, and the
 * player menu re-triggers file-menu, so every add goes through the same
 * dedup.
 * @module actions/renderActionsIntoMenu
 */

import type { Menu, MenuItem } from 'obsidian';
import { AAR_MENU_SECTION } from '../constants';
import type { PluginCommand } from './PluginAction';

/**
 * Adds every available action to the menu, skipping ones already
 * rendered into it. The context is the one the menu was built for, so
 * the availability gate a menu item passes is the very gate the palette
 * command of the same action evaluates.
 * @param menu - Menu being built
 * @param actions - Actions in display order
 * @param context - The context the menu targets
 * @param rendered - Per-menu set of action ids already added
 */
export function renderActionsIntoMenu<TContext>(
	menu: Menu,
	actions: readonly PluginCommand<TContext>[],
	context: TContext,
	rendered: Set<string>,
): void {
	for (const action of actions) {
		if (rendered.has(action.commandId)) {
			continue;
		}
		if (!action.isAvailable(context)) {
			continue;
		}
		rendered.add(action.commandId);
		menu.addItem((item: MenuItem) => {
			item.setTitle(action.title)
				.setIcon(action.icon)
				.setSection(AAR_MENU_SECTION)
				.onClick(() => void action.run(context));
		});
	}
}
