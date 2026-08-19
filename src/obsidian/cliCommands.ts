/**
 * The plugin as the Obsidian CLI reaches it.
 *
 * From 1.12.2 a plugin can answer commands typed at the desktop app's command
 * line, which is a surface with rules of its own: a handler is called with no
 * user in front of it, it answers with one line of text rather than by opening
 * something, and its id is global across every installed plugin - hence the
 * `<plugin-id>` and `<plugin-id>:<action>` naming Obsidian asks for.
 *
 * The commands here are the two operations a recorder is scripted for - start
 * a recording, stop it - plus the state behind them and the one file job worth
 * starting from outside the vault. What a handler may decide is decided here,
 * over a port of four questions, so the shape of a CLI answer is testable
 * without a plugin, an app, or a recorder behind it.
 *
 * Nothing here is reachable below 1.12.2 or on mobile, where the registration
 * method does not exist; {@link registerCliCommands} reports that rather than
 * failing the load, since the plugin still supports 1.6.6.
 * @module obsidian/cliCommands
 */

import { requireApiVersion } from 'obsidian';
import type { CliData, CliFlags, CliHandler, Plugin, TFile } from 'obsidian';
import { RecordingStatus } from '../types';
import { PLUGIN_LOG_PREFIX } from '../constants';

/** What the CLI is allowed to ask of the plugin. */
export interface CliHost {
	/** The recording state, as the manager holds it. */
	recordingStatus(): RecordingStatus;
	/**
	 * Starts a recording session.
	 * @returns The reason it did not start, or null once it is recording
	 */
	startRecording(): Promise<string | null>;
	/**
	 * Stops the session in progress.
	 * @returns The reason the stop did not complete, or null once it has
	 */
	stopRecording(): Promise<string | null>;
	/**
	 * Why a transcription started now would be refused, or null when none
	 * would be: the feature switched off, an engine this device cannot run,
	 * or one that is not configured.
	 */
	transcriptionRefusal(): string | null;
	/** The format a session started now would be saved in. */
	recordingFormat(): string;
	/** The audio file at this path, or null where the vault holds none. */
	audioFileAt(path: string): TFile | null;
	/** Starts a transcription of that file, the way every other surface does. */
	transcribe(file: TFile): void;
}

/** One CLI command, as `registerCliHandler` takes it. */
export interface CliCommand {
	/** Globally unique id, which is what the user types. */
	readonly id: string;
	/** Line shown in the CLI's own help and completion. */
	readonly description: string;
	/** Flags it accepts, or null where it takes none. */
	readonly flags: CliFlags | null;
	/** What it does, and the line it answers with. */
	readonly handler: CliHandler;
}

/** The flag the transcribe command names its file with. */
const FILE_FLAG = 'file';

/**
 * What the recorder is doing, in one line.
 * @param host - The plugin behind the CLI
 */
function statusLine(host: CliHost): string {
	switch (host.recordingStatus()) {
		case RecordingStatus.Recording:
			return 'Recording.';
		case RecordingStatus.Paused:
			return 'Recording, paused.';
		case RecordingStatus.Saving:
			return 'Saving the recording that just stopped.';
		default:
			return `Idle. A recording started now is saved as ${host.recordingFormat().toUpperCase()}.`;
	}
}

/**
 * The file a `--file` flag names, or the reason it names none. A flag declared
 * with a value still arrives as `'true'` when it was typed without one, which
 * is a path no vault holds and a message the user can act on.
 * @param host - The plugin behind the CLI
 * @param params - The flags as typed
 */
function fileFrom(
	host: CliHost,
	params: CliData,
): { file: TFile } | { refusal: string } {
	const path = params[FILE_FLAG];
	if (path === undefined || path === 'true' || path.trim() === '') {
		return {
			refusal: `Name the file to transcribe: --${FILE_FLAG} <vault path>.`,
		};
	}
	const file = host.audioFileAt(path.trim());
	return file
		? { file }
		: { refusal: `No audio file at "${path.trim()}" in this vault.` };
}

