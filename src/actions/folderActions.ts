/**
 * Actions on a folder of recordings. A folder's menu offers them for the
 * folder that was right-clicked, the palette asks which folder, and the
 * command line takes the folder the way Obsidian's own commands do, as
 * `folder=<path>`.
 * @module actions/folderActions
 */

import { TFile, TFolder } from 'obsidian';
import type { App, CliData } from 'obsidian';
import { COMMAND_IDS } from '../constants';
import { isAudioFile } from '../utils/audioFile';
import { transcriptionRefusal } from '../settings/settingsAttention';
import { cliFlag, cliText, flagParam, valueParam } from '../obsidian/cliArgs';
import type {
	ActionFamily,
	ActionServices,
	FolderAction,
	FolderContext,
} from './PluginAction';

/** Names the folder on the command line. */
export const FOLDER_PARAM = 'folder';

/** Starts the queue once the folder is in it. */
export const START_FLAG = 'start';

/**
 * Queues a folder's recordings and answers with what was queued.
 * @param context - The folder
 * @param args - The arguments as typed
 * @returns The answer
 */
async function queueFolderFromCli(
	context: FolderContext,
	args: CliData,
): Promise<string> {
	const { folder, services } = context;
	// Asked before anything is queued: a queue that cannot run is a queue
	// that would only fail each recording in turn.
	const refusal = transcriptionRefusal(services.getSettings());
	if (refusal) {
		return refusal;
	}
	const { found, added } =
		await services.transcriptionQueue.enqueueFolder(folder);
	if (found === 0) {
		return `${describeFolder(context)} holds no recordings to transcribe.`;
	}
	const queued =
		added === 0
			? `Every recording in ${describeFolder(context)} is already in the queue.`
			: `Queued ${String(added)} of the ${String(found)} recordings in ${describeFolder(context)}.`;
	if (!cliFlag(args, START_FLAG)) {
		return `${queued} Start the queue with the queue command and ${START_FLAG}, or add ${START_FLAG} here.`;
	}
	services.transcriptionQueue.start();
	return `${queued} The queue is transcribing them in Obsidian.`;
}

/** Every action on a folder, in menu order. */
export const FOLDER_ACTIONS: readonly FolderAction[] = [
	{
		commandId: COMMAND_IDS.transcribeFolder,
		title: 'Transcribe every recording in a folder',
		menuTitle: 'Transcribe every recording in this folder',
		icon: 'list-plus',
		isAvailable: ({ services }: FolderContext): boolean =>
			services.getSettings().transcriptionEnabled,
		run: ({ folder, services }: FolderContext): Promise<void> =>
			services.transcriptionQueue.queueFolder(folder),
		cli: {
			name: 'transcribe-folder',
			description:
				'Add every recording in a folder, and its subfolders, to the transcription queue.',
			params: {
				[START_FLAG]: flagParam('Start transcribing them right away.'),
			},
			opensDialog: true,
			unavailable: (): string =>
				'Transcription is switched off in settings.',
			execute: queueFolderFromCli,
		},
	},
];

/**
 * Every folder holding a recording, itself or below it, in path order.
 * Derived from the vault's file list rather than walked folder by folder, so
 * the palette check costs one pass over the files however deep the vault is.
 * @param app - Obsidian App
 */
function foldersWithRecordings(app: App): TFolder[] {
	const folders = new Map<string, TFolder>();
	for (const file of app.vault.getFiles()) {
		if (!isAudioFile(file)) {
			continue;
		}
		for (let folder = file.parent; folder; folder = folder.parent) {
			folders.set(folder.path, folder);
		}
	}
	return [...folders.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * The folder the command line names, or the reason there is none.
 * @param services - Injected services
 * @param args - The arguments as typed
 */
function namedFolder(
	services: ActionServices,
	args: CliData,
): FolderContext[] | string {
	const path = cliText(args, FOLDER_PARAM);
	if (path === null) {
		return `Name the folder with ${FOLDER_PARAM}=<path>; ${FOLDER_PARAM}=/ is the whole vault.`;
	}
	const folder =
		path === '/'
			? services.app.vault.getRoot()
			: services.app.vault.getAbstractFileByPath(path);
	if (folder instanceof TFolder) {
		return [{ folder, services }];
	}
	return folder instanceof TFile
		? `${path} is a file, not a folder.`
		: `No folder at "${path}" in this vault.`;
}

/**
 * Names a folder in a picker row or an answer; the root has no path of its
 * own to show.
 * @param context - The folder
 */
function describeFolder({ folder }: FolderContext): string {
	return folder.isRoot() ? 'the whole vault' : folder.path;
}

/**
 * The folder actions as a family: the palette offers every folder that holds
 * a recording, the command line takes the folder it names.
 * @param services - Injected services every action shares
 * @returns The family
 */
export function folderActionFamily(
	services: ActionServices,
): ActionFamily<FolderContext> {
	return {
		actions: FOLDER_ACTIONS,
		activeTargets: () =>
			foldersWithRecordings(services.app).map((folder) => ({
				folder,
				services,
			})),
		cliTarget: {
			params: {
				[FOLDER_PARAM]: valueParam(
					'<path>',
					'The folder, from the vault root; / is the whole vault.',
				),
			},
			resolve: (args) => namedFolder(services, args),
		},
		describe: describeFolder,
	};
}
