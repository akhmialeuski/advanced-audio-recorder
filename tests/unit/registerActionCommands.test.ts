/**
 * Tests for the one path every action reaches the palette through: a family's
 * actions become checkCallback commands over the targets the family finds
 * active, one target runs at once, several go to the picker, none keeps the
 * command out of the palette, and an action that fails names itself.
 * @module tests/unit/registerActionCommands.test
 */

import type { Plugin } from 'obsidian';
import {
	registerActionCommands,
	runReported,
} from 'src/actions/registerActionCommands';
import type { ActionFamily, PluginCommand } from 'src/actions/PluginAction';
import { asMockPlugin, mockPluginHost } from '../helpers/obsidianMock';
import { createMockApp } from '../helpers/createApp';
import { tick } from '../helpers/async';

/** A target of the test family: a name, and whether the action takes it. */
interface Target {
	name: string;
	takes: boolean;
}

/** One action over the test family, whose run is a spy. */
function makeAction(
	run: (target: Target) => void | Promise<void> = jest.fn(),
): PluginCommand<Target> {
	return {
		commandId: 'act',
		title: 'Act',
		icon: 'info',
		isAvailable: (target) => target.takes,
		run,
		cli: { name: 'act', description: 'Act.', execute: () => '' },
	};
}

/**
 * Registers one action over the given active targets.
 * @param targets - What the family finds active
 * @param action - The action
 * @returns The plugin double and the picker spy
 */
function createSut(
	targets: Target[],
	action: PluginCommand<Target> = makeAction(),
): {
	plugin: ReturnType<typeof asMockPlugin>;
	pick: jest.Mock;
	action: PluginCommand<Target>;
} {
	const plugin: Plugin = mockPluginHost(createMockApp().app);
	const family: ActionFamily<Target> = {
		actions: [action],
		activeTargets: () => targets,
		cliTarget: { params: {}, resolve: () => targets },
		describe: (target) => target.name,
	};
	const pick = jest.fn();
	registerActionCommands(plugin, family, pick);
	return { plugin: asMockPlugin(plugin), pick, action };
}

describe('a family registered on the palette', () => {
	it('registers the action under its id, title and icon', () => {
		const { plugin } = createSut([]);

		expect(plugin.registeredCommands).toEqual([
			expect.objectContaining({ id: 'act', name: 'Act', icon: 'info' }),
		]);
	});

	it('keeps the command out of the palette with no target', () => {
		const { plugin } = createSut([]);

		expect(plugin.invokeCommand('act')).toBe(false);
	});

	it('keeps it out when no target is one the action takes', () => {
		const { plugin } = createSut([{ name: 'a', takes: false }]);

		expect(plugin.invokeCommand('act')).toBe(false);
	});

	it('runs on the one target there is', () => {
		const run = jest.fn();
		const target = { name: 'a', takes: true };
		const { plugin } = createSut([target], makeAction(run));

		expect(plugin.invokeCommand('act')).toBe(true);

		expect(run).toHaveBeenCalledWith(target);
	});

	it('leaves out the targets the action does not take', () => {
		const run = jest.fn();
		const taken = { name: 'b', takes: true };
		const { plugin, pick } = createSut(
			[{ name: 'a', takes: false }, taken],
			makeAction(run),
		);

		plugin.invokeCommand('act');

		expect(run).toHaveBeenCalledWith(taken);
		expect(pick).not.toHaveBeenCalled();
	});

	it('asks which target when there are several', () => {
		const targets = [
			{ name: 'a', takes: true },
			{ name: 'b', takes: true },
		];
		const run = jest.fn();
		const { plugin, pick } = createSut(targets, makeAction(run));

		plugin.invokeCommand('act');

		expect(pick).toHaveBeenCalledWith(
			targets,
			expect.any(Function),
			expect.any(Function),
		);
		expect(run).not.toHaveBeenCalled();
	});

	it('runs on the target picked, and names them the family way', () => {
		const run = jest.fn();
		const targets = [
			{ name: 'a', takes: true },
			{ name: 'b', takes: true },
		];
		const { plugin, pick } = createSut(targets, makeAction(run));
		plugin.invokeCommand('act');
		const [, describe, choose] = pick.mock.calls[0] as [
			Target[],
			(target: Target) => string,
			(target: Target) => void,
		];

		choose(targets[1] as Target);

		expect(describe(targets[0] as Target)).toBe('a');
		expect(run).toHaveBeenCalledWith(targets[1]);
	});

	it('does not run while only checking', () => {
		const run = jest.fn();
		const { plugin } = createSut(
			[{ name: 'a', takes: true }],
			makeAction(run),
		);
		const command = plugin.registeredCommands[0];

		expect(command?.checkCallback?.(true)).toBe(true);
		expect(run).not.toHaveBeenCalled();
	});
});

describe('an action that fails', () => {
	it.each([
		{
			name: 'rejects',
			run: (): Promise<void> => Promise.reject(new Error('refused')),
		},
		{
			name: 'throws',
			run: (): void => {
				throw new Error('refused');
			},
		},
	])('names the command in the console when it $name', async ({ run }) => {
		const reported = jest
			.spyOn(console, 'error')
			.mockImplementation(() => undefined);

		runReported(makeAction(run), { name: 'a', takes: true }, 'the palette');
		await tick();

		// Obsidian discards whatever a command returns, so this line is the
		// only trace a failed action leaves behind.
		expect(reported).toHaveBeenCalledWith(
			'[AudioRecorder] act failed from the palette:',
			new Error('refused'),
		);
	});
});
