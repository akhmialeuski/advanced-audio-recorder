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
 * @module actions/recordingTargets
 */

import { getLinkpath, MarkdownView, TFile } from 'obsidian';
import type { App, CliData, CliFlags } from 'obsidian';
import { isAudioFile } from '../utils/audioFile';
import { linkAtCursor } from '../obsidian/linkAtCursor';
import {
	cliFlag,
	cliText,
	flagParam,
	isRefusal,
	valueParam,
	type CliRead,
} from '../obsidian/cliArgs';
import type { ActionServices, FileContext, LinkLocation } from './PluginAction';

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
 * Every recording a note links or embeds, in the order the note mentions
 * them, each once. A transcript links its recording on every line, which is
 * why repeats are folded rather than listed.
 * @param app - Obsidian App
 * @param note - The note to read
 * @returns The recordings, in document order
 */
export function recordingsInNote(app: App, note: TFile): TFile[] {
	const cache = app.metadataCache.getFileCache(note);
	const references = [...(cache?.links ?? []), ...(cache?.embeds ?? [])].sort(
		(a, b) => a.position.start.offset - b.position.start.offset,
	);
	const recordings = new Map<string, TFile>();
	// A transcript links its recording once per line, each a different
	// moment of the same file, so each link path is resolved only once.
	const resolved = new Map<string, TFile | null>();
	for (const reference of references) {
		const linkpath = getLinkpath(reference.link);
		let file = resolved.get(linkpath);
		if (file === undefined) {
			file = app.metadataCache.getFirstLinkpathDest(linkpath, note.path);
			resolved.set(linkpath, file);
		}
		if (file && isAudioFile(file) && !recordings.has(file.path)) {
			recordings.set(file.path, file);
		}
	}
	return [...recordings.values()];
}

/**
 * The file a `file=` or `path=` parameter names. `file=` takes an exact path
 * too, since that is what a script most often has at hand and what this
 * plugin's command line took before it followed the Obsidian convention.
 * @param app - Obsidian App
 * @param args - The arguments as typed
 * @returns The file, null when neither parameter was given, or the refusal
 */
export function namedVaultFile(app: App, args: CliData): CliRead<TFile | null> {
	const path = cliText(args, PATH_PARAM);
	if (path !== null) {
		const file = app.vault.getFileByPath(path);
		return file
			? { value: file }
			: { refusal: `No file at "${path}" in this vault.` };
	}
	const name = cliText(args, FILE_PARAM);
	if (name === null) {
		return { value: null };
	}
	const file =
		app.vault.getFileByPath(name) ??
		app.metadataCache.getFirstLinkpathDest(name, '');
	return file
		? { value: file }
		: { refusal: `No file named "${name}" in this vault.` };
}

/**
 * The note a `note=` parameter names, for a recording named directly.
 * @param app - Obsidian App
 * @param args - The arguments as typed
 * @returns The note, null when not given, or the refusal
 */
function namedNote(app: App, args: CliData): CliRead<TFile | null> {
	const name = cliText(args, NOTE_PARAM);
	if (name === null) {
		return { value: null };
	}
	const note =
		app.vault.getFileByPath(name) ??
		app.metadataCache.getFirstLinkpathDest(name, '');
	return note?.extension === 'md'
		? { value: note }
		: { refusal: `No note named "${name}" in this vault.` };
}

/**
 * The recording under the cursor of the active editor, when the note in it
 * is the given one, with the link the cursor stands on: a link to the whole
 * recording or, as a transcript line carries, to a moment of it.
 * @param app - Obsidian App
 * @param note - The active note
 */
function recordingUnderCursor(
	app: App,
	note: TFile,
): { file: TFile; link: LinkLocation } | null {
	const view = app.workspace.getActiveViewOfType(MarkdownView);
	const editor = view?.file === note ? view.editor : null;
	if (!editor) {
		return null;
	}
	const cursor = editor.getCursor();
	const link = linkAtCursor(editor.getLine(cursor.line), cursor.ch);
	if (!link) {
		return null;
	}
	const file = app.metadataCache.getFirstLinkpathDest(
		getLinkpath(link.path),
		note.path,
	);
	return file && isAudioFile(file)
		? {
				file,
				link: {
					editor,
					line: cursor.line,
					start: link.start,
					end: link.end,
				},
			}
		: null;
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
	const underCursor = recordingUnderCursor(app, active);
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

/**
 * The recordings of a note the command line asked for.
 * @param services - Injected services
 * @param note - The note
 * @param args - The arguments as typed
 */
function recordingsOfNote(
	services: ActionServices,
	note: TFile,
	args: CliData,
): FileContext[] | string {
	const recordings = recordingsInNote(services.app, note);
	if (recordings.length === 0) {
		return `${note.path} links no recording.`;
	}
	const toContexts = (files: readonly TFile[]): FileContext[] =>
		files.map((file) => ({ file, note, services, named: true }));
	const name = cliText(args, RECORDING_PARAM);
	if (name !== null) {
		const picked = pickRecording(services.app, note, recordings, name);
		return picked
			? toContexts([picked])
			: `${note.path} links no recording named "${name}". It links: ${listed(recordings)}.`;
	}
	if (recordings.length === 1 || cliFlag(args, ALL_FLAG)) {
		return toContexts(recordings);
	}
	return `${note.path} links ${String(recordings.length)} recordings: ${listed(recordings)}. Name one with ${RECORDING_PARAM}=<name>, or add ${ALL_FLAG} to run on each.`;
}

/**
 * The recordings a command line names: a recording directly, or the
 * recordings of a note, with the active file standing in when nothing is
 * named, as every Obsidian command does.
 * @param services - Injected services
 * @param args - The arguments as typed
 * @returns The targets, or the sentence saying why there are none
 */
export function namedRecordings(
	services: ActionServices,
	args: CliData,
): FileContext[] | string {
	const named = namedVaultFile(services.app, args);
	if (isRefusal(named)) {
		return named.refusal;
	}
	const target = named.value ?? services.app.workspace.getActiveFile();
	if (!target) {
		return `Name a recording or a note with ${FILE_PARAM}=<name> or ${PATH_PARAM}=<vault path>, or open one in Obsidian.`;
	}
	if (isAudioFile(target)) {
		if (cliText(args, RECORDING_PARAM) !== null) {
			return `${RECORDING_PARAM}= picks a recording of a note, and ${target.path} is a recording itself.`;
		}
		const note = namedNote(services.app, args);
		if (isRefusal(note)) {
			return note.refusal;
		}
		// What a command does to the note - writes a transcript into it,
		// removes links from it - is only right for a note of this recording.
		if (
			note.value &&
			!recordingsInNote(services.app, note.value).includes(target)
		) {
			return `${note.value.path} does not link ${target.path}. Name the note the recording belongs to.`;
		}
		return [
			note.value
				? { file: target, note: note.value, services, named: true }
				: { file: target, services, named: true },
		];
	}
	if (target.extension !== 'md') {
		return `${target.path} is neither a recording nor a note.`;
	}
	if (cliText(args, NOTE_PARAM) !== null) {
		return `${NOTE_PARAM}= names the note of a recording, and ${target.path} is a note itself.`;
	}
	return recordingsOfNote(services, target, args);
}

/**
 * Names a recording target in a picker row or an answer.
 * @param context - The target
 */
export function describeRecording(context: FileContext): string {
	return context.file.path;
}
