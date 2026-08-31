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
import { describeRetryOutcome, FILE_ACTIONS } from 'src/actions/fileActions';
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
import { ChapterExportModal } from 'src/ui/ChapterExportModal';
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
jest.mock('src/ui/ChapterExportModal', () => ({
	ChapterExportModal: jest.fn(() => ({ open: jest.fn() })),
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
function createServices(
	settings: Partial<AudioRecorderSettings> = {},
	sidecar: ActionServices['recordingSidecar'] = {} as ActionServices['recordingSidecar'],
): {
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
			recordingSidecar: sidecar,
			transcriptionQueue: {
				queueFolder: jest.fn().mockResolvedValue(undefined),
				open: jest.fn(),
			},
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
			COMMAND_IDS.retryFailedParts,
			COMMAND_IDS.renameSpeakers,
			COMMAND_IDS.generateChapters,
			COMMAND_IDS.exportChapters,
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

			expect(action(commandId).isAvailable({ file, services: on })).toBe(
				true,
			);
			expect(action(commandId).isAvailable({ file, services: off })).toBe(
				false,
			);
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

		expect(action(commandId).isAvailable({ file, services })).toBe(true);
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

			await action(commandId).run({ file, services });

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
		await action(COMMAND_IDS.convertAudioFormat).run({ file, services });
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
		await action(COMMAND_IDS.cleanupAudio).run({ file, services });
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

		await action(COMMAND_IDS.audioFileInfo).run({ file, services });

		expect(getAudioFileInfo).toHaveBeenCalledWith(services.app, file);
		expect(AudioFileInfoModal).toHaveBeenCalledWith(services.app, {
			format: 'webm',
		});
	});

	it('opens nothing when the file could not be read', async () => {
		jest.mocked(getAudioFileInfo).mockResolvedValueOnce(null);
		const { services } = createServices();

		await action(COMMAND_IDS.audioFileInfo).run({ file, services });

		// The analyser has already told the user why; a dialog with no
		// content would only say it twice.
		expect(AudioFileInfoModal).not.toHaveBeenCalled();
	});
});

describe('the delete action', () => {
	it('trashes the recording and says so', async () => {
		const { services } = createServices();

		await action(COMMAND_IDS.deleteRecording).run({ file, services });

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

		await action(COMMAND_IDS.deleteRecording).run({ file, services });

		expect(noticeMessages()).toContain('Failed to delete recording');
		expect(noticeMessages()).not.toContain('Recording deleted');
		expect(consoleError).toHaveBeenCalled();
	});

	it('raises exactly one notice per attempt', async () => {
		const { services } = createServices();

		await action(COMMAND_IDS.deleteRecording).run({ file, services });

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

		await action(COMMAND_IDS.transcribeAudio).run({ file, services });

		expect(at(jest.mocked(TranscriptionModal).mock.calls, 0)[3]).toBe(
			options,
		);
	});
});

// The top-up is offered on every recording, because whether anything is
// missing cannot be known without reading the sidecar and availability is
// decided synchronously. So a recording with nothing missing has to be told
// so, and every other outcome has to reach the user as one sentence.
describe('transcribing the parts that failed', () => {
	/**
	 * A sidecar double for the top-up, typed once as the services expect it
	 * so each case names only the methods it drives.
	 * @param methods - The sidecar methods this case needs
	 * @returns The double
	 */
	function retrySidecar(
		methods: Record<string, jest.Mock>,
	): ActionServices['recordingSidecar'] {
		return methods as unknown as ActionServices['recordingSidecar'];
	}

	it('says so when the recording has nothing missing', async () => {
		const { services } = createServices(
			{ transcriptionEnabled: true },
			retrySidecar({
				getFailedParts: jest.fn().mockResolvedValue(null),
				setFailedParts: jest.fn().mockResolvedValue(undefined),
				getTranscript: jest.fn().mockResolvedValue({ fileOutputs: [] }),
			}),
		);

		await action(COMMAND_IDS.retryFailedParts).run({ file, services });

		expect(noticeMessages().join(' ')).toContain('Nothing is missing');
	});

	it('reports what went wrong instead of failing silently', async () => {
		const error = jest.spyOn(console, 'error').mockImplementation(() => {
			// The notice is the assertion.
		});
		const { services } = createServices(
			{ transcriptionEnabled: true },
			retrySidecar({
				getFailedParts: jest
					.fn()
					.mockRejectedValue(new Error('sidecar unreadable')),
			}),
		);

		await action(COMMAND_IDS.retryFailedParts).run({ file, services });

		expect(noticeMessages().join(' ')).toContain('sidecar unreadable');
		error.mockRestore();
	});

	it('reports a rejection that is not an error at all', async () => {
		const error = jest.spyOn(console, 'error').mockImplementation(() => {
			// The notice is the assertion.
		});
		const { services } = createServices(
			{ transcriptionEnabled: true },
			retrySidecar({
				getFailedParts: jest
					.fn()
					.mockRejectedValue('the disk went away'),
			}),
		);

		await action(COMMAND_IDS.retryFailedParts).run({ file, services });

		expect(noticeMessages().join(' ')).toContain('the disk went away');
		error.mockRestore();
	});

	it('is offered only while transcription is on', () => {
		const on = createServices({ transcriptionEnabled: true });
		const off = createServices({ transcriptionEnabled: false });
		const entry = action(COMMAND_IDS.retryFailedParts);

		expect(entry.isAvailable({ file, services: on.services })).toBe(true);
		expect(entry.isAvailable({ file, services: off.services })).toBe(false);
	});
});

