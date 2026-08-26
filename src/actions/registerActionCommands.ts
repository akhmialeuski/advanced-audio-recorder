/**
 * Registers plugin actions as palette commands. One registration path
 * serves every kind of action, because they differ only in the context
 * they run against: a file action resolves the active audio file, a
 * session action resolves the recorder, a playback action resolves the
 * snapshot of what is playing. The palette, the context menus, and the
 * Hotkeys settings therefore expose the same feature set from the same
 * definitions. No default hotkeys are assigned; the user binds them in
 * Settings -> Hotkeys.
 * @module actions/registerActionCommands
 */

import type { Plugin } from 'obsidian';
import type { PluginCommand } from './PluginAction';

/**
 * Registers each action as a checkCallback command over the context the
 * resolver produces. The resolver runs on every check, so the command
 * disappears from the palette (and its hotkey goes inert) the moment its
 * context stops existing.
 * @param plugin - Plugin to register commands on
 * @param actions - Actions to register, in palette order
 * @param resolve - Produces the context, or null when there is none
 */
export function registerActionCommands<TContext>(
	plugin: Plugin,
	actions: readonly PluginCommand<TContext>[],
	resolve: () => TContext | null,
): void {
	for (const action of actions) {
		plugin.addCommand({
			id: action.commandId,
			name: action.title,
			icon: action.icon,
			checkCallback: (checking: boolean): boolean => {
				const context = resolve();
				if (context === null || !action.isAvailable(context)) {
					return false;
				}
				if (!checking) {
					void action.run(context);
				}
				return true;
			},
		});
	}
}
