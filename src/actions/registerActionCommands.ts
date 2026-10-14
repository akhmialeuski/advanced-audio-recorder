/**
 * Registers a family of plugin actions as palette commands. One
 * registration path serves every kind of action, because they differ only
 * in the context they run against: a file action resolves the recordings of
 * what is active, a session action resolves the recorder, a playback action
 * resolves the snapshot of what is playing. The palette, the context menus,
 * the command line and the Hotkeys settings therefore expose the same feature
 * set from the same definitions. No default hotkeys are assigned; the user
 * binds them in Settings -> Hotkeys.
 * @module actions/registerActionCommands
 */

import type { Plugin } from 'obsidian';
import { PLUGIN_LOG_PREFIX } from '../constants';
import type { ActionFamily, PluginCommand } from './PluginAction';

/**
 * Asks the user which of several targets an action is for, then runs it on
 * the one chosen. Injected rather than built here, so the registration stays
 * free of any dialog.
 */
export type TargetPicker = <TContext>(
	targets: readonly TContext[],
	describe: (context: TContext) => string,
	onChoose: (context: TContext) => void,
) => void;

/**
 * Runs an action on a target and reports a rejection.
 *
 * Obsidian discards whatever a command returns, so without this the only
 * trace of a failed action would be an unhandled rejection with nothing
 * naming the command it came from. The action owns whatever it tells the
 * user; this is the diagnostic that survives when it tells them nothing.
 * @param action - The action to run
 * @param context - The target it runs on
 */
export function runReported<TContext>(
	action: PluginCommand<TContext>,
	context: TContext,
): void {
	const report = (error: unknown): void => {
		console.error(
			`${PLUGIN_LOG_PREFIX} Command ${action.commandId} failed:`,
			error,
		);
	};
	// Called synchronously, so a dialog the action opens is open by the time
	// the command returns, exactly as when the action is called directly.
	let outcome: void | Promise<void>;
	try {
		outcome = action.run(context);
	} catch (error) {
		report(error);
		return;
	}
	void Promise.resolve(outcome).catch(report);
}

/**
 * Registers each action of a family as a checkCallback command over the
 * targets the family finds active. The targets are resolved on every check,
 * so the command disappears from the palette (and its hotkey goes inert) the
 * moment no target the action is available for exists. One target runs at
 * once; several are offered in the picker, so a note that embeds three
 * recordings asks which one rather than guessing.
 * @param plugin - Plugin to register commands on
 * @param family - The actions and how their targets are found
 * @param pickTarget - Asks which target when there are several
 */
export function registerActionCommands<TContext>(
	plugin: Plugin,
	family: ActionFamily<TContext>,
	pickTarget: TargetPicker,
): void {
	for (const action of family.actions) {
		plugin.addCommand({
			id: action.commandId,
			name: action.title,
			icon: action.icon,
			checkCallback: (checking: boolean): boolean => {
				const targets = family
					.activeTargets()
					.filter((target) => action.isAvailable(target));
				const [only] = targets;
				if (only === undefined) {
					return false;
				}
				if (!checking) {
					if (targets.length === 1) {
						runReported(action, only);
					} else {
						pickTarget(targets, family.describe, (chosen) => {
							runReported(action, chosen);
						});
					}
				}
				return true;
			},
		});
	}
}