describe('what the user is told a top-up did', () => {
	it('names what came back and what was rewritten', () => {
		expect(
			describeRetryOutcome({
				recovered: 3,
				stillMissing: [],
				rewritten: 2,
			}),
		).toBe('Recovered 3 segments and rewrote 2 transcript files.');
	});

	it('counts one of each in the singular', () => {
		expect(
			describeRetryOutcome({
				recovered: 1,
				stillMissing: [],
				rewritten: 1,
			}),
		).toBe('Recovered 1 segment and rewrote 1 transcript file.');
	});

	it('says how many parts failed again', () => {
		expect(
			describeRetryOutcome({
				recovered: 1,
				stillMissing: [{ label: 'x', message: 'y', startSeconds: 0 }],
				rewritten: 1,
			}),
		).toContain('1 part failed again');
	});

	it('counts more than one part that failed again in the plural', () => {
		expect(
			describeRetryOutcome({
				recovered: 2,
				stillMissing: [
					{ label: 'a', message: 'x', startSeconds: 0 },
					{ label: 'b', message: 'y', startSeconds: 60 },
				],
				rewritten: 1,
			}),
		).toContain('2 parts failed again');
	});

	it('gives the reason nothing was attempted, when nothing was', () => {
		expect(
			describeRetryOutcome({
				recovered: 0,
				stillMissing: [],
				rewritten: 0,
				blocked: 'Nothing is missing from this transcript.',
			}),
		).toBe('Nothing is missing from this transcript.');
	});
});

// Whether a recording has markers needs a sidecar read, and availability is
// decided synchronously, so the action is always offered and the recording
// with none is told so rather than the entry quietly not being there.
describe('exporting chapters and markers', () => {
	it('says so when the recording has no markers', async () => {
		const { services } = createServices({}, {
			getMarkers: jest.fn().mockResolvedValue([]),
		} as unknown as ActionServices['recordingSidecar']);

		await action(COMMAND_IDS.exportChapters).run({ file, services });

		expect(noticeMessages().join(' ')).toContain('no chapters or markers');
	});

	it('opens the export dialog over the markers it read', async () => {
		const { services } = createServices({}, {
			getMarkers: jest
				.fn()
				.mockResolvedValue([
					{ id: 'a', time: 0, label: 'Intro', kind: 'chapter' },
				]),
		} as unknown as ActionServices['recordingSidecar']);

		await action(COMMAND_IDS.exportChapters).run({ file, services });

		expect(ChapterExportModal).toHaveBeenCalledWith(
			services.app,
			expect.objectContaining({
				file,
				markers: [
					{ id: 'a', time: 0, label: 'Intro', kind: 'chapter' },
				],
			}),
		);
	});

	it('links into the recording, so an outline timecode really jumps', async () => {
		const { services } = createServices({}, {
			getMarkers: jest
				.fn()
				.mockResolvedValue([
					{ id: 'a', time: 9.7, label: 'Intro', kind: 'chapter' },
				]),
		} as unknown as ActionServices['recordingSidecar']);
		const generate = jest
			.spyOn(services.app.fileManager, 'generateMarkdownLink')
			.mockReturnValue('[[take#t=9|0:09]]');

		await action(COMMAND_IDS.exportChapters).run({ file, services });
		const options = at(
			(ChapterExportModal as jest.Mock).mock.calls,
			0,
		)[1] as {
			linkBuilder: (seconds: number, label: string) => string;
		};

		expect(options.linkBuilder(9.7, '0:09')).toBe('[[take#t=9|0:09]]');
		// Floored, because that is the offset the link syntax carries
		expect(generate).toHaveBeenCalledWith(
			file,
			expect.any(String),
			'#t=9',
			'0:09',
		);
	});

	it('inserts into no note when the recording itself is what is open', async () => {
		// Its own path is not a note to write an outline into
		const { services } = createServices({}, {
			getMarkers: jest
				.fn()
				.mockResolvedValue([
					{ id: 'a', time: 0, label: 'Intro', kind: 'chapter' },
				]),
		} as unknown as ActionServices['recordingSidecar']);
		jest.spyOn(services.app.workspace, 'getActiveFile').mockReturnValue(
			file,
		);

		await action(COMMAND_IDS.exportChapters).run({ file, services });

		expect(ChapterExportModal).toHaveBeenCalledWith(
			services.app,
			expect.objectContaining({ notePath: '' }),
		);
	});

	it('reports a sidecar it could not read', async () => {
		const error = jest.spyOn(console, 'error').mockImplementation(() => {
			// The notice is the assertion.
		});
		const { services } = createServices({}, {
			getMarkers: jest.fn().mockRejectedValue(new Error('unreadable')),
		} as unknown as ActionServices['recordingSidecar']);

		await action(COMMAND_IDS.exportChapters).run({ file, services });

		expect(noticeMessages().join(' ')).toContain('Could not read');
		error.mockRestore();
	});

	it('is always offered, since nothing here can be known synchronously', () => {
		const { services } = createServices();

		expect(
			action(COMMAND_IDS.exportChapters).isAvailable({ file, services }),
		).toBe(true);
	});
});
