/**
 * Which recordings an action targets, found the same way on every surface.
 *
 * A recording is reached either directly - the audio file is the active pane,
 * or is named on the command line - or through a note: the note that links or
 * embeds it. Reaching it through a note is what lets the palette and the
 * command line work from where the user actually is, a meeting note with its
 * recording embedded, instead of only from the audio file opened on its own;
 * and it is what tells a transcript which note to go into.
 *
 * Naming follows the Obsidian command line: `file=` resolves a name the way a
 * wikilink does, `path=` takes the exact vault path, and with neither the
 * active file is used.
 * @module actions/file/recordingTargets
 */

import { getLinkpath, MarkdownView, normalizePath, TFile } from 'obsidian';
import type { App, CliData, CliFlags, Editor, EditorPosition } from 'obsidian';
import { isAudioFile } from '../../utils/audioFile';
import { linkAtColumn } from '../../obsidian/sourceLinks';
import { recordingsInNote } from '../../obsidian/noteRecordings';
import { hasTimecodeSubpath } from '../../player/timecodeLinks';
import {
	cliFlag,
	cliText,
	flagParam,
	valueParam,
} from '../../obsidian/cliArgs';
import type {
	ActionServices,
	FileContext,
	LinkLocation,
} from '../core/PluginAction';
import { isRefusal, type Refusable } from '../../utils/refusal';

/** Names a recording or a note by how a wikilink resolves it. */
export const FILE_PARAM = 'file';
/** Names a recording or a note by its exact vault path. */
export const PATH_PARAM = 'path';
/** Picks one recording of a note that links several. */
export const RECORDING_PARAM = 'recording';
/** Names the note a recording named directly belongs to. */
export const NOTE_PARAM = 'note';
/** Runs on every recording a note links. */
export const ALL_FLAG = 'all';

/** The parameters naming a single file, recording or note. */
export const FILE_TARGET_PARAMS: CliFlags = {
	[FILE_PARAM]: valueParam(
		'<name>',
		'Recording or note, resolved the way a wikilink is. Defaults to the active file.',
	),
	[PATH_PARAM]: valueParam(
		'<vault path>',
		'Recording or note, by its exact path from the vault root.',
	),
};

/** The parameters naming one recording, directly or through its note. */
export const SINGLE_RECORDING_PARAMS: CliFlags = {
	...FILE_TARGET_PARAMS,
	[RECORDING_PARAM]: valueParam(
		'<name>',
		'Which recording of the note, when it links several.',
	),
	[NOTE_PARAM]: valueParam(
		'<name>',
		'The note a recording belongs to, when file or path names the recording.',
	),
};

/** The parameters naming the recordings a file action runs on. */
export const RECORDING_TARGET_PARAMS: CliFlags = {
	...SINGLE_RECORDING_PARAMS,
	[ALL_FLAG]: flagParam('Run on every recording the note links.'),
};

/**
 * The file a `file=` or `path=` parameter names. `file=` takes an exact path
 * too, since that is what a script most often has at hand and what this
 * plugin's command line took before it followed the Obsidian convention.
 * @param app - Obsidian App
 * @param args - The arguments as typed
 * @returns The file, null when neither parameter was given, or the refusal
 */
export function namedVaultFile(
	app: App,
	args: CliData,
): Refusable<TFile | null> {
	const path = cliText(args, PATH_PARAM);
	if (path !== null) {
		const file = app.vault.getFileByPath(normalizePath(path));
		return file
			? { value: file }
			: { refusal: `No file at "${path}" in this vault.` };
	}
	const name = cliText(args, FILE_PARAM);
	if (name === null) {
		return { value: null };
	}
	const file = fileNamed(app, name);
	return file
		? { value: file }
		: { refusal: `No file named "${name}" in this vault.` };
}

/**
 * The file a name typed on the command line stands for: its exact vault path,
 * or else the file a wikilink of that text would open, as Obsidian's own
 * `file=` resolves. A heading or a moment after `#` is dropped, as a link
 * drops it to find its file.
 * @param app - Obsidian App
 * @param name - The name as typed
 */
