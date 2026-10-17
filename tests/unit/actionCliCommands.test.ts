/**
 * Tests for how a family of actions becomes commands of the Obsidian command
 * line: the names and parameters each command declares, and what it answers -
 * the action's own answer, why it is not available, why it failed, or that
 * its dialog was opened in Obsidian.
 * @module tests/unit/actionCliCommands.test
 */

import type { CliData } from 'obsidian';
import {
	actionCliCommands,
	actionCliParams,
	DIALOG_FLAG,
} from 'src/actions/actionCliCommands';
import type {
	ActionCli,
	ActionFamily,
	PluginCommand,
} from 'src/actions/PluginAction';
import { at } from '../helpers/assertions';
import { silenceConsole } from '../helpers/doubles';

/** A target of the test family. */
interface Target {
	name: string;
	takes: boolean;
}

/** One action of the test family, its run and execute spies. */
function makeAction(
	cli: Partial<ActionCli<Target>> = {},
): PluginCommand<Target> & {
	run: jest.Mock;
} {
	return {
		commandId: 'act',
		title: 'Act',
		icon: 'info',
		isAvailable: (target) => target.takes,
		run: jest.fn(),
		cli: {
			name: 'act',
			description: 'Act on a target.',
			execute: (target) => `Acted on ${target.name}.`,
			...cli,
		},
	};
}

/**
 * The commands of a family over one action, its targets resolved from what
 * the test hands it.
 * @param action - The action
 * @param resolve - What the targets resolve to
 * @param params - The family's target parameters
 */
function createSut(
	action: PluginCommand<Target> = makeAction(),
	resolve: ActionFamily<Target>['cliTarget']['resolve'] = () => ({
		value: [{ name: 'a', takes: true }],
	}),
	params: ActionFamily<Target>['cliTarget']['params'] = {},
): {
	family: ActionFamily<Target>;
	run: (args?: CliData) => Promise<string>;
} {
	const family: ActionFamily<Target> = {
		actions: [action],
		activeTargets: () => [],
		cliTarget: { params, resolve },
		describe: (target) => target.name,
	};
	const command = at(actionCliCommands(family, 'aar'), 0);
	return {
		family,
		run: (args = {}) => Promise.resolve(command.handler(args)),
	};
}

describe('the commands a family declares', () => {
	it('names each under the plugin id and the action name', () => {
		const { family } = createSut();

		expect(actionCliCommands(family, 'aar')).toEqual([
			expect.objectContaining({
				id: 'aar:act',
				description: 'Act on a target.',
			}),
		]);
	});

	it('declares no flags where neither the family nor the action takes one', () => {
		const { family } = createSut();

		expect(at(actionCliCommands(family, 'aar'), 0).flags).toBeNull();
	});

	it('declares the target parameters, then the action own, then the dialog flag', () => {
		const action = makeAction({
			params: { label: { value: '<text>', description: 'Label.' } },
			opensDialog: true,
		});
		const { family } = createSut(action, () => ({ value: [] }), {
			path: { value: '<path>', description: 'Path.' },
		});

		expect(Object.keys(actionCliParams(family, action))).toEqual([
			'path',
			'label',
			DIALOG_FLAG,
		]);
	});
});

describe('what a command answers', () => {
	it('answers with what the action says', async () => {
		await expect(createSut().run()).resolves.toBe('Acted on a.');
	});

	it('answers with why no target resolved', async () => {
		const { run } = createSut(makeAction(), () => ({
			refusal: 'Name a recording.',
		}));

		await expect(run()).resolves.toBe('Name a recording.');
	});

	it('waits for a target that resolves later', async () => {
		const { run } = createSut(makeAction(), () =>
			Promise.resolve({ value: [{ name: 'b', takes: true }] }),
		);

		await expect(run()).resolves.toBe('Acted on b.');
	});

	it('runs on every target in turn, a line each', async () => {
		const { run } = createSut(makeAction(), () => ({
			value: [
				{ name: 'a', takes: true },
				{ name: 'b', takes: true },
			],
		}));

		await expect(run()).resolves.toBe('Acted on a.\nActed on b.');
	});

	it('makes each of several targets wait for its job before the next', async () => {
		const execute = jest.fn(
			(target: Target, args: CliData) =>
				`${target.name} waited: ${args.wait ?? 'no'}`,
		);
		const { run } = createSut(
			makeAction({ waitFlag: 'wait', execute }),
			() => ({
				value: [
					{ name: 'a', takes: true },
					{ name: 'b', takes: true },
				],
			}),
		);

		await expect(run({ language: 'de' })).resolves.toBe(
			'a waited: true\nb waited: true',
		);
		expect(execute).toHaveBeenCalledWith(
			{ name: 'a', takes: true },
			{ language: 'de', wait: 'true' },
		);
	});

	it('leaves one target to answer as the action does', async () => {
		const execute = jest.fn(
			(target: Target, args: CliData) =>
				`${target.name} waited: ${args.wait ?? 'no'}`,
		);
		const { run } = createSut(makeAction({ waitFlag: 'wait', execute }));

		await expect(run()).resolves.toBe('a waited: no');
	});

	it('opens no dialog over several targets', async () => {
		const action = makeAction({ opensDialog: true });
		const { run } = createSut(action, () => ({
			value: [
				{ name: 'a', takes: true },
				{ name: 'b', takes: true },
			],
		}));

		await expect(run({ [DIALOG_FLAG]: 'true' })).resolves.toBe(
			'dialog opens the dialog on one target: name one rather than 2.',
		);
		expect(action.run).not.toHaveBeenCalled();
	});

	it('says an action is not available, in its own words', async () => {
		const action = makeAction({
			unavailable: (target) => `${target.name} is switched off.`,
		});
		const { run } = createSut(action, () => ({
			value: [{ name: 'a', takes: false }],
		}));

		await expect(run()).resolves.toBe('a is switched off.');
	});

	it('says so in general words where the action has none', async () => {
		const { run } = createSut(makeAction(), () => ({
			value: [{ name: 'a', takes: false }],
		}));

		await expect(run()).resolves.toBe('Act is not available for a.');
	});

	it('opens the dialog in Obsidian instead with the dialog flag', async () => {
		const action = makeAction({ opensDialog: true });
		const { run } = createSut(action);

		await expect(run({ [DIALOG_FLAG]: 'true' })).resolves.toBe(
			'Opened "Act" for a in Obsidian.',
		);
		expect(action.run).toHaveBeenCalledWith({ name: 'a', takes: true });
	});

	it('runs here when the action has no dialog, whatever was typed', async () => {
		const action = makeAction();
		const { run } = createSut(action);

		await expect(run({ [DIALOG_FLAG]: 'true' })).resolves.toBe(
			'Acted on a.',
		);
		expect(action.run).not.toHaveBeenCalled();
	});

	it.each([
		{ name: 'an error', thrown: new Error('disk full'), said: 'disk full' },
		{ name: 'anything else', thrown: 'refused', said: 'refused' },
	])(
		'says what failed when the action throws $name',
		async ({ thrown, said }) => {
			const error = silenceConsole('error');
			const action = makeAction({
				execute: () => Promise.reject(thrown),
			});

			await expect(createSut(action).run()).resolves.toBe(
				`Act failed for a: ${said}`,
			);
			expect(error).toHaveBeenCalledWith(
				'[AudioRecorder] CLI command act failed for a:',
				thrown,
			);
			error.mockRestore();
		},
	);
});
