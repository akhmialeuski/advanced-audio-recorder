/**
 * The plugin as the Obsidian CLI reaches it.
 *
 * From 1.12.2 a plugin can answer commands typed at the desktop app's command
 * line, which is a surface with rules of its own: a handler is called with no
 * user in front of it, it answers with text rather than by opening something,
 * and its id is global across every installed plugin - hence the
 * `<plugin-id>` and `<plugin-id>:<action>` naming Obsidian asks for.
 *
 * Most commands are not written here: every plugin action becomes one through
 * the action registry, the same way it becomes a palette command. What is
 * written here is what has no action behind it - the recorder's state, and an
 * explicit start and stop, which a script needs where a toggle would leave it
 * guessing which way it went. What a handler may decide is decided over a
 * port of a few questions, so the shape of an answer is testable without a
 * plugin, an app, or a recorder behind it.
 *
 * Nothing here is reachable on mobile, where the registration method does not
 * exist; {@link registerCliCommands} reports that rather than failing the
 * load.
 * @module obsidian/cliCommands
 */

import type { CliFlags, CliHandler, Plugin } from 'obsidian';
import { RecordingStatus } from '../types';
import { PLUGIN_LOG_PREFIX } from '../constants';
import { formatTimecode } from '../utils/TimeUtils';
import { cliFlag, flagParam, WAIT_FLAG } from './cliArgs';

/** The playback the state command reports, when something plays. */
export interface CliPlayback {
	/** Vault path of the recording. */
	readonly recordingPath: string;
	/** Position, in seconds. */
	readonly currentTime: number;
	/** Length in seconds, or zero while unknown. */
	readonly duration: number;
	/** Whether it is paused. */
	readonly paused: boolean;
}

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
	 * Stops the session in progress and queues its save.
	 * @param untilSaved - Waits for the file to be written as well
	 * @returns The reason the stop, or with `untilSaved` the save, did not
	 *   complete, or null once it has
	 */
	stopRecording(untilSaved: boolean): Promise<string | null>;
	/** How many stopped recordings are being saved or wait to be. */
	recordingSaves(): number;
	/** The format a session started now would be saved in. */
	recordingFormat(): string;
	/** The playback running in the app, or null while nothing plays. */
	playback(): CliPlayback | null;
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

/**
 * What the recorder is doing, in one line: the capture, then the saves of
 * recordings stopped before it, which run in the background.
 * @param status - The recording state
 * @param format - The format a recording started now is saved in
 * @param saves - How many stopped recordings are being saved or wait to be
 */
export function describeRecordingStatus(
	status: RecordingStatus,
	format: string,
	saves: number,
): string {
	const capture = describeCapture(status, format);
	if (saves === 0) {
		return capture;
	}
	return saves === 1
		? `${capture} One stopped recording is still being saved.`
		: `${capture} ${String(saves)} stopped recordings are still being saved.`;
}

/**
 * What the capture is doing, in one sentence.
 * @param status - The recording state
 * @param format - The format a recording started now is saved in
 */
function describeCapture(status: RecordingStatus, format: string): string {
	switch (status) {
		case RecordingStatus.Recording:
			return 'Recording.';
		case RecordingStatus.Paused:
			return 'Recording, paused.';
		case RecordingStatus.Interrupted:
			return 'The input device was lost; saving what was recorded.';
		case RecordingStatus.Saving:
			return 'Saving the recording that just stopped.';
		default:
			return `Idle. A recording started now is saved as ${format.toUpperCase()}.`;
	}
}

/**
 * What the recorder is doing, in one line, for the host.
 * @param host - The plugin behind the CLI
 */
function statusLine(host: CliHost): string {
	return describeRecordingStatus(
		host.recordingStatus(),
		host.recordingFormat(),
		host.recordingSaves(),
	);
}

/**
 * What is playing, in one line, or nothing while nothing plays.
 * @param playback - The playback
 */
function playbackLine(playback: CliPlayback | null): string[] {
	if (!playback) {
		return [];
	}
	const length =
		playback.duration > 0 ? ` of ${formatTimecode(playback.duration)}` : '';
	return [
		`${playback.paused ? 'Paused' : 'Playing'} ${playback.recordingPath} at ${formatTimecode(playback.currentTime, playback.duration)}${length}.`,
	];
}

/**
 * The commands of the command line that have no action behind them.
 * @param host - The plugin behind the CLI
 * @param pluginId - The plugin's own id, which every command is named under
 * @returns The commands, in the order they are registered
 */
export function cliCommands(host: CliHost, pluginId: string): CliCommand[] {
	return [
		{
			id: pluginId,
			description:
				'Report what the audio recorder is doing, and what is playing.',
			flags: null,
			handler: (): string =>
				[statusLine(host), ...playbackLine(host.playback())].join('\n'),
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
			description:
				'Stop the recording in progress and save it in the background.',
			flags: {
				[WAIT_FLAG]: flagParam(
					'Answer once the recording is saved, not once its save is queued.',
				),
			},
			// Answers once the save is queued, because the recorder is free
			// from that moment and a script starting the next recording needs
			// nothing more. A script that goes on to read the file waits.
			handler: async (args): Promise<string> => {
				if (host.recordingStatus() === RecordingStatus.Idle) {
					return 'Nothing is recording.';
				}
				const failure = await host.stopRecording(
					cliFlag(args, WAIT_FLAG),
				);
				return failure ?? statusLine(host);
			},
		},
	];
}

/**
 * Registers the CLI commands, where the running Obsidian has a CLI at all.
 *
 * Two commands of one id cannot reach here, since the action registry refuses
 * the second when it is added. A registration the host still refuses, a clash
 * with another plugin's command for one, is reported rather than allowed to
 * fail `onload`: the CLI is a convenience, and a plugin that refuses to load
 * over one is not. Each command is registered on its own, so one refused
 * command leaves every other one reachable.
 * @param plugin - The plugin registering them
 * @param commands - Every command, the plugin's own and its actions'
 * @returns Whether every command was registered
 */
export function registerCliCommands(
	plugin: Plugin,
	commands: readonly CliCommand[],
): boolean {
	// The typings declare the method on every platform, but only the desktop
	// app has a command line, so the method is asked for rather than assumed.
	if (
		typeof (plugin as { registerCliHandler?: unknown })
			.registerCliHandler !== 'function'
	) {
		return false;
	}
	let registered = true;
	for (const command of commands) {
		try {
			plugin.registerCliHandler(
				command.id,
				command.description,
				command.flags,
				command.handler,
			);
		} catch (error) {
			registered = false;
			console.warn(
				`${PLUGIN_LOG_PREFIX} CLI command ${command.id} was not registered:`,
				error,
			);
		}
	}
	return registered;
}
