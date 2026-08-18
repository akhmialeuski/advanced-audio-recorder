/**
 * Tests the per-file action registry.
 *
 * Every surface that offers an action - the file menu, the editor menu, the
 * player menu, and the command palette - renders this one list, so a mistake
 * here is a mistake in all four. The list's shape was covered; what each entry
 * actually does when picked was not, which left six of its run handlers
 * unexecuted and the file at 57% functions.
 * @module tests/unit/fileActions.test
 */

import { Notice } from 'obsidian';
import { FILE_ACTIONS } from 'src/actions/fileActions';
import type { ActionServices } from 'src/actions/PluginAction';
import { COMMAND_IDS } from 'src/constants';
import { DEFAULT_SETTINGS } from 'src/settings/settingsSchema';
import type { AudioRecorderSettings } from 'src/settings/settingsSchema';
import { at } from '../helpers/assertions';
import { createFile, createMockApp } from '../helpers/createApp';
import { noticeMessages } from '../mocks/obsidian';

import { AudioFileInfoModal } from 'src/ui/AudioFileInfoModal';
import { ConversionModal } from 'src/ui/ConversionModal';
import { SplitModal } from 'src/ui/SplitModal';
import { TranscriptionModal } from 'src/ui/TranscriptionModal';
import { SpeakerRenameModal } from 'src/ui/SpeakerRenameModal';
import { ChapterGenerationModal } from 'src/ui/ChapterGenerationModal';
import { AudioProcessingModal } from 'src/cleanup/AudioProcessingModal';
import { getAudioFileInfo } from 'src/utils/AudioFileAnalyzer';
import { insertProcessedAudioEmbed } from 'src/recording/NoteInserter';

// Each dialog is a spy that records the arguments and exposes open(): what an
// action owes its surface is that picking it opens the right dialog over the
// right file, not what that dialog then renders.
jest.mock('src/ui/AudioFileInfoModal', () => ({
	AudioFileInfoModal: jest.fn(() => ({ open: jest.fn() })),
}));
jest.mock('src/ui/ConversionModal', () => ({
	ConversionModal: jest.fn(() => ({ open: jest.fn() })),
}));
jest.mock('src/ui/SplitModal', () => ({
	SplitModal: jest.fn(() => ({ open: jest.fn() })),
}));
jest.mock('src/ui/TranscriptionModal', () => ({
	TranscriptionModal: jest.fn(() => ({ open: jest.fn() })),
}));
jest.mock('src/ui/SpeakerRenameModal', () => ({
	SpeakerRenameModal: jest.fn(() => ({ open: jest.fn() })),
}));
jest.mock('src/ui/ChapterGenerationModal', () => ({
	ChapterGenerationModal: jest.fn(() => ({ open: jest.fn() })),
}));
jest.mock('src/cleanup/AudioProcessingModal', () => ({
	AudioProcessingModal: jest.fn(() => ({ open: jest.fn() })),
}));
jest.mock('src/utils/AudioFileAnalyzer', () => ({
	getAudioFileInfo: jest.fn().mockResolvedValue({ format: 'webm' }),
}));
jest.mock('src/recording/NoteInserter', () => ({
	insertProcessedAudioEmbed: jest.fn().mockResolvedValue(undefined),
}));

/** The action registered under a command id. */
function action(commandId: string): (typeof FILE_ACTIONS)[number] {
	const found = FILE_ACTIONS.find((entry) => entry.commandId === commandId);
	if (!found) {
		throw new Error(
			`No action for ${commandId}. Registered: ${FILE_ACTIONS.map(
				(entry) => entry.commandId,
			).join(', ')}`,
		);
	}
	return found;
}

/** The services an action is handed, all of them spies. */
function createServices(settings: Partial<AudioRecorderSettings> = {}): {
	services: ActionServices;
	primeForEnhancement: jest.Mock;
} {
	const { app } = createMockApp();
	const primeForEnhancement = jest.fn();
	return {
		primeForEnhancement,
		services: {
			app,
			getSettings: () => ({ ...DEFAULT_SETTINGS, ...settings }),
			saveSettings: jest.fn().mockResolvedValue(undefined),
			createTranscriptionModalOptions: jest.fn(() => ({})),
			primeForEnhancement,
			getWorkerClient: jest.fn(() => null),
			autoChapters: {} as ActionServices['autoChapters'],
			recordingSidecar: {} as ActionServices['recordingSidecar'],
		},
	};
}