function fileNamed(app: App, name: string): TFile | null {
	return (
		app.vault.getFileByPath(normalizePath(name)) ??
		app.metadataCache.getFirstLinkpathDest(getLinkpath(name), '')
	);
}

/**
 * The note a `note=` parameter names, for a recording named directly.
 * @param app - Obsidian App
 * @param args - The arguments as typed
 * @returns The note, null when not given, or the refusal
 */
function namedNote(app: App, args: CliData): Refusable<TFile | null> {
	const name = cliText(args, NOTE_PARAM);
	if (name === null) {
		return { value: null };
	}
	const note = fileNamed(app, name);
	return note?.extension === 'md'
		? { value: note }
		: { refusal: `No note named "${name}" in this vault.` };
}

/** A recording reached through a link in an editor. */
export interface RecordingLink {
	/** The recording the link resolves to. */
	readonly file: TFile;
	/** Where the link is. */
	readonly link: LinkLocation;
	/** Set when the link points at a moment of the recording. */
	readonly atMoment?: true;
}

/**
 * The recording a link at a position of an editor reaches: the one place the
 * editor menu, a player's menu and the palette read "the recording under the
 * cursor" from, a link to the whole recording or, as a transcript line
 * carries, to a moment of it.
 * @param app - Obsidian App
 * @param editor - The editor holding the line
 * @param position - The position, a cursor or a rendered embed's start
 * @param sourcePath - The note the link resolves from
 * @returns The recording and its link, or null when no link to a recording
 *   is there
 */
export function recordingLinkAt(
	app: App,
	editor: Editor,
	position: EditorPosition,
	sourcePath: string,
): RecordingLink | null {
	const link = linkAtColumn(editor.getLine(position.line), position.ch);
	const file = link
		? app.metadataCache.getFirstLinkpathDest(link.path, sourcePath)
		: null;
	if (!link || !file || !isAudioFile(file)) {
		return null;
	}
	return {
		file,
		link: {
			editor,
			subpath: link.subpath,
			line: position.line,
			start: link.start,
			end: link.end,
		},
		...(hasTimecodeSubpath(link.subpath)
			? { atMoment: true as const }
			: {}),
	};
}

/**
 * The recordings the palette acts on: the active audio file; or, in a note,
 * the recording under the cursor; or else every recording the note links,
 * for the picker to choose from.
 * @param services - Injected services every action shares
 * @returns The targets, empty when the active file is neither
 */
export function activeRecordings(services: ActionServices): FileContext[] {
	const { app } = services;
	const active = app.workspace.getActiveFile();
	if (!(active instanceof TFile)) {
		return [];
	}
	if (isAudioFile(active)) {
		return [{ file: active, services }];
	}
	if (active.extension !== 'md') {
		return [];
	}
	const view = app.workspace.getActiveViewOfType(MarkdownView);
	const underCursor =
		view?.file === active
			? recordingLinkAt(
					app,
					view.editor,
					view.editor.getCursor(),
					active.path,
				)
			: null;
	if (underCursor) {
		return [{ ...underCursor, note: active, services }];
	}
	return recordingsInNote(app, active).map((file) => ({
		file,
		note: active,
		services,
	}));
}

/**
 * Picks the one recording of a note that `recording=` names: matched the way
 * a link written in that note would resolve, or by file name or path.
 * @param app - Obsidian App
 * @param note - The note
 * @param recordings - The recordings it links
 * @param name - What was typed
 */
function pickRecording(
	app: App,
	note: TFile,
	recordings: readonly TFile[],
	name: string,
): TFile | undefined {
	const linked = app.metadataCache.getFirstLinkpathDest(name, note.path);
	return recordings.find(
		(file) =>
			file === linked ||
			file.path === name ||
			file.name === name ||
			file.basename === name,
	);
}

/**
 * Lists recordings for an answer.
 * @param recordings - The recordings
 */
function listed(recordings: readonly TFile[]): string {
	return recordings.map((file) => file.path).join(', ');
}

