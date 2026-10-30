/**
 * Tests for rendering actions into a menu: what a menu entry does when the
 * action behind it fails, since Obsidian drops what a menu handler returns.
 */

import { Menu } from 'obsidian';
import { renderActionsIntoMenu } from 'src/actions/core/renderActionsIntoMenu';
import type { PluginCommand } from 'src/actions/core/PluginAction';
import { at } from '../helpers/assertions';
import { asMockMenu } from '../helpers/obsidianMock';
import { flushMicrotasks } from '../helpers/async';
import { FAILING_RUNS } from '../helpers/doubles';

/** An action that fails the way its run does. */
function failingAction(run: () => void | Promise<void>): PluginCommand<null> {
	return {
		commandId: 'broken-action',
		title: 'Broken action',
		icon: 'bug',
		isAvailable: () => true,
		run,
		cli: { name: 'broken', description: 'Broken.', execute: () => '' },
	};
}

describe('a menu entry whose action fails', () => {
	it.each(FAILING_RUNS)(
		'logs an action that %s under the action it came from',
		async (_how, run) => {
			const error = jest
				.spyOn(console, 'error')
				.mockImplementation(() => {
					// Asserted below
				});
			const menu = new Menu();
			renderActionsIntoMenu(menu, [failingAction(run)], null, new Set());

			at(asMockMenu(menu).items, 0).click();
			await flushMicrotasks();

			expect(error).toHaveBeenCalledWith(
				expect.stringContaining('broken-action failed from a menu'),
				expect.any(Error),
			);
		},
	);
});