const file = createFile('Recordings/take.webm');

describe('FILE_ACTIONS registry', () => {
	it('registers every action exactly once', () => {
		const ids = FILE_ACTIONS.map((entry) => entry.commandId);

		expect(new Set(ids).size).toBe(ids.length);
	});

	it('offers the actions in menu order', () => {
		expect(FILE_ACTIONS.map((entry) => entry.commandId)).toEqual([
			COMMAND_IDS.audioFileInfo,
			COMMAND_IDS.convertAudioFormat,
			COMMAND_IDS.splitAudio,
			COMMAND_IDS.cleanupAudio,
			COMMAND_IDS.transcribeAudio,
			COMMAND_IDS.renameSpeakers,
			COMMAND_IDS.generateChapters,
			COMMAND_IDS.deleteRecording,
		]);
	});

	it('gives every action a title and an icon', () => {
		for (const entry of FILE_ACTIONS) {
			expect(entry.title).not.toBe('');
			expect(entry.icon).not.toBe('');
		}
	});

	it('keeps only the link-aware delete out of the editor menu', () => {
		const hidden = FILE_ACTIONS.filter(
			(entry) => !entry.showInEditorMenu,
		).map((entry) => entry.commandId);

		expect(hidden).toEqual([COMMAND_IDS.deleteRecording]);
	});
});

describe('FILE_ACTIONS availability', () => {
	it.each([
		{
			name: 'transcribe',
			commandId: COMMAND_IDS.transcribeAudio,
			setting: 'transcriptionEnabled',
		},
		{
			name: 'rename speakers',
			commandId: COMMAND_IDS.renameSpeakers,
			setting: 'transcriptionSpeakerRenameEnabled',
		},
		{
			name: 'generate chapters',
			commandId: COMMAND_IDS.generateChapters,
			setting: 'transcriptionAutoChaptersEnabled',
		},
	] satisfies {
		name: string;
		commandId: string;
		setting: keyof AudioRecorderSettings;
	}[])(
		'offers $name only when its setting is on',
		({ commandId, setting }) => {
			const on = createServices({ [setting]: true }).services;
			const off = createServices({ [setting]: false }).services;

			expect(action(commandId).isAvailable(file, on)).toBe(true);
			expect(action(commandId).isAvailable(file, off)).toBe(false);
		},
	);

	it.each([
		COMMAND_IDS.audioFileInfo,
		COMMAND_IDS.convertAudioFormat,
		COMMAND_IDS.splitAudio,
		COMMAND_IDS.cleanupAudio,
		COMMAND_IDS.deleteRecording,
	])('always offers %s', (commandId) => {
		const { services } = createServices();

		expect(action(commandId).isAvailable(file, services)).toBe(true);
	});
});

