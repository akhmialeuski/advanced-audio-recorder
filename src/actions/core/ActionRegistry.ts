/**
 * The one place a plugin action reaches the user from.
 *
 * Adding a family here registers every one of its actions as a palette
 * command - which is what makes it bindable in Settings -> Hotkeys - and as a
 * command of the Obsidian command line; the context menus render only the
 * families added here. An action defined in a family is therefore on every
 * surface at once, and there is no second list to forget to update: a menu
 * entry that is not a palette command, or a palette command the command line
 * does not answer, cannot be written.
 * @module actions/core/ActionRegistry
 */

import type { Menu, Plugin } from 'obsidian';
import type { CliCommand } from '../../obsidian/cliCommands';
import { actionCliCommands } from './actionCliCommands';
import type { ActionFamily } from './PluginAction';
import {
	registerActionCommands,
	type TargetPicker,
} from './registerActionCommands';
import { renderActionsIntoMenu } from './renderActionsIntoMenu';

/**
 * A family as the registry hands it back: proof that it was registered, and
 * the only thing a menu can render.
 */
export interface RegisteredFamily<TContext> {
	/** The family itself. */
	readonly family: ActionFamily<TContext>;
}

/**
 * Registers action families on the palette and the command line, and renders
 * them into menus.
 */
export class ActionRegistry {
	/** The command-line commands of every family, in registration order. */
	private readonly commands: CliCommand[] = [];

	/** Command ids already taken, checked so two actions never share one. */
	private readonly ids = new Set<string>();

	/**
	 * @param plugin - The plugin the commands are registered on
	 * @param pickTarget - Asks which target, when the palette finds several
	 */
	constructor(
		private readonly plugin: Plugin,
		private readonly pickTarget: TargetPicker,
	) {}

	/**
	 * Registers every action of a family as a palette command now, and keeps
	 * its command-line commands for {@link cliCommands}, which are registered
	 * together once every family is in.
	 * @param family - The actions and how their targets are found
	 * @returns The family, registered
	 * @throws When an action reuses a palette id or a command-line name, which
	 *   would leave one of the two unreachable
	 */
	add<TContext>(family: ActionFamily<TContext>): RegisteredFamily<TContext> {
		const commands = actionCliCommands(family, this.plugin.manifest.id);
		this.claim([
			...family.actions.map((action) => action.commandId),
			...commands.map((command) => command.id),
		]);
		registerActionCommands(this.plugin, family, this.pickTarget);
		this.commands.push(...commands);
		return { family };
	}

	/**
	 * Keeps command-line commands that are no action of a family, the
	 * recorder's own, under the same check as the families' commands, so a
	 * clash anywhere is caught in one place and the same way.
	 * @param commands - The commands
	 * @throws When one reuses a command id already taken
	 */
	addCliCommands(commands: readonly CliCommand[]): void {
		this.claim(commands.map((command) => command.id));
		this.commands.push(...commands);
	}

	/**
	 * Takes command ids, refusing one already taken: two commands of one id
	 * would leave one of them unreachable, and the host would refuse the
	 * second partway through registering the command line.
	 * @param ids - The ids to take
	 * @throws When an id is taken already
	 */
	private claim(ids: readonly string[]): void {
		for (const id of ids) {
			if (this.ids.has(id)) {
				throw new Error(`Two plugin commands share the id "${id}".`);
			}
			this.ids.add(id);
		}
	}

	/** Every command-line command of the families added so far. */
	cliCommands(): readonly CliCommand[] {
		return [...this.commands];
	}

	/**
	 * Renders a registered family's available actions into a menu.
	 * @param menu - The menu being built
	 * @param registered - The family
	 * @param context - The target the menu was opened on
	 * @param rendered - Ids already rendered into this menu
	 */
	renderInto<TContext>(
		menu: Menu,
		registered: RegisteredFamily<TContext>,
		context: TContext,
		rendered: Set<string>,
	): void {
		renderActionsIntoMenu(
			menu,
			registered.family.actions,
			context,
			rendered,
		);
	}
}