/**
 * The commands this plugin answers on the command line.
 * @param host - The plugin behind the CLI
 * @param pluginId - The plugin's own id, which every command is named under
 * @returns The commands, in the order they are registered
 */
export function cliCommands(host: CliHost, pluginId: string): CliCommand[] {
	return [
		{
			id: pluginId,
			description: 'Report what the audio recorder is doing.',
			flags: null,
			handler: (): string => statusLine(host),
		},
		{
			id: `${pluginId}:record`,
			description:
				'Start recording with the configured input and format.',
			flags: null,
			handler: async (): Promise<string> => {
				if (host.recordingStatus() !== RecordingStatus.Idle) {
					return statusLine(host);
				}
				// A start that fails is reported by the recorder as a Notice
				// nobody at a terminal will see, so its reason is the answer:
				// the status alone would read as a cheerful idle line.
				const failure = await host.startRecording();
				return failure ?? statusLine(host);
			},
		},
		{
			id: `${pluginId}:stop`,
			description: 'Stop the recording in progress and save it.',
			flags: null,
			handler: async (): Promise<string> => {
				if (host.recordingStatus() === RecordingStatus.Idle) {
					return 'Nothing is recording.';
				}
				const failure = await host.stopRecording();
				return failure ?? statusLine(host);
			},
		},
		{
			id: `${pluginId}:transcribe`,
			description: 'Transcribe an audio file in the vault.',
			flags: {
				[FILE_FLAG]: {
					value: '<vault path>',
					description:
						'Path of the audio file, as the vault holds it.',
					required: true,
				},
			},
			handler: (params: CliData): string => {
				// Asked before the file, and before anything is opened: the
				// same conditions the run refuses on, so a job that cannot
				// work is answered with its reason rather than started. The
				// menu and the palette hide this action for the first of
				// them; a command line has nothing to hide, so it says so.
				const refusal = host.transcriptionRefusal();
				if (refusal) {
					return refusal;
				}
				const found = fileFrom(host, params);
				if ('refusal' in found) {
					return found.refusal;
				}
				host.transcribe(found.file);
				// The run itself is not awaited, and the answer says only what
				// happened here: transcription is a paid job that reports its
				// own progress and can be cancelled in the app, which is the
				// same bargain the transcribe-on-save path makes rather than a
				// silent background request.
				return `Started transcribing ${found.file.path} in Obsidian.`;
			},
		},
	];
}

/**
 * Registers the CLI commands, where the running Obsidian has a CLI at all.
 *
 * A registration that throws - which is what a duplicate id does - is reported
 * rather than allowed to fail `onload`: the CLI is a convenience, and a plugin
 * that refuses to load over one is not.
 * @param plugin - The plugin registering them
 * @param host - What the commands are allowed to ask of it
 * @returns Whether the commands were registered
 */
export function registerCliCommands(plugin: Plugin, host: CliHost): boolean {
	// Two questions, because the typings answer neither: the running app has
	// to be 1.12.2 or newer, where a plugin may register a CLI command at all,
	// and the platform has to be one that has a command line. The version is
	// spelled out rather than named, since it is also what the lint rule for
	// APIs above minAppVersion reads the guard from.
	if (
		requireApiVersion('1.12.2') &&
		typeof (plugin as { registerCliHandler?: unknown })
			.registerCliHandler === 'function'
	) {
		try {
			for (const command of cliCommands(host, plugin.manifest.id)) {
				plugin.registerCliHandler(
					command.id,
					command.description,
					command.flags,
					command.handler,
				);
			}
			return true;
		} catch (error) {
			// A duplicate id is the throwing case, and it is one this plugin
			// cannot resolve at load time. The CLI is a convenience; a plugin
			// that refuses to load over one is not.
			console.warn(
				`${PLUGIN_LOG_PREFIX} CLI commands were not registered:`,
				error,
			);
		}
	}
	return false;
}
