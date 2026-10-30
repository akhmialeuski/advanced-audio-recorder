/**
 * The per-file actions offered by the plugin, defined once. The context
 * menus render this list, the palette registers it as commands, and the
 * command line answers it, so a feature added here appears in every surface
 * (and becomes hotkey-assignable) automatically.
 * @module actions/file/fileActions
 */

import { Notice } from 'obsidian';
import { COMMAND_IDS, PLUGIN_LOG_PREFIX } from '../../constants';
import { getAudioFileInfo } from '../../utils/AudioFileAnalyzer';
import { AudioFileInfoModal } from '../../ui/AudioFileInfoModal';
import { ConversionModal } from '../../ui/ConversionModal';
import { SplitModal } from '../../ui/SplitModal';
import { TranscriptionModal } from '../../ui/TranscriptionModal';
import { SpeakerRenameModal } from '../../ui/SpeakerRenameModal';
import { ChapterGenerationModal } from '../../ui/ChapterGenerationModal';
import { ChapterExportModal } from '../../ui/ChapterExportModal';
import type { PlayerMarker } from '../../markers/markerModel';
import { timecodeLinkBuilder } from '../../obsidian/timecodeRefs';
import { AudioProcessingModal } from '../../cleanup/AudioProcessingModal';
import { insertProcessedAudioEmbed } from '../../recording/NoteInserter';
import type { ActionFamily } from '../core/PluginAction';
import type { ActionServices } from '../core/actionServices';
import type { FileAction, FileContext } from './FileContext';
import {
	activeRecordings,
	describeRecording,
	namedRecordings,
	RECORDING_TARGET_PARAMS,
} from './recordingTargets';
import {
	CLEANUP_PARAMS,
	cleanupFromCli,
	CONVERT_PARAMS,
	convertFromCli,
	INFO_PARAMS,
	infoFromCli,
	SPLIT_PARAMS,
	splitFromCli,
} from './audioJobsCli';
import { TRANSCRIBE_PARAMS, transcribeFromCli } from './transcribeCli';
import { WAIT_FLAG } from '../../obsidian/cliArgs';
import { SPEAKER_PARAMS, speakersFromCli } from './speakersCli';
import {
	CHAPTER_PARAMS,
	deleteRecordingWithLink,
	EXPORT_PARAMS,
	exportChaptersFromCli,
	generateChaptersFromCli,
	retryFailedParts,
} from './recordingEdits';

/** Availability gate for actions with no extra conditions. */
const always = (): boolean => true;

/** Availability gate for the actions that need transcription switched on. */
const whileTranscribing = ({ services }: FileContext): boolean =>
	services.getSettings().transcriptionEnabled;

/** What the command line says when transcription is switched off. */
const transcriptionOff = (): string =>
	'Transcription is switched off in settings.';

/**
 * All per-file actions in menu order: info, convert, split, clean up,
 * transcribe, rename speakers, generate chapters, export, and the two
 * deletes. "Delete recording" is excluded from the editor menu, which offers
 * the link-aware delete instead; that one needs the note the recording was
 * reached through, so the file explorer, which has none, never offers it.
 */
