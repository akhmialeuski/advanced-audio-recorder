/**
 * Unit tests for running Templater commands through the Templater plugin.
 * @module tests/unit/templater.test
 */

import type { App, TFile } from 'obsidian';
import {
	hasTemplaterCommands,
	runTemplater,
	TemplaterOutcome,
} from 'src/obsidian/templater';
import { withTemplaterCommandsRun } from 'src/transcription/templaterStep';

const target = { path: 'Recordings/standup.webm' } as TFile;

/**
 * An app whose plugin registry answers with the given plugin.
 * @param plugin - What `getPlugin` gives; undefined for no registry at all
 */
function appWith(plugin?: unknown): App {
	return (plugin === undefined
		? {}
		: { plugins: { getPlugin: () => plugin } }) as unknown as App;
}

describe('hasTemplaterCommands', () => {
	it.each([
		['<% tp.file.title %>', true],
		['<%* tR += "x" %>', true],
		['<%\n tp.date.now() \n%>', true],
		['{{title}} and 5 % 2', false],
	])('reads %p as holding a command: %p', (text, expected) => {
		expect(hasTemplaterCommands(text)).toBe(expected);
	});
});

describe('runTemplater', () => {
	it('does not look for Templater when the text has no command', async () => {
		const getPlugin = jest.fn();
		const app = { plugins: { getPlugin } } as unknown as App;

		await expect(runTemplater(app, '# {{title}}', target)).resolves.toEqual(
			{
				text: '# {{title}}',
				outcome: TemplaterOutcome.NoCommands,
			},
		);
		expect(getPlugin).not.toHaveBeenCalled();
	});

	it.each([
		['no plugin registry', appWith()],
		['Templater not enabled', appWith(null)],
		['a Templater without the processing API', appWith({ templater: {} })],
	])('reads %s as Templater missing', async (_label, app) => {
		await expect(
			runTemplater(app, '<% tp.file.title %>', target),
		).resolves.toEqual({
			text: '<% tp.file.title %>',
			outcome: TemplaterOutcome.Missing,
		});
	});

	it('asks Templater to process the text on its own, for the target', async () => {
		const create_running_config = jest.fn(() => 'config');
		const parse_template = jest.fn(() => Promise.resolve('standup'));
		const app = appWith({
			templater: { create_running_config, parse_template },
		});

		await expect(
			runTemplater(app, '<% tp.file.title %>', target),
		).resolves.toEqual({
			text: 'standup',
			outcome: TemplaterOutcome.Processed,
		});
		expect(create_running_config).toHaveBeenCalledWith(
			undefined,
			target,
			4,
		);
		expect(parse_template).toHaveBeenCalledWith(
			'config',
			'<% tp.file.title %>',
		);
	});
});

describe('withTemplaterCommandsRun', () => {
	it('runs the commands for the recording when it is in no note', async () => {
		const parse_template = jest.fn(
			(config: TFile, text: string): Promise<string> =>
				Promise.resolve(
					text.replace('<% tp.file.path %>', config.path),
				),
		);
		const app = appWith({
			templater: {
				create_running_config: (_t: unknown, file: TFile) => file,
				parse_template,
			},
		});

		await expect(
			withTemplaterCommandsRun(
				{ app, settings: {} as never, recording: target, notePath: '' },
				'From <% tp.file.path %>',
				'Plain',
			),
		).resolves.toBe('From Recordings/standup.webm');
	});
});
