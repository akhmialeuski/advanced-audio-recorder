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
import { PLUGIN_LOG_PREFIX } from '../constants';
import type { PluginCommand } from './PluginAction';

/**
 * Registers each action as a checkCallback command over the context the
 * resolver produces. The resolver runs on every check, so the command
 * disappears from the palette (and its hotkey goes inert) the moment its
 * context stops existing.
 *
 * An action that rejects is reported here. Obsidian discards whatever a
 * command returns, so without this the only trace of a failed action would
 * be an unhandled rejection with nothing naming the command it came from.
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
					// The action owns whatever it tells the user; this is the
					// diagnostic that survives when it tells them nothing.
					void Promise.resolve(action.run(context)).catch(
						(error: unknown) => {
							console.error(
								`${PLUGIN_LOG_PREFIX} Command ${action.commandId} failed:`,
								error,
							);
						},
					);
				}
				return true;
			},
		});
	}
}