export const FILE_ACTIONS: readonly FileAction[] = [
	{
		commandId: COMMAND_IDS.audioFileInfo,
		title: 'Audio file info',
		icon: 'info',
		isAvailable: always,
		run: async ({ file, services }: FileContext): Promise<void> => {
			const info = await getAudioFileInfo(services.app, file);
			if (info) {
				new AudioFileInfoModal(services.app, info).open();
			}
		},
		cli: {
			name: 'info',
			description: 'Report the properties of a recording.',
			params: INFO_PARAMS,
			opensDialog: true,
			execute: infoFromCli,
		},
	},
	{
		commandId: COMMAND_IDS.convertAudioFormat,
		title: 'Convert audio format',
		icon: 'file-audio',
		isAvailable: always,
		run: ({ file, services }: FileContext): void => {
			new ConversionModal(services.app, file, services.getSettings, {
				onConverted: (convertedPath) => {
					// The note link is already rewritten by the conversion's
					// linkAction; prime the converted file so its embed
					// becomes the enhanced player at once.
					services.primeForEnhancement([convertedPath]);
				},
				getWorkerClient: services.getWorkerClient,
			}).open();
		},
		cli: {
			name: 'convert',
			description: 'Convert a recording to another format.',
			params: CONVERT_PARAMS,
			opensDialog: true,
			execute: convertFromCli,
		},
	},
	{
		commandId: COMMAND_IDS.splitAudio,
		title: 'Split audio into parts',
		icon: 'scissors',
		isAvailable: always,
		run: ({ file, services }: FileContext): void => {
			new SplitModal(
				services.app,
				file,
				services.getSettings,
				services.recordingSidecar,
			).open();
		},
		cli: {
			name: 'split',
			description:
				'Split a recording into parts of a fixed length or at its chapters.',
			params: SPLIT_PARAMS,
			opensDialog: true,
			execute: splitFromCli,
		},
	},
	{
		commandId: COMMAND_IDS.cleanupAudio,
		title: 'Clean up audio',
		icon: 'wand-2',
		isAvailable: always,
		run: ({ file, services, origin }: FileContext): void => {
			new AudioProcessingModal(
				services.app,
				file,
				services.getSettings,
				async ({ outputPath, replaceSource }) => {
					// Link the result into the note (replace the source embed
					// when it is being deleted, else insert after), then prime
					// it so the enhanced player applies at once.
					await insertProcessedAudioEmbed(
						services.app,
						file,
						outputPath,
						replaceSource,
						// Undefined lets the inserter take the active note.
						origin.noteForDialog(),
					);
					services.primeForEnhancement([outputPath]);
				},
			).open();
		},
		cli: {
			name: 'cleanup',
			description:
				'Write a cleaned-up WAV copy of a recording: high-pass, noise gate, leveling.',
			params: CLEANUP_PARAMS,
			opensDialog: true,
			execute: cleanupFromCli,
		},
	},
	{
		commandId: COMMAND_IDS.transcribeAudio,
		title: 'Transcribe audio',
		icon: 'captions',
		isAvailable: whileTranscribing,
		run: ({ file, services, origin }: FileContext): void => {
			const note = origin.noteForDialog();
			new TranscriptionModal(services.app, file, services.getSettings, {
				...services.createTranscriptionModalOptions(),
				// Undefined lets the dialog take the active note.
				notePath: note === null ? '' : note?.path,
			}).open();
		},
		cli: {
			name: 'transcribe',
			description:
				'Transcribe a recording in Obsidian, into the note it belongs to.',
			params: TRANSCRIBE_PARAMS,
			waitFlag: WAIT_FLAG,
			opensDialog: true,
			unavailable: transcriptionOff,
			execute: transcribeFromCli,
		},
	},
	{
		commandId: COMMAND_IDS.retryFailedParts,
		title: 'Transcribe the parts that failed',
		icon: 'refresh-cw',
		isAvailable: whileTranscribing,
		run: async ({ file, services }: FileContext): Promise<void> => {
			new Notice(await retryFailedParts(file, services));
		},
		cli: {
			name: 'retry-failed',
			description:
				'Transcribe again the parts of a recording the engine failed on.',
			unavailable: transcriptionOff,
			execute: ({ file, services }: FileContext): Promise<string> =>
				retryFailedParts(file, services),
		},
	},
	{
		commandId: COMMAND_IDS.renameSpeakers,
		title: 'Rename speakers',
		icon: 'users',
		isAvailable: ({ services }: FileContext): boolean =>
			services.getSettings().transcriptionSpeakerRenameEnabled,
		run: ({ file, services }: FileContext): void => {
			new SpeakerRenameModal(services.app, file, {
				getSettings: services.getSettings,
				saveSettings: services.saveSettings,
				sidecar: services.recordingSidecar,
			}).open();
		},
		cli: {
			name: 'speakers',
			description:
				'List the speakers of a recording, or rename them in every transcript.',
			params: SPEAKER_PARAMS,
			opensDialog: true,
			unavailable: (): string =>
				'Rename speakers is switched off in settings.',
			execute: speakersFromCli,
		},
	},
	{
		commandId: COMMAND_IDS.generateChapters,
		title: 'Generate chapters from transcript',
		icon: 'sparkles',
		isAvailable: ({ services }: FileContext): boolean =>
			services.getSettings().transcriptionAutoChaptersEnabled,
		run: ({ file, services }: FileContext): void => {
			// Open the dialog to pick the guidance profile and see the cost
			// estimate before the run; it delegates to the shared service.
			new ChapterGenerationModal(services.app, file, {
				getSettings: services.getSettings,
				saveSettings: services.saveSettings,
				autoChapters: services.autoChapters,
				sidecar: services.recordingSidecar,
			}).open();
		},
		cli: {
			name: 'chapters',
			description:
				'Generate the chapters of a recording from its transcript with an LLM.',
			params: CHAPTER_PARAMS,
			opensDialog: true,
			unavailable: (): string =>
				'Auto chapters are switched off in settings.',
			execute: generateChaptersFromCli,
		},
	},
	{
		commandId: COMMAND_IDS.exportChapters,
		title: 'Export chapters and markers',
		icon: 'file-output',
		// Whether the recording has markers needs a sidecar read, and
		// availability is decided synchronously; the dialog reads them and
		// says so when there are none.
		isAvailable: always,
		run: (context: FileContext): Promise<void> =>
			openChapterExport(context),
		cli: {
			name: 'export-chapters',
			description:
				'Write the chapters and markers of a recording as a list, a cue sheet or an outline.',
			params: EXPORT_PARAMS,
			opensDialog: true,
			execute: exportChaptersFromCli,
		},
	},
	{
		commandId: COMMAND_IDS.deleteRecording,
		title: 'Delete recording',
		icon: 'trash',
		// Only a recording reached on its own, as the file explorer reaches
		// it. One reached through a note - its link in the editor, its player,
		// the palette in that note - has links there that a plain delete
		// would leave broken, so the link-aware delete is offered instead.
		// A moment of the recording offers neither delete.
		isAvailable: ({ origin }: FileContext): boolean =>
			origin.offersPlainDelete(),
		run: async ({ file, services }: FileContext): Promise<void> => {
			try {
				await services.app.fileManager.trashFile(file);
				new Notice('Recording deleted');
			} catch (error) {
				new Notice('Failed to delete recording');
				console.error(
					`${PLUGIN_LOG_PREFIX} Failed to delete ${file.path}:`,
					error,
				);
			}
		},
		cli: {
			name: 'delete',
			description: 'Move a recording to the trash.',
			unavailable: ({ file }: FileContext): string =>
				`${file.path} was named through a note, whose links to it a plain delete would leave broken. Use delete-with-links to remove them too, or name the recording alone with path=<recording>.`,
			execute: async ({
				file,
				services,
			}: FileContext): Promise<string> => {
				await services.app.fileManager.trashFile(file);
				return `Moved ${file.path} to the trash.`;
			},
		},
	},
	{
		commandId: COMMAND_IDS.deleteRecordingAndLink,
		title: 'Delete recording & link to file',
		icon: 'trash',
		// Wherever the recording was reached through a link: the one the menu
		// or the cursor was on - an editor need not show a note file, as a
		// canvas card does not - the links of the note it was reached through,
		// or a link whose place is not known. The file explorer reaches it
		// through none of them. A moment of the recording, a timecode link or
		// a player embedded at one, offers no delete at all.
		isAvailable: ({ origin }: FileContext): boolean =>
			origin.offersLinkDelete(),
		run: async (context: FileContext): Promise<void> => {
			try {
				new Notice(await deleteRecordingWithLink(context));
			} catch (error) {
				new Notice('Failed to delete recording');
				console.error(
					`${PLUGIN_LOG_PREFIX} Failed to delete ${context.file.path}:`,
					error,
				);
			}
		},
		cli: {
			name: 'delete-with-links',
			description:
				'Move a recording to the trash and remove its links from the note named.',
			unavailable: ({ file }: FileContext): string =>
				`Name the note to remove the links of ${file.path} from: file=<note>, or note=<note> beside path=<recording>.`,
			execute: deleteRecordingWithLink,
		},
	},
];

