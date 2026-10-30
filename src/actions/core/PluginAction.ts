/**
 * A plugin action defined once and surfaced everywhere: the same
 * definition registers as a palette command (which makes it
 * hotkey-assignable in Obsidian's Hotkeys settings), as a command of the
 * Obsidian command line, and, on the surfaces that have one, renders as a
 * context-menu item. Every action is the same shape over a different context -
 * an audio file, a position in one, the recording session, or the playback
 * that is running - so adding a feature is an entry in one of the family
 * lists and nothing else. This module holds only that shape; each family
 * declares its own context and ports beside its actions.
 * @module actions/core/PluginAction
 */

import type { CliData, CliFlags } from 'obsidian';
import type { Refusable } from '../../utils/refusal';

/**
 * A command defined once over whatever context it needs.
 *
 * The context is resolved afresh on every palette check, so an action can
 * never hold a stale file or a finished playback, and a context that does
 * not resolve is what keeps the command out of the palette and leaves a
 * hotkey bound to it inert.
 */
export interface PluginCommand<TContext> {
	/** Command id (also the per-menu dedup key). */
	readonly commandId: string;
	/** Palette title, and the menu title unless one is given, in sentence case. */
	readonly title: string;
	/**
	 * The title a context menu shows instead, where the menu names its target
	 * differently: a menu opened on a point of the player says "here" where
	 * the palette has to say "at the current playback position".
	 */
	readonly menuTitle?: string;
	/** Lucide icon name, used by the menus and the mobile toolbar. */
	readonly icon: string;
	/** Availability gate beyond the context resolving at all. */
	isAvailable(context: TContext): boolean;
	/** Executes the action for someone in front of the app. */
	run(context: TContext): void | Promise<void>;
	/**
	 * The same action as a command of the Obsidian command line. Required, so
	 * an action cannot reach the menus and the palette without also reaching
	 * the command line: the type will not compile until it says how.
	 */
	readonly cli: ActionCli<TContext>;
}

/**
 * How an action runs from the command line, where nobody is in front of the
 * app: it takes its choices as parameters instead of from a dialog, and
 * answers with text instead of a notice.
 */
export interface ActionCli<TContext> {
	/**
	 * What follows the plugin id in the command: `<plugin-id>:<name>`. Short
	 * and verb-like, since it is typed rather than searched for.
	 */
	readonly name: string;
	/** The line `obsidian help` shows for the command. */
	readonly description: string;
	/** Parameters beyond the ones naming the target, which the family owns. */
	readonly params?: CliFlags;
	/**
	 * Whether {@link PluginCommand.run} opens a dialog. Such an action also
	 * takes the `dialog` flag, which opens that dialog in Obsidian on the
	 * named target instead of running without it.
	 */
	readonly opensDialog?: boolean;
	/**
	 * The flag that makes {@link execute} answer only once the job it starts
	 * is over, for an action that otherwise answers as soon as it started
	 * one. The command line sets it on every target when there are several,
	 * so they run one after another rather than all at once.
	 */
	readonly waitFlag?: string;
	/**
	 * Why the action is not available for this target, said where a menu
	 * would simply leave the entry out. Without it a generic sentence is used.
	 * @param context - The target the action was asked for
	 */
	unavailable?(context: TContext): string;
	/**
	 * Runs the action without any dialog.
	 * @param context - The target, resolved from the parameters
	 * @param args - Everything typed after the command
	 * @returns The answer printed on the command line
	 */
	execute(context: TContext, args: CliData): string | Promise<string>;
}

/**
 * Where a family of actions finds its target on the command line: the
 * parameters that name it, shared by every action of the family, and how they
 * resolve.
 */
export interface CliTarget<TContext> {
	/** Parameters naming the target, declared on every command of the family. */
	readonly params: CliFlags;
	/**
	 * Resolves the target the parameters name.
	 * @param args - Everything typed after the command
	 * @returns One target, several to run in turn, or the refusal saying why
	 *   none could be resolved
	 */
	resolve(
		args: CliData,
	): Refusable<readonly TContext[]> | Promise<Refusable<readonly TContext[]>>;
}

/**
 * Actions that share one kind of context, and the three ways that context is
 * found: by the menu that was opened on it, by what is active when the palette
 * runs, and by what the command line names.
 */
export interface ActionFamily<TContext> {
	/** The actions, in menu and palette order. */
	readonly actions: readonly PluginCommand<TContext>[];
	/**
	 * What the palette acts on right now. Several targets are offered in a
	 * picker; none keeps every command of the family out of the palette.
	 * Resolved on every palette check, so it never holds a stale target.
	 */
	activeTargets(): readonly TContext[];
	/**
	 * Answers the palette's check without listing the targets, for a family
	 * whose targets take a pass over the vault to find. Obsidian runs the
	 * check for every command each time the palette opens, so such a family
	 * says from the settings alone whether the action is offered, and its
	 * targets are listed only when the command runs. A family whose targets
	 * come from what is active leaves it out.
	 */
	readonly offeredWithoutTargets?: (
		action: PluginCommand<TContext>,
	) => boolean;
	/** How the command line names a target. */
	readonly cliTarget: CliTarget<TContext>;
	/** Names a target in a picker row and in a command-line answer. */
	readonly describe: (context: TContext) => string;
}
