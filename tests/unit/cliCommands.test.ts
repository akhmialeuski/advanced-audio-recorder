/**
 * Tests the commands the plugin answers on the desktop command line that have
 * no action behind them - the state, record and stop - and the registration
 * every command goes through: what each decides before it touches the
 * recorder, and the line it answers with.
 * @module tests/unit/cliCommands.test
 */

import {
	cliCommands,
	describeRecordingStatus,
	registerCliCommands,
	type CliHost,
	type CliPlayback,
} from 'src/obsidian/cliCommands';
import { RecordingStatus } from 'src/types';
import type { CliData, Plugin } from 'obsidian';
import { partial } from '../helpers/doubles';

const PLUGIN_ID = 'advanced-audio-recorder';

/** A host whose every answer is a spy, over the state a test pins. */
function makeHost(overrides: Partial<CliHost> = {}): CliHost {
	return {
		recordingStatus: jest.fn(() => RecordingStatus.Idle),
		startRecording: jest.fn().mockResolvedValue(null),
		stopRecording: jest.fn().mockResolvedValue(null),
		recordingFormat: jest.fn(() => 'webm'),
		playback: jest.fn(() => null),
		...overrides,
	};
}

/**
 * Runs one command the way the CLI runs it.
 * @param host - The host it is built over
 * @param id - Command id, without the plugin prefix ('' for the default one)
 * @param params - Flags as typed
 */
async function run(
	host: CliHost,
	id: string,
	params: CliData = {},
): Promise<string> {
	const wanted = id === '' ? PLUGIN_ID : `${PLUGIN_ID}:${id}`;
	const command = cliCommands(host, PLUGIN_ID).find(
		(candidate) => candidate.id === wanted,
	);
	if (!command) {
		throw new Error(`No CLI command "${wanted}"`);
	}
	return command.handler(params);
}

describe('the command set', () => {
	it('names every command under the plugin id, as Obsidian asks', () => {
		// The ids are global across every installed plugin.
		expect(cliCommands(makeHost(), PLUGIN_ID).map((c) => c.id)).toEqual([
			PLUGIN_ID,
			`${PLUGIN_ID}:record`,
			`${PLUGIN_ID}:stop`,
		]);
	});

	it('describes each command for the help output', () => {
		for (const command of cliCommands(makeHost(), PLUGIN_ID)) {
			expect(command.description).not.toBe('');
		}
	});

	it('takes no flags on any of them', () => {
		expect(cliCommands(makeHost(), PLUGIN_ID).map((c) => c.flags)).toEqual([
			null,
			null,
			null,
		]);
	});
});

describe('the status command', () => {
	it.each([
		[RecordingStatus.Recording, 'Recording.'],
		[RecordingStatus.Paused, 'Recording, paused.'],
		[RecordingStatus.Saving, 'Saving the recording that just stopped.'],
		[
			RecordingStatus.Interrupted,
			'The input device was lost; saving what was recorded.',
		],
	])('reports %s', async (status, expected) => {
		const host = makeHost({ recordingStatus: jest.fn(() => status) });

		await expect(run(host, '')).resolves.toBe(expected);
	});

	it('names the format a recording started now would be saved in', async () => {
		const host = makeHost({ recordingFormat: jest.fn(() => 'mp3') });

		await expect(run(host, '')).resolves.toBe(
			'Idle. A recording started now is saved as MP3.',
		);
	});

	/** A playback the host reports. */
	const playing = (overrides: Partial<CliPlayback> = {}): CliPlayback => ({
		recordingPath: 'Recordings/standup.webm',
		currentTime: 83,
		duration: 600,
		paused: false,
		...overrides,
	});

	it.each([
		{
			name: 'a playback with its length',
			playback: playing(),
			line: 'Playing Recordings/standup.webm at 1:23 of 10:00.',
		},
		{
			name: 'a paused one',
			playback: playing({ paused: true }),
			line: 'Paused Recordings/standup.webm at 1:23 of 10:00.',
		},
		{
			name: 'one whose length is not known yet',
			playback: playing({ duration: 0 }),
			line: 'Playing Recordings/standup.webm at 1:23.',
		},
	])('adds $name to the state', async ({ playback, line }) => {
		const host = makeHost({ playback: jest.fn(() => playback) });

		await expect(run(host, '')).resolves.toBe(
			`Idle. A recording started now is saved as WEBM.\n${line}`,
		);
	});
});

describe('the recorder state in words', () => {
	it('reads the same for the status command and the actions', () => {
		expect(describeRecordingStatus(RecordingStatus.Paused, 'wav')).toBe(
			'Recording, paused.',
		);
	});
});

