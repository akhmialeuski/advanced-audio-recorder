/**
 * The per-file actions offered by the plugin, defined once. The context
 * menus render this list and the palette registers it as commands, so a
 * feature added here appears in every surface (and becomes
 * hotkey-assignable) automatically.
 * @module actions/fileActions
 */

import { Notice } from 'obsidian';
import type { TFile } from 'obsidian';
import { COMMAND_IDS } from '../constants';
import { getAudioFileInfo } from '../utils/AudioFileAnalyzer';
import { AudioFileInfoModal } from '../ui/AudioFileInfoModal';
import { ConversionModal } from '../ui/ConversionModal';
import { SplitModal } from '../ui/SplitModal';
import { TranscriptionModal } from '../ui/TranscriptionModal';
import { AudioProcessingModal } from '../cleanup/AudioProcessingModal';
import { insertProcessedAudioEmbed } from '../recording/NoteInserter';
import type { ActionServices, FileAction } from './PluginAction';

/** Availability gate for actions with no extra conditions. */
const always = (): boolean => true;

/**
 * All per-file actions in menu order: info, convert, split, clean up,
 * transcribe, delete. "Delete recording" is excluded from the editor
 * menu, which offers the link-aware delete variant instead.
 */
export const FILE_ACTIONS: readonly FileAction[] = [
	{
		commandId: COMMAND_IDS.audioFileInfo,
		title: 'Audio file info',
		icon: 'info',
		showInEditorMenu: true,
		isAvailable: always,
		run: async (file: TFile, services: ActionServices): Promise<void> => {
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
		run: (file: TFile, services: ActionServices): void => {
			new ConversionModal(services.app, file, services.getSettings(), {
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
		run: (file: TFile, services: ActionServices): void => {
			new SplitModal(services.app, file, services.getSettings()).open();
		},
	},
	{
		commandId: COMMAND_IDS.cleanupAudio,
		title: 'Clean up audio',
		icon: 'wand-2',
		showInEditorMenu: true,
		isAvailable: always,
		run: (file: TFile, services: ActionServices): void => {
			new AudioProcessingModal(
				services.app,
				file,
				services.getSettings(),
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
		isAvailable: (_file: TFile, services: ActionServices): boolean =>
			services.getSettings().transcriptionEnabled,
		run: (file: TFile, services: ActionServices): void => {
			new TranscriptionModal(
				services.app,
				file,
				services.getSettings,
				services.createTranscriptionModalOptions(),
			).open();
		},
	},
	{
		commandId: COMMAND_IDS.deleteRecording,
		title: 'Delete recording',
		icon: 'trash',
		showInEditorMenu: false,
		isAvailable: always,
		run: async (file: TFile, services: ActionServices): Promise<void> => {
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
