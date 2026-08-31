/**
 * The per-file actions offered by the plugin, defined once. The context
 * menus render this list and the palette registers it as commands, so a
 * feature added here appears in every surface (and becomes
 * hotkey-assignable) automatically.
 * @module actions/fileActions
 */

import { Notice, TFile } from 'obsidian';
import { COMMAND_IDS, PLUGIN_LOG_PREFIX } from '../constants';
import { isAudioFile } from '../utils/audioFile';
import { getAudioFileInfo } from '../utils/AudioFileAnalyzer';
import { AudioFileInfoModal } from '../ui/AudioFileInfoModal';
import { ConversionModal } from '../ui/ConversionModal';
import { SplitModal } from '../ui/SplitModal';
import { TranscriptionModal } from '../ui/TranscriptionModal';
import { SpeakerRenameModal } from '../ui/SpeakerRenameModal';
import { ChapterGenerationModal } from '../ui/ChapterGenerationModal';
import { ChapterExportModal } from '../ui/ChapterExportModal';
import type { PlayerMarker } from '../markers/markerModel';
import { AudioProcessingModal } from '../cleanup/AudioProcessingModal';
import { insertProcessedAudioEmbed } from '../recording/NoteInserter';
import type { ActionServices, FileAction, FileContext } from './PluginAction';
import { TranscriptionService } from '../transcription/TranscriptionService';
import {
	FailedPartRetry,
	serviceRunner,
	type RetryOutcome,
} from '../transcription/retryFailedParts';

/** Availability gate for actions with no extra conditions. */
const always = (): boolean => true;

/**
 * Builds the resolver the palette uses for file actions: the active file
 * when it is audio, and nothing otherwise, which is what keeps every file
 * command out of the palette while a note or an image is open.
 * @param services - Injected services every file action shares
 * @returns Resolver producing the context, or null when there is no
 *   active audio file
 */
export function activeAudioFile(
	services: ActionServices,
): () => FileContext | null {
	return (): FileContext | null => {
		const file = services.app.workspace.getActiveFile();
		return file instanceof TFile && isAudioFile(file)
			? { file, services }
			: null;
	};
}

/**
 * All per-file actions in menu order: info, convert, split, clean up,
 * transcribe, rename speakers, generate chapters, delete. "Delete recording" is excluded
 * from the editor menu, which offers the link-aware delete variant
 * instead.
 */
export const FILE_ACTIONS: readonly FileAction[] = [
	{
		commandId: COMMAND_IDS.audioFileInfo,
		title: 'Audio file info',
		icon: 'info',
		showInEditorMenu: true,
		isAvailable: always,
		run: async ({ file, services }: FileContext): Promise<void> => {
			const info = await getAudioFileInfo(services.app, file);
			if (info) {
				new AudioFileInfoModal(services.app, info).open();
			}
		},
	},
	{
		commandId: COMMAND_IDS.convertAudioFormat,
		title: 'Convert audio format',
		icon: 'file-audio',
		showInEditorMenu: true,
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
	},
	{
		commandId: COMMAND_IDS.splitAudio,
		title: 'Split audio into parts',
		icon: 'scissors',
		showInEditorMenu: true,
		isAvailable: always,
		run: ({ file, services }: FileContext): void => {
			new SplitModal(
				services.app,
				file,
				services.getSettings,
				services.recordingSidecar,
			).open();
		},
	},
	{
		commandId: COMMAND_IDS.cleanupAudio,
		title: 'Clean up audio',
		icon: 'wand-2',
		showInEditorMenu: true,
		isAvailable: always,
		run: ({ file, services }: FileContext): void => {
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
					);
					services.primeForEnhancement([outputPath]);
				},
			).open();
		},
	},
	{
		commandId: COMMAND_IDS.transcribeAudio,
		title: 'Transcribe audio',
		icon: 'captions',
		showInEditorMenu: true,
		isAvailable: ({ services }: FileContext): boolean =>
			services.getSettings().transcriptionEnabled,
		run: ({ file, services }: FileContext): void => {
			new TranscriptionModal(
				services.app,
				file,
				services.getSettings,
				services.createTranscriptionModalOptions(),
			).open();
		},
	},
	{
		commandId: COMMAND_IDS.retryFailedParts,
		title: 'Transcribe the parts that failed',
		icon: 'refresh-cw',
		showInEditorMenu: true,
		isAvailable: ({ services }: FileContext): boolean =>
			services.getSettings().transcriptionEnabled,
		run: ({ file, services }: FileContext): Promise<void> =>
			runFailedPartRetry(file, services),
	},
	{
		commandId: COMMAND_IDS.renameSpeakers,
		title: 'Rename speakers',
		icon: 'users',
		showInEditorMenu: true,
		isAvailable: ({ services }: FileContext): boolean =>
			services.getSettings().transcriptionSpeakerRenameEnabled,
		run: ({ file, services }: FileContext): void => {
			new SpeakerRenameModal(services.app, file, {
				getSettings: services.getSettings,
				saveSettings: services.saveSettings,
				sidecar: services.recordingSidecar,
			}).open();
		},
	},
	{
		commandId: COMMAND_IDS.generateChapters,
		title: 'Generate chapters from transcript',
		icon: 'sparkles',
		showInEditorMenu: true,
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
	},
	{
		commandId: COMMAND_IDS.exportChapters,
		title: 'Export chapters and markers',
		icon: 'file-output',
		showInEditorMenu: true,
		// Whether the recording has markers needs a sidecar read, and
		// availability is decided synchronously; the dialog reads them and
		// says so when there are none.
		isAvailable: (): boolean => true,
		run: ({ file, services }: FileContext): Promise<void> =>
			openChapterExport(file, services),
	},
	{
		commandId: COMMAND_IDS.deleteRecording,
		title: 'Delete recording',
		icon: 'trash',
		showInEditorMenu: false,
		isAvailable: always,
		run: async ({ file, services }: FileContext): Promise<void> => {
			try {
				await services.app.fileManager.trashFile(file);
				new Notice('Recording deleted');
			} catch (error) {
				new Notice('Failed to delete recording');
				console.error('Failed to delete recording:', error);
			}
		},
	},
];

