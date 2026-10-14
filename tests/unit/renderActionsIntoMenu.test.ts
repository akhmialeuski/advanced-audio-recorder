/**
 * Tests for rendering actions into a menu: what a menu entry does when the
 * action behind it fails, since Obsidian drops what a menu handler returns.
 */

import { Menu } from 'obsidian';
import { renderActionsIntoMenu } from 'src/actions/renderActionsIntoMenu';
import type { PluginCommand } from 'src/actions/PluginAction';
import { at } from '../helpers/assertions';
import { asMockMenu } from '../helpers/obsidianMock';
import { flushMicrotasks } from '../helpers/async';

/** An action whose run rejects. */
function failingAction(): PluginCommand<null> {
	return {
		commandId: 'broken-action',
		title: 'Broken action',
		icon: 'bug',
		isAvailable: () => true,
		run: () => Promise.reject(new Error('boom')),
	};
}

describe('a menu entry whose action fails', () => {
	it('logs the failure under the action it came from', async () => {
		const error = jest.spyOn(console, 'error').mockImplementation(() => {
			// Asserted below
		});
		const menu = new Menu();
		renderActionsIntoMenu(menu, [failingAction()], null, new Set());

		at(asMockMenu(menu).items, 0).click();
		await flushMicrotasks();

		expect(error).toHaveBeenCalledWith(
			expect.stringContaining('broken-action failed from a menu'),
			expect.any(Error),
		);
	});
});