describe('the record command', () => {
	it('starts a recording and reports the state it left behind', async () => {
		const status = jest
			.fn()
			.mockReturnValueOnce(RecordingStatus.Idle)
			.mockReturnValue(RecordingStatus.Recording);
		const host = makeHost({ recordingStatus: status });

		await expect(run(host, 'record')).resolves.toBe('Recording.');
		expect(host.startRecording).toHaveBeenCalledTimes(1);
	});

	it('answers with the reason a start failed, not with the state', async () => {
		// Nobody is looking at the Notice the recorder shows; a script reads
		// this line, and "Idle." would read as success.
		const host = makeHost({
			startRecording: jest
				.fn()
				.mockResolvedValue(
					'Microphone access denied. Please grant permission in browser settings.',
				),
		});

		await expect(run(host, 'record')).resolves.toBe(
			'Microphone access denied. Please grant permission in browser settings.',
		);
	});

	it('starts nothing while a recording is already running', async () => {
		const host = makeHost({
			recordingStatus: jest.fn(() => RecordingStatus.Recording),
		});

		await expect(run(host, 'record')).resolves.toBe('Recording.');
		expect(host.startRecording).not.toHaveBeenCalled();
	});
});

describe('the stop command', () => {
	it('stops the recording in progress', async () => {
		const status = jest
			.fn()
			.mockReturnValueOnce(RecordingStatus.Recording)
			.mockReturnValue(RecordingStatus.Saving);
		const host = makeHost({ recordingStatus: status });

		await expect(run(host, 'stop')).resolves.toBe(
			'Saving the recording that just stopped.',
		);
		expect(host.stopRecording).toHaveBeenCalledTimes(1);
	});

	it('answers with the reason a stop failed', async () => {
		const host = makeHost({
			recordingStatus: jest.fn(() => RecordingStatus.Recording),
			stopRecording: jest
				.fn()
				.mockResolvedValue('Error stopping recording: disk full'),
		});

		await expect(run(host, 'stop')).resolves.toBe(
			'Error stopping recording: disk full',
		);
	});

	it('says so when there is nothing to stop', async () => {
		const host = makeHost();

		await expect(run(host, 'stop')).resolves.toBe('Nothing is recording.');
		expect(host.stopRecording).not.toHaveBeenCalled();
	});
});

describe('registerCliCommands', () => {
	/**
	 * A plugin whose CLI registration is whatever a test hands it.
	 * @param registerCliHandler - The registration method, or nothing
	 */
	const pluginWith = (registerCliHandler?: unknown): Plugin =>
		partial<Plugin>({
			manifest: partial({ id: PLUGIN_ID }),
			...(registerCliHandler === undefined ? {} : { registerCliHandler }),
		});

	it('registers every command with the app', () => {
		const registerCliHandler = jest.fn();
		const commands = cliCommands(makeHost(), PLUGIN_ID);

		expect(
			registerCliCommands(pluginWith(registerCliHandler), commands),
		).toBe(true);
		expect(registerCliHandler.mock.calls).toEqual(
			commands.map((command) => [
				command.id,
				command.description,
				command.flags,
				command.handler,
			]),
		);
	});

	it('reports a build with no command line to register with', () => {
		// The platforms that have no CLI at all.
		expect(
			registerCliCommands(
				pluginWith(),
				cliCommands(makeHost(), PLUGIN_ID),
			),
		).toBe(false);
	});

	it('survives a registration the app refuses', () => {
		const warn = jest.spyOn(console, 'warn').mockImplementation(() => {
			/* the message is the point, not the output */
		});
		const registerCliHandler = jest.fn(() => {
			throw new Error('Command already registered');
		});

		expect(
			registerCliCommands(
				pluginWith(registerCliHandler),
				cliCommands(makeHost(), PLUGIN_ID),
			),
		).toBe(false);
		expect(warn).toHaveBeenCalledWith(
			`[AudioRecorder] CLI command ${PLUGIN_ID} was not registered:`,
			expect.any(Error),
		);
	});

	it('keeps registering the commands after one the app refuses', () => {
		// Another plugin owning one id must not take every command after it
		// off the command line.
		jest.spyOn(console, 'warn').mockImplementation(() => {
			/* the registrations are the point, not the output */
		});
		const commands = cliCommands(makeHost(), PLUGIN_ID);
		const refused = commands[1]?.id;
		const registered: string[] = [];
		const registerCliHandler = jest.fn((id: string) => {
			if (id === refused) {
				throw new Error('Command already registered');
			}
			registered.push(id);
		});

		expect(
			registerCliCommands(pluginWith(registerCliHandler), commands),
		).toBe(false);
		expect(registered).toEqual(
			commands
				.map((command) => command.id)
				.filter((id) => id !== refused),
		);
	});
});
