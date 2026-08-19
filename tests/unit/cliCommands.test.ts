/**
 * Tests the commands the plugin answers on the desktop command line: what each
 * one decides before it touches the recorder, and the line it answers with.
 * @module tests/unit/cliCommands.test
 */

import {
	cliCommands,
	registerCliCommands,
	type CliHost,
} from 'src/obsidian/cliCommands';
import { RecordingStatus } from 'src/types';
import type { CliData, Plugin, TFile } from 'obsidian';
import { partial } from '../helpers/doubles';

const PLUGIN_ID = 'advanced-audio-recorder';

/** A host whose every answer is a spy, over the state a test pins. */
function makeHost(overrides: Partial<CliHost> = {}): CliHost {
	return {
		recordingStatus: jest.fn(() => RecordingStatus.Idle),
		startRecording: jest.fn().mockResolvedValue(null),
		stopRecording: jest.fn().mockResolvedValue(null),
		recordingFormat: jest.fn(() => 'webm'),
		transcriptionRefusal: jest.fn(() => null),
		audioFileAt: jest.fn(() => null),
		transcribe: jest.fn(),
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

/** An audio file at a path, as the vault would hand it over. */
const fileAt = (path: string): TFile => partial<TFile>({ path });

describe('the command set', () => {
	it('names every command under the plugin id, as Obsidian asks', () => {
		// The ids are global across every installed plugin.
		expect(cliCommands(makeHost(), PLUGIN_ID).map((c) => c.id)).toEqual([
			PLUGIN_ID,
			`${PLUGIN_ID}:record`,
			`${PLUGIN_ID}:stop`,
			`${PLUGIN_ID}:transcribe`,
		]);
	});

	it('describes each command for the help output', () => {
		for (const command of cliCommands(makeHost(), PLUGIN_ID)) {
			expect(command.description).not.toBe('');
		}
	});

	it('declares the file flag transcribe cannot run without', () => {
		const transcribe = cliCommands(makeHost(), PLUGIN_ID)[3];

		expect(transcribe?.flags).toEqual({
			file: expect.objectContaining({ required: true }),
		});
	});
});

describe('the status command', () => {
	it.each([
		[RecordingStatus.Recording, 'Recording.'],
		[RecordingStatus.Paused, 'Recording, paused.'],
		[RecordingStatus.Saving, 'Saving the recording that just stopped.'],
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

describe('the transcribe command', () => {
	it('transcribes the file the flag names', async () => {
		const file = fileAt('recordings/standup.webm');
		const host = makeHost({ audioFileAt: jest.fn(() => file) });

		await expect(
			run(host, 'transcribe', { file: 'recordings/standup.webm' }),
		).resolves.toBe(
			'Started transcribing recordings/standup.webm in Obsidian.',
		);
		expect(host.transcribe).toHaveBeenCalledWith(file);
	});

	it('looks the path up as typed, minus the spaces around it', async () => {
		const host = makeHost({ audioFileAt: jest.fn(() => fileAt('a.webm')) });

		await run(host, 'transcribe', { file: '  a.webm  ' });

		expect(host.audioFileAt).toHaveBeenCalledWith('a.webm');
	});

	it.each([
		['no flag at all', {}],
		// A flag declared with a value still arrives as 'true' when it was
		// typed without one.
		['a flag typed without its value', { file: 'true' }],
		['a blank path', { file: '   ' }],
	])('asks for the path given %s', async (_case, params) => {
		const host = makeHost();

		await expect(run(host, 'transcribe', params)).resolves.toBe(
			'Name the file to transcribe: --file <vault path>.',
		);
		expect(host.transcribe).not.toHaveBeenCalled();
	});

	it('refuses before opening anything when a run would be refused', async () => {
		// The menu and the palette hide this action while transcription is
		// off; a command line has nothing to hide, so it says why.
		const host = makeHost({
			transcriptionRefusal: jest.fn(
				() => 'Transcription is switched off in settings.',
			),
			audioFileAt: jest.fn(() => fileAt('a.webm')),
		});

		await expect(run(host, 'transcribe', { file: 'a.webm' })).resolves.toBe(
			'Transcription is switched off in settings.',
		);
		expect(host.transcribe).not.toHaveBeenCalled();
		expect(host.audioFileAt).not.toHaveBeenCalled();
	});

	it('says so when the vault holds no audio file there', async () => {
		const host = makeHost();

		await expect(
			run(host, 'transcribe', { file: 'notes/agenda.md' }),
		).resolves.toBe('No audio file at "notes/agenda.md" in this vault.');
		expect(host.transcribe).not.toHaveBeenCalled();
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

		expect(
			registerCliCommands(pluginWith(registerCliHandler), makeHost()),
		).toBe(true);
		expect(registerCliHandler).toHaveBeenCalledTimes(4);
		expect(registerCliHandler.mock.calls.map((call) => call[0])).toEqual([
			PLUGIN_ID,
			`${PLUGIN_ID}:record`,
			`${PLUGIN_ID}:stop`,
			`${PLUGIN_ID}:transcribe`,
		]);
	});

	it('reports a build with no command line to register with', () => {
		// Below 1.12.2, and on the platforms that have no CLI at all.
		expect(registerCliCommands(pluginWith(), makeHost())).toBe(false);
	});

	it('survives a registration that throws, which a duplicate id does', () => {
		const warn = jest.spyOn(console, 'warn').mockImplementation(() => {
			/* the message is the point, not the output */
		});
		const registerCliHandler = jest.fn(() => {
			throw new Error('Command already registered');
		});

		expect(
			registerCliCommands(pluginWith(registerCliHandler), makeHost()),
		).toBe(false);
		expect(warn).toHaveBeenCalled();
	});
});