/** What a command that names recordings can run on. */
export interface RecordingReach {
	/**
	 * Whether it runs on every recording of a note, which is what `all` asks
	 * for. A command that acts at one place of one recording does not, takes
	 * no `all`, and so is never told to add it.
	 */
	readonly several: boolean;
}

/**
 * The recordings of a note the command line asked for.
 * @param services - Injected services
 * @param note - The note
 * @param args - The arguments as typed
 * @param reach - Whether the command runs on several recordings
 */
function recordingsOfNote(
	services: ActionServices,
	note: TFile,
	args: CliData,
	reach: RecordingReach,
): Refusable<FileContext[]> {
	const recordings = recordingsInNote(services.app, note);
	if (recordings.length === 0) {
		return { refusal: `${note.path} links no recording.` };
	}
	const toContexts = (files: readonly TFile[]): Refusable<FileContext[]> => ({
		value: files.map((file) => ({ file, note, services, noteFixed: true })),
	});
	const name = cliText(args, RECORDING_PARAM);
	if (name !== null) {
		const picked = pickRecording(services.app, note, recordings, name);
		return picked
			? toContexts([picked])
			: {
					refusal: `${note.path} links no recording named "${name}". It links: ${listed(recordings)}.`,
				};
	}
	if (recordings.length === 1 || cliFlag(args, ALL_FLAG)) {
		return toContexts(recordings);
	}
	const choose = reach.several
		? `Name one with ${RECORDING_PARAM}=<name>, or add ${ALL_FLAG} to run on each.`
		: `Name one with ${RECORDING_PARAM}=<name>.`;
	return {
		refusal: `${note.path} links ${String(recordings.length)} recordings: ${listed(recordings)}. ${choose}`,
	};
}

/**
 * The recordings a command line names: a recording directly, or the
 * recordings of a note, with the active file standing in when nothing is
 * named, as every Obsidian command does.
 * @param services - Injected services
 * @param args - The arguments as typed
 * @param reach - Whether the command runs on several recordings, as every
 *   file action does
 * @returns The targets, or the refusal saying why there are none
 */
export function namedRecordings(
	services: ActionServices,
	args: CliData,
	reach: RecordingReach = { several: true },
): Refusable<FileContext[]> {
	const named = namedVaultFile(services.app, args);
	if (isRefusal(named)) {
		return named;
	}
	const target = named.value ?? services.app.workspace.getActiveFile();
	if (!target) {
		return {
			refusal: `Name a recording or a note with ${FILE_PARAM}=<name> or ${PATH_PARAM}=<vault path>, or open one in Obsidian.`,
		};
	}
	if (isAudioFile(target)) {
		if (cliText(args, RECORDING_PARAM) !== null) {
			return {
				refusal: `${RECORDING_PARAM}= picks a recording of a note, and ${target.path} is a recording itself.`,
			};
		}
		const note = namedNote(services.app, args);
		if (isRefusal(note)) {
			return note;
		}
		// What a command does to the note - writes a transcript into it,
		// removes links from it - is only right for a note of this recording.
		if (
			note.value &&
			!recordingsInNote(services.app, note.value).includes(target)
		) {
			return {
				refusal: `${note.value.path} does not link ${target.path}. Name the note the recording belongs to.`,
			};
		}
		return {
			value: [
				note.value
					? {
							file: target,
							note: note.value,
							services,
							noteFixed: true,
						}
					: { file: target, services, noteFixed: true },
			],
		};
	}
	if (target.extension !== 'md') {
		return { refusal: `${target.path} is neither a recording nor a note.` };
	}
	if (cliText(args, NOTE_PARAM) !== null) {
		return {
			refusal: `${NOTE_PARAM}= names the note of a recording, and ${target.path} is a note itself.`,
		};
	}
	return recordingsOfNote(services, target, args, reach);
}

/**
 * Names a recording target in a picker row or an answer.
 * @param context - The target
 */
export function describeRecording(context: FileContext): string {
	return context.file.path;
}
