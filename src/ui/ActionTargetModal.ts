/**
 * Asks which target a palette command is for when there is more than one:
 * which recording of a note that embeds several, which folder of the vault.
 * A fuzzy picker, as Obsidian's own "Move file to..." asks for a folder, so
 * the target is typed for rather than scrolled to.
 * @module ui/ActionTargetModal
 */

import { FuzzySuggestModal } from 'obsidian';
import type { App } from 'obsidian';

/**
 * A picker over the targets an action could run on.
 */
export class ActionTargetModal<TContext> extends FuzzySuggestModal<TContext> {
	/**
	 * @param app - Obsidian App instance
	 * @param targets - The targets to choose from, in the order offered
	 * @param describe - Names a target in its row
	 * @param onChoose - Runs the action on the target chosen
	 */
	constructor(
		app: App,
		private readonly targets: readonly TContext[],
		private readonly describe: (context: TContext) => string,
		private readonly onChoose: (context: TContext) => void,
	) {
		super(app);
		this.setPlaceholder('Choose what to run the command on');
	}

	/** Every target offered. */
	getItems(): TContext[] {
		return [...this.targets];
	}

	/**
	 * What a row shows and the query is matched against.
	 * @param target - The target
	 */
	getItemText(target: TContext): string {
		return this.describe(target);
	}

	/**
	 * Runs the action on the chosen target.
	 * @param target - The target
	 */
	onChooseItem(target: TContext): void {
		this.onChoose(target);
	}
}