/**
 * Reads a recording's markers and opens the export dialog over them.
 *
 * The link builder is the one transcripts use, so an outline timecode is a
 * real link into the recording rather than text that looks like one. The
 * outline goes into the note the recording was reached through, or the
 * active note when it was reached directly.
 * @param context - The recording and the note it was reached through
 */
async function openChapterExport(context: FileContext): Promise<void> {
	const { file, services } = context;
	let markers: PlayerMarker[];
	try {
		markers = await services.recordingSidecar.getMarkers(file.path);
	} catch (error) {
		console.error(
			`${PLUGIN_LOG_PREFIX} Failed to read the markers of ${file.path}:`,
			error,
		);
		new Notice('Could not read the markers of this recording.');
		return;
	}
	if (markers.length === 0) {
		new Notice('This recording has no chapters or markers to export.');
		return;
	}
	const note = context.origin.noteForDialog();
	const notePath =
		note === undefined
			? (services.app.workspace.getActiveFile()?.path ?? '')
			: (note?.path ?? '');
	new ChapterExportModal(services.app, {
		file,
		markers,
		notePath: notePath === file.path ? '' : notePath,
		linkBuilder: timecodeLinkBuilder(services.app, file, notePath),
	}).open();
}

/**
 * The file actions as a family: the palette acts on the recordings of what
 * is active, the command line on the recordings it names.
 * @param services - Injected services every action shares
 * @returns The family
 */
export function fileActionFamily(
	services: ActionServices,
): ActionFamily<FileContext> {
	return {
		actions: FILE_ACTIONS,
		activeTargets: () => activeRecordings(services),
		cliTarget: {
			params: RECORDING_TARGET_PARAMS,
			resolve: (args) => namedRecordings(services, args),
		},
		describe: describeRecording,
	};
}
