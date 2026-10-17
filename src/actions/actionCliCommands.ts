/**
 * The command-line half of the action registry: every action of a family
 * becomes a command of the Obsidian command line, named under the plugin id,
 * taking the family's target parameters and the action's own.
 *
 * The palette and the menus run an action for someone in front of the app,
 * so they open its dialog. The command line has nobody there, so it runs the
 * action's headless execution with the choices typed as parameters, and
 * answers with what happened. An action whose dialog is worth reaching from a
 * terminal anyway takes the `dialog` flag, which opens that dialog in Obsidian
 * on the target the command named.
 * @module actions/actionCliCommands
 */

import type { CliData, CliFlags } from 'obsidian';
import { PLUGIN_LOG_PREFIX } from '../constants';
import { errorMessage } from '../errors';
import { cliFlag, flagParam, isRefusal } from '../obsidian/cliArgs';
import type { CliCommand } from '../obsidian/cliCommands';
import type { ActionFamily, PluginCommand } from './PluginAction';

/** The flag that opens an action's dialog instead of running it here. */
export const DIALOG_FLAG = 'dialog';

/**
 * The parameters one action's command declares: the family's target first,
 * then the action's own, then the dialog flag where the action has a dialog.
 * @param family - The family the action belongs to
 * @param action - The action
 */
export function actionCliParams<TContext>(
	family: ActionFamily<TContext>,
	action: PluginCommand<TContext>,
): CliFlags {
	return {
		...family.cliTarget.params,
		...action.cli.params,
		...(action.cli.opensDialog
			? {
					[DIALOG_FLAG]: flagParam(
						'Open the dialog in Obsidian on the target instead of running here.',
					),
				}
			: {}),
	};
}

/**
 * The parameters as `registerCliHandler` takes them: null for a command that
 * takes none, which is how the API spells "no flags".
 * @param params - The declared parameters
 */
function withoutEmpty(params: CliFlags): CliFlags | null {
	return Object.keys(params).length === 0 ? null : params;
}

/**
 * Runs an action on one target the way the command line asked.
 * @param family - The family the action belongs to
 * @param action - The action
 * @param target - The target, already resolved
 * @param args - Everything typed after the command
 * @returns The line answering for this target
 */
async function runOnTarget<TContext>(
	family: ActionFamily<TContext>,
	action: PluginCommand<TContext>,
	target: TContext,
	args: CliData,
): Promise<string> {
	const name = family.describe(target);
	if (!action.isAvailable(target)) {
		return (
			action.cli.unavailable?.(target) ??
			`${action.title} is not available for ${name}.`
		);
	}
	try {
		if (action.cli.opensDialog && cliFlag(args, DIALOG_FLAG)) {
			await action.run(target);
			return `Opened "${action.title}" for ${name} in Obsidian.`;
		}
		return await action.cli.execute(target, args);
	} catch (error) {
		// The answer says what failed; the console keeps the stack for a
		// bug report, which an answer on a terminal cannot carry.
		console.error(
			`${PLUGIN_LOG_PREFIX} CLI command ${action.cli.name} failed for ${name}:`,
			error,
		);
		return `${action.title} failed for ${name}: ${errorMessage(error)}`;
	}
}

/**
 * The arguments each of several targets runs with: the action's wait flag
 * set, so a job the action would only start is finished before the next
 * target's begins.
 * @param action - The action
 * @param args - Everything typed after the command
 */
function argsForEach<TContext>(
	action: PluginCommand<TContext>,
	args: CliData,
): CliData {
	const { waitFlag } = action.cli;
	return waitFlag === undefined ? args : { ...args, [waitFlag]: 'true' };
}

/**
 * The command-line commands of a family, one per action.
 *
 * Several targets - every recording of a note, when the command asked for
 * all of them - run one after the other rather than at once: they share the
 * engine, the encoder and the vault, and the answer lists them in the order
 * they ran. An action that answers once its job started is made to wait for
 * each, and a dialog, which is opened on one target, is refused for several.
 * @param family - The actions and how their targets are named
 * @param pluginId - The plugin id every command is named under
 * @returns One command per action, in the family's order
 */
export function actionCliCommands<TContext>(
	family: ActionFamily<TContext>,
	pluginId: string,
): CliCommand[] {
	return family.actions.map((action) => ({
		id: `${pluginId}:${action.cli.name}`,
		description: action.cli.description,
		flags: withoutEmpty(actionCliParams(family, action)),
		handler: async (args: CliData): Promise<string> => {
			const resolved = await family.cliTarget.resolve(args);
			if (isRefusal(resolved)) {
				return resolved.refusal;
			}
			const targets = resolved.value;
			if (targets.length === 1) {
				return runOnTarget(
					family,
					action,
					targets[0] as TContext,
					args,
				);
			}
			if (action.cli.opensDialog && cliFlag(args, DIALOG_FLAG)) {
				return `${DIALOG_FLAG} opens the dialog on one target: name one rather than ${String(targets.length)}.`;
			}
			const each = argsForEach(action, args);
			const answers: string[] = [];
			for (const target of targets) {
				answers.push(await runOnTarget(family, action, target, each));
			}
			return answers.join('\n');
		},
	}));
}