/**
 * Tops up a recording's transcript with the parts that failed, and reports
 * what happened in one notice.
 *
 * Whether anything is missing cannot be known without reading the sidecar,
 * and an action's availability is decided synchronously, so the action is
 * always offered and a recording with nothing missing is told so. Offering it
 * only after something warmed a cache would hide it exactly when it is
 * wanted.
 * @param file - The recording to top up
 * @param services - Injected services
 */
async function runFailedPartRetry(
	file: TFile,
	services: ActionServices,
): Promise<void> {
	const retry = new FailedPartRetry(
		services.app,
		file,
		services.recordingSidecar,
		serviceRunner(
			new TranscriptionService(services.app, services.getSettings),
		),
	);
	try {
		const outcome = await retry.retry();
		new Notice(describeRetryOutcome(outcome));
	} catch (error) {
		console.error(
			`${PLUGIN_LOG_PREFIX} Failed to transcribe the missing parts of ${file.path}:`,
			error,
		);
		new Notice(
			`Could not transcribe the missing parts: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
}

/**
 * One sentence saying what the top-up did.
 * @param outcome - What the retry reports
 * @returns The notice text
 */
export function describeRetryOutcome(outcome: RetryOutcome): string {
	if (outcome.blocked) {
		return outcome.blocked;
	}
	const recovered = `Recovered ${String(outcome.recovered)} segment${
		outcome.recovered === 1 ? '' : 's'
	} and rewrote ${String(outcome.rewritten)} transcript file${
		outcome.rewritten === 1 ? '' : 's'
	}.`;
	return outcome.stillMissing.length === 0
		? recovered
		: `${recovered} ${String(outcome.stillMissing.length)} part${
				outcome.stillMissing.length === 1 ? '' : 's'
			} failed again.`;
}

/**
 * Reads a recording's markers and opens the export dialog over them.
 *
 * The link builder is the one transcripts use, so an outline timecode is a
 * real link into the recording rather than text that looks like one.
 * @param file - The recording whose markers are exported
 * @param services - Injected services
 */
async function openChapterExport(
	file: TFile,
	services: ActionServices,
): Promise<void> {
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
	const notePath = services.app.workspace.getActiveFile()?.path ?? '';
	new ChapterExportModal(services.app, {
		file,
		markers,
		notePath: notePath === file.path ? '' : notePath,
		linkBuilder: (seconds, label) =>
			services.app.fileManager.generateMarkdownLink(
				file,
				notePath,
				`#t=${String(Math.floor(seconds))}`,
				label,
			),
	}).open();
}
