/**
 * Tests for the action registry: adding a family puts every action on the
 * palette and keeps its command-line commands, the menus render only what was
 * added, and two actions can never share an id.
 * @module tests/unit/ActionRegistry.test
 */

import { Menu } from 'obsidian';
import { ActionRegistry } from 'src/actions/ActionRegistry';
import type { ActionFamily, PluginCommand } from 'src/actions/PluginAction';
import {
	asMockMenu,
	asMockPlugin,
	mockPluginHost,
} from '../helpers/obsidianMock';
import { createMockApp } from '../helpers/createApp';

/** An action over plain strings, named by its id. */
function action(id: string, name = id): PluginCommand<string> {
	return {
		commandId: id,
		title: `Do ${id}`,
		icon: 'info',
		isAvailable: (target) => target !== 'none',
		run: jest.fn(),
		cli: { name, description: `Do ${id}.`, execute: () => id },
	};
}

/** A family over the given actions, always aimed at "it". */
function family(actions: PluginCommand<string>[]): ActionFamily<string> {
	return {
		actions,
		activeTargets: () => ['it'],
		cliTarget: { params: {}, resolve: () => ['it'] },
		describe: (target) => target,
	};
}

/** A registry over a plugin double. */
function createSut(): {
	registry: ActionRegistry;
	plugin: ReturnType<typeof asMockPlugin>;
} {
	const host = mockPluginHost(createMockApp().app);
	Object.assign(host, { manifest: { id: 'aar' } });
	return {
		registry: new ActionRegistry(host, jest.fn()),
		plugin: asMockPlugin(host),
	};
}

describe('adding a family', () => {
	it('puts every action on the palette at once', () => {
		const { registry, plugin } = createSut();

		registry.add(family([action('one'), action('two')]));

		expect(plugin.registeredCommands.map((command) => command.id)).toEqual([
			'one',
			'two',
		]);
	});

	it('keeps the command-line commands of every family, in order', () => {
		const { registry } = createSut();

		registry.add(family([action('one')]));
		registry.add(family([action('two')]));

		expect(registry.cliCommands().map((command) => command.id)).toEqual([
			'aar:one',
			'aar:two',
		]);
	});

	it.each([
		{ name: 'a palette id', second: action('one', 'other') },
		{ name: 'a command-line name', second: action('other', 'one') },
	])('refuses an action that reuses $name', ({ second }) => {
		const { registry } = createSut();
		registry.add(family([action('one')]));

		expect(() => registry.add(family([second]))).toThrow(
			/Two plugin actions share the id/,
		);
	});
});

describe('rendering a family into a menu', () => {
	it('renders the actions available for the target', () => {
		const { registry } = createSut();
		const added = registry.add(family([action('one')]));
		const menu = new Menu();

		registry.renderInto(menu, added, 'it', new Set());

		expect(asMockMenu(menu).items.map((item) => item.title)).toEqual([
			'Do one',
		]);
	});

	it('renders nothing the target does not take', () => {
		const { registry } = createSut();
		const added = registry.add(family([action('one')]));
		const menu = new Menu();

		registry.renderInto(menu, added, 'none', new Set());

		expect(asMockMenu(menu).items).toEqual([]);
	});
});