describe('FILE_ACTIONS dialogs', () => {
	it.each([
		{
			name: 'convert',
			commandId: COMMAND_IDS.convertAudioFormat,
			dialog: ConversionModal,
		},
		{
			name: 'split',
			commandId: COMMAND_IDS.splitAudio,
			dialog: SplitModal,
		},
		{
			name: 'clean up',
			commandId: COMMAND_IDS.cleanupAudio,
			dialog: AudioProcessingModal,
		},
		{
			name: 'transcribe',
			commandId: COMMAND_IDS.transcribeAudio,
			dialog: TranscriptionModal,
		},
		{
			name: 'rename speakers',
			commandId: COMMAND_IDS.renameSpeakers,
			dialog: SpeakerRenameModal,
		},
		{
			name: 'generate chapters',
			commandId: COMMAND_IDS.generateChapters,
			dialog: ChapterGenerationModal,
		},
	])(
		'opens the $name dialog over the file',
		async ({ commandId, dialog }) => {
			const { services } = createServices();

			await action(commandId).run(file, services);

			expect(dialog).toHaveBeenCalledTimes(1);
			const [openedApp, openedFile] =
				jest.mocked(dialog).mock.calls[0] ?? [];
			expect(openedApp).toBe(services.app);
			expect(openedFile).toBe(file);
			expect(
				jest.mocked(dialog).mock.results[0]?.value.open,
			).toHaveBeenCalled();
		},
	);

	it('primes the converted file so its embed becomes the enhanced player', async () => {
		const { services, primeForEnhancement } = createServices();
		await action(COMMAND_IDS.convertAudioFormat).run(file, services);
		const options = jest.mocked(ConversionModal).mock.calls[0]?.[3] as {
			onConverted: (path: string) => void;
		};

		options.onConverted('Recordings/take.mp3');

		expect(primeForEnhancement).toHaveBeenCalledWith([
			'Recordings/take.mp3',
		]);
	});

	it('links the cleaned-up file into the note and primes it', async () => {
		const { services, primeForEnhancement } = createServices();
		await action(COMMAND_IDS.cleanupAudio).run(file, services);
		const onDone = jest.mocked(AudioProcessingModal).mock
			.calls[0]?.[3] as (result: {
			outputPath: string;
			replaceSource: boolean;
		}) => Promise<void>;

		await onDone({
			outputPath: 'Recordings/clean.webm',
			replaceSource: true,
		});

		expect(insertProcessedAudioEmbed).toHaveBeenCalledWith(
			services.app,
			file,
			'Recordings/clean.webm',
			true,
		);
		expect(primeForEnhancement).toHaveBeenCalledWith([
			'Recordings/clean.webm',
		]);
	});
});

describe('the audio file info action', () => {
	it('opens the dialog with what the analyser read', async () => {
		const { services } = createServices();

		await action(COMMAND_IDS.audioFileInfo).run(file, services);

		expect(getAudioFileInfo).toHaveBeenCalledWith(services.app, file);
		expect(AudioFileInfoModal).toHaveBeenCalledWith(services.app, {
			format: 'webm',
		});
	});

	it('opens nothing when the file could not be read', async () => {
		jest.mocked(getAudioFileInfo).mockResolvedValueOnce(null);
		const { services } = createServices();

		await action(COMMAND_IDS.audioFileInfo).run(file, services);

		// The analyser has already told the user why; a dialog with no
		// content would only say it twice.
		expect(AudioFileInfoModal).not.toHaveBeenCalled();
	});
});

describe('the delete action', () => {
	it('trashes the recording and says so', async () => {
		const { services } = createServices();

		await action(COMMAND_IDS.deleteRecording).run(file, services);

		expect(services.app.fileManager.trashFile).toHaveBeenCalledWith(file);
		expect(noticeMessages()).toContain('Recording deleted');
	});

	it('reports a failure instead of leaving the user guessing', async () => {
		const consoleError = jest
			.spyOn(console, 'error')
			.mockImplementation(() => undefined);
		const { services } = createServices();
		jest.mocked(services.app.fileManager.trashFile).mockRejectedValueOnce(
			new Error('locked'),
		);

		await action(COMMAND_IDS.deleteRecording).run(file, services);

		expect(noticeMessages()).toContain('Failed to delete recording');
		expect(noticeMessages()).not.toContain('Recording deleted');
		expect(consoleError).toHaveBeenCalled();
	});

	it('raises exactly one notice per attempt', async () => {
		const { services } = createServices();

		await action(COMMAND_IDS.deleteRecording).run(file, services);

		expect(jest.mocked(Notice)).toHaveBeenCalledTimes(1);
	});
});

describe('the transcribe action', () => {
	it('hands the dialog the options the plugin built for this run', async () => {
		const { services } = createServices();
		const options = { costTracker: 'sentinel' };
		jest.mocked(services.createTranscriptionModalOptions).mockReturnValue(
			options as never,
		);

		await action(COMMAND_IDS.transcribeAudio).run(file, services);

		expect(at(jest.mocked(TranscriptionModal).mock.calls, 0)[3]).toBe(
			options,
		);
	});
});
