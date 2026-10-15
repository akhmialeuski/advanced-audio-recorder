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

import { Notice, TFile } from 'obsidian';
import type { Editor } from 'obsidian';
import { FILE_ACTIONS } from 'src/actions/fileActions';
import { describeRetryOutcome } from 'src/actions/recordingEdits';
import type { ActionServices } from 'src/actions/PluginAction';
import { COMMAND_IDS, TRANSCRIPTION_PROVIDER_IDS } from 'src/constants';
import { DEFAULT_SETTINGS } from 'src/settings/settingsSchema';
import type { AudioRecorderSettings } from 'src/settings/settingsSchema';
import { at, defined } from '../helpers/assertions';
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
import {
	partial,
	silenceConsole,
	queueServicesDouble,
} from '../helpers/doubles';

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
/** What the spied engine answers a top-up with. */
const mockEngineRun = jest.fn();

// The engine the top-up drives is a spy for the same reason the dialogs are:
// what the action owes is sending the stretches that failed and accounting
// what came back, not what the engine does with them.
jest.mock('src/transcription/TranscriptionService', () => ({
	TranscriptionService: jest.fn(() => ({ run: mockEngineRun })),
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

/**
 * The services an action is handed, all of them spies.
 * @param settings - Settings this case varies
 * @param sidecar - The recording sidecar the case drives
 * @param files - Vault contents the case reads back, by path
 * @returns The services, and the spies a case asserts on
 */
function createServices(
	settings: Partial<AudioRecorderSettings> = {},
	sidecar: ActionServices['recordingSidecar'] = {} as ActionServices['recordingSidecar'],
	files: Record<string, string> = {},
): {
	services: ActionServices;
	primeForEnhancement: jest.Mock;
	recordRun: jest.Mock;
} {
	const { app } = createMockApp({
		vault: {
			getFileByPath: (path: string) =>
				path in files
					? Object.assign(Object.create(TFile.prototype), { path })
					: null,
			cachedRead: (target: TFile) =>
				Promise.resolve(files[target.path] ?? ''),
		},
	});
	const primeForEnhancement = jest.fn();
	const recordRun = jest.fn().mockReturnValue(0.02);
	return {
		primeForEnhancement,
		recordRun,
		services: {
			app,
			getSettings: () => ({ ...DEFAULT_SETTINGS, ...settings }),
			saveSettings: jest.fn().mockResolvedValue(undefined),
			createTranscriptionModalOptions: jest.fn(() => ({})),
			primeForEnhancement,
			getWorkerClient: jest.fn(() => null),
			autoChapters: {} as ActionServices['autoChapters'],
			recordingSidecar: sidecar,
			transcriptionQueue: queueServicesDouble(),
			onMarkersChanged: jest.fn(),
			transcriptionCosts: { recordLlmCall: jest.fn(), recordRun },
		},
	};
}

/**
 * A sidecar double typed once as the services expect it, so each case names
 * only the methods it drives.
 * @param methods - The sidecar methods this case needs
 * @returns The double
 */
function sidecarDouble(
	methods: Record<string, jest.Mock>,
): ActionServices['recordingSidecar'] {
	return methods as unknown as ActionServices['recordingSidecar'];
}

/** The services over a recording no part of which is missing. */
function nothingMissingServices(): ActionServices {
	return createServices(
		{ transcriptionEnabled: true },
		sidecarDouble({
			getFailedParts: jest.fn().mockResolvedValue(null),
			setFailedParts: jest.fn().mockResolvedValue(undefined),
			getTranscript: jest.fn().mockResolvedValue({ fileOutputs: [] }),
		}),
	).services;
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
			COMMAND_IDS.deleteRecordingAndLink,
		]);
	});

	it('gives every action a title and an icon', () => {
		for (const entry of FILE_ACTIONS) {
			expect(entry.title).not.toBe('');
			expect(entry.icon).not.toBe('');
		}
	});

	it.each([
		{
			reached: 'on its own',
			extra: {},
			offered: COMMAND_IDS.deleteRecording,
		},
		{
			reached: 'through a note',
			extra: { note: createFile('Meetings/standup.md') },
			offered: COMMAND_IDS.deleteRecordingAndLink,
		},
		{
			reached: 'through its link',
			extra: {
				link: {
					editor: partial<Editor>({}),
					subpath: '',
					line: 0,
					start: 0,
					end: 9,
				},
			},
			offered: COMMAND_IDS.deleteRecordingAndLink,
		},
		{
			reached: 'through a link whose place is not known',
			extra: { throughLink: true as const },
			offered: COMMAND_IDS.deleteRecordingAndLink,
		},
	])(
		'offers one delete for a recording reached $reached',
		({ extra, offered }) => {
			const { services } = createServices();
			const deletes = FILE_ACTIONS.filter(
				(entry) =>
					(entry.commandId === COMMAND_IDS.deleteRecording ||
						entry.commandId ===
							COMMAND_IDS.deleteRecordingAndLink) &&
					entry.isAvailable({ file, services, ...extra }),
			).map((entry) => entry.commandId);

			expect(deletes).toEqual([offered]);
		},
	);

	it.each([
		{ reached: 'at a moment on its own', extra: {} },
		{
			reached: 'at a moment through a note',
			extra: { note: createFile('Meetings/standup.md') },
		},
		{
			reached: 'at a moment through a link',
			extra: { throughLink: true as const },
		},
	])('offers no delete for a recording reached $reached', ({ extra }) => {
		const { services } = createServices();
		const deletes = FILE_ACTIONS.filter(
			(entry) =>
				(entry.commandId === COMMAND_IDS.deleteRecording ||
					entry.commandId === COMMAND_IDS.deleteRecordingAndLink) &&
				entry.isAvailable({
					file,
					services,
					atMoment: true,
					...extra,
				}),
		);

		expect(deletes).toEqual([]);
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

		// No note was reached through, so the active one is linked into.
		expect(insertProcessedAudioEmbed).toHaveBeenCalledWith(
			services.app,
			file,
			'Recordings/clean.webm',
			true,
			undefined,
		);
		expect(primeForEnhancement).toHaveBeenCalledWith([
			'Recordings/clean.webm',
		]);
	});

	it('links the cleaned-up file into the note it was reached through', async () => {
		const { services } = createServices();
		const note = createFile('Meetings/standup.md');
		await action(COMMAND_IDS.cleanupAudio).run({ file, services, note });
		const onDone = at(jest.mocked(AudioProcessingModal).mock.calls, 0)[3];

		await onDone?.({
			outputPath: 'Recordings/clean.wav',
			replaceSource: false,
		});

		expect(insertProcessedAudioEmbed).toHaveBeenCalledWith(
			services.app,
			file,
			'Recordings/clean.wav',
			false,
			note,
		);
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

		expect(at(jest.mocked(TranscriptionModal).mock.calls, 0)[3]).toEqual({
			...options,
			notePath: undefined,
		});
	});

	it('writes into the note the recording was reached through', async () => {
		const { services } = createServices();
		const note = createFile('Meetings/standup.md');

		await action(COMMAND_IDS.transcribeAudio).run({ file, services, note });

		expect(at(jest.mocked(TranscriptionModal).mock.calls, 0)[3]).toEqual({
			notePath: 'Meetings/standup.md',
		});
	});
});

describe('a dialog opened for a recording the command line named', () => {
	it('transcribes into no note when none was named', async () => {
		const { services } = createServices();

		await action(COMMAND_IDS.transcribeAudio).run({
			file,
			services,
			noteFixed: true,
		});

		expect(at(jest.mocked(TranscriptionModal).mock.calls, 0)[3]).toEqual({
			notePath: '',
		});
	});

	it('links the cleaned copy into no note when none was named', async () => {
		const { services } = createServices();
		await action(COMMAND_IDS.cleanupAudio).run({
			file,
			services,
			noteFixed: true,
		});
		const onProcessed = defined(
			at(jest.mocked(AudioProcessingModal).mock.calls, 0)[3],
		);

		await onProcessed({
			outputPath: 'Recordings/take-processed.wav',
			replaceSource: false,
		});

		expect(insertProcessedAudioEmbed).toHaveBeenCalledWith(
			services.app,
			file,
			'Recordings/take-processed.wav',
			false,
			null,
		);
	});
});

describe('deleting a recording with its link', () => {
	it('is offered only where a note was reached through', () => {
		const { services } = createServices();
		const remove = action(COMMAND_IDS.deleteRecordingAndLink);

		expect(remove.isAvailable({ file, services })).toBe(false);
		expect(
			remove.isAvailable({
				file,
				services,
				note: createFile('Meetings/standup.md'),
			}),
		).toBe(true);
	});

	it('trashes the recording and removes the link it was opened on', async () => {
		const { services } = createServices();
		const replaceRange = jest.fn();
		const editor = partial<Editor>({ replaceRange });

		await action(COMMAND_IDS.deleteRecordingAndLink).run({
			file,
			services,
			note: createFile('Meetings/standup.md'),
			link: { editor, subpath: '', line: 4, start: 2, end: 20 },
		});

		expect(services.app.fileManager.trashFile).toHaveBeenCalledWith(file);
		expect(replaceRange).toHaveBeenCalledWith(
			'',
			{ line: 4, ch: 2 },
			{ line: 4, ch: 20 },
		);
		expect(noticeMessages()).toContain('Recording and link deleted');
	});

	it('says it failed when the recording cannot be trashed', async () => {
		const error = silenceConsole('error');
		const { services } = createServices();
		jest.mocked(services.app.fileManager.trashFile).mockRejectedValue(
			new Error('locked'),
		);

		await action(COMMAND_IDS.deleteRecordingAndLink).run({
			file,
			services,
			note: createFile('Meetings/standup.md'),
		});

		expect(noticeMessages()).toContain('Failed to delete recording');
		error.mockRestore();
	});
});

// The top-up is offered on every recording, because whether anything is
// missing cannot be known without reading the sidecar and availability is
// decided synchronously. So a recording with nothing missing has to be told
// so, and every other outcome has to reach the user as one sentence.
describe('transcribing the parts that failed', () => {
	it('says so when the recording has nothing missing', async () => {
		const services = nothingMissingServices();

		await action(COMMAND_IDS.retryFailedParts).run({ file, services });

		expect(noticeMessages().join(' ')).toContain('Nothing is missing');
	});

	it('reports what went wrong instead of failing silently', async () => {
		const error = silenceConsole('error');
		const { services } = createServices(
			{ transcriptionEnabled: true },
			sidecarDouble({
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
		const error = silenceConsole('error');
		const { services } = createServices(
			{ transcriptionEnabled: true },
			sidecarDouble({
				getFailedParts: jest
					.fn()
					.mockRejectedValue('the disk went away'),
			}),
		);

		await action(COMMAND_IDS.retryFailedParts).run({ file, services });

		expect(noticeMessages().join(' ')).toContain('the disk went away');
		error.mockRestore();
	});

	it('puts what the top-up cost into the session total', async () => {
		// It calls the same paid engine a full run does, and the counter
		// covered every other surface that runs one but not this one
		const LOST = {
			label: '0:30-2:00',
			message: 'rate limited',
			startSeconds: 30,
			endSeconds: 120,
		};
		const { services, recordRun } = createServices(
			{ transcriptionEnabled: true },
			sidecarDouble({
				getFailedParts: jest
					.fn()
					.mockResolvedValue({ parts: [LOST], recordedAt: 'then' }),
				setFailedParts: jest.fn().mockResolvedValue(undefined),
				getTranscript: jest.fn().mockResolvedValue({
					fileOutputs: [
						{ path: 'take.json', format: 'json', writtenAt: '' },
					],
				}),
			}),
			{ 'take.json': JSON.stringify({ segments: [], language: 'en' }) },
		);
		mockEngineRun.mockResolvedValue({
			transcript: { segments: [], speakers: [], language: 'en' },
			missingParts: [],
			cost: {
				engineId: TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
				usd: 0.02,
				usage: {},
			},
			// The part covering the ninety-second gap runs to five minutes,
			// which is what a plan coarser than the request sends.
			sentSeconds: 300,
		});

		await action(COMMAND_IDS.retryFailedParts).run({ file, services });

		// Priced against the audio the run sent. Adding up the stretches it
		// asked for instead quoted ninety seconds for five minutes of engine
		// time, so the session total came out short by the difference.
		expect(recordRun).toHaveBeenCalledWith(
			{
				engineId: TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
				usd: 0.02,
				usage: {},
			},
			expect.anything(),
			300,
		);
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
				sentSeconds: 90,
			}),
		).toBe('Recovered 3 segments and rewrote 2 transcript files.');
	});

	it('counts one of each in the singular', () => {
		expect(
			describeRetryOutcome({
				recovered: 1,
				stillMissing: [],
				rewritten: 1,
				sentSeconds: 90,
			}),
		).toBe('Recovered 1 segment and rewrote 1 transcript file.');
	});

	it('says how many parts failed again', () => {
		expect(
			describeRetryOutcome({
				recovered: 1,
				stillMissing: [{ label: 'x', message: 'y', startSeconds: 0 }],
				rewritten: 1,
				sentSeconds: 90,
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
				sentSeconds: 90,
			}),
		).toContain('2 parts failed again');
	});

	it('gives the reason nothing was attempted, when nothing was', () => {
		expect(
			describeRetryOutcome({
				recovered: 0,
				stillMissing: [],
				rewritten: 0,
				sentSeconds: 0,
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
		const { services } = createServices(
			{},
			sidecarDouble({
				getMarkers: jest.fn().mockResolvedValue([]),
			}),
		);

		await action(COMMAND_IDS.exportChapters).run({ file, services });

		expect(noticeMessages().join(' ')).toContain('no chapters or markers');
	});

	it('opens the export dialog over the markers it read', async () => {
		const { services } = createServices(
			{},
			sidecarDouble({
				getMarkers: jest
					.fn()
					.mockResolvedValue([
						{ id: 'a', time: 0, label: 'Intro', kind: 'chapter' },
					]),
			}),
		);

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
		const { services } = createServices(
			{},
			sidecarDouble({
				getMarkers: jest
					.fn()
					.mockResolvedValue([
						{ id: 'a', time: 9.7, label: 'Intro', kind: 'chapter' },
					]),
			}),
		);
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

	it('links from no note for a recording the command line named alone', async () => {
		const { services } = createServices(
			{},
			sidecarDouble({
				getMarkers: jest
					.fn()
					.mockResolvedValue([
						{ id: 'a', time: 0, label: 'Intro', kind: 'chapter' },
					]),
			}),
		);
		jest.mocked(services.app.workspace.getActiveFile).mockReturnValue(
			createFile('Meetings/other.md'),
		);

		await action(COMMAND_IDS.exportChapters).run({
			file,
			services,
			noteFixed: true,
		});

		expect(ChapterExportModal).toHaveBeenCalledWith(
			services.app,
			expect.objectContaining({ notePath: '' }),
		);
	});

	it('inserts into no note when the recording itself is what is open', async () => {
		// Its own path is not a note to write an outline into
		const { services } = createServices(
			{},
			sidecarDouble({
				getMarkers: jest
					.fn()
					.mockResolvedValue([
						{ id: 'a', time: 0, label: 'Intro', kind: 'chapter' },
					]),
			}),
		);
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
		const error = silenceConsole('error');
		const { services } = createServices(
			{},
			sidecarDouble({
				getMarkers: jest
					.fn()
					.mockRejectedValue(new Error('unreadable')),
			}),
		);

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

describe('the file actions on the command line', () => {
	it('names every action as the command line calls it', () => {
		expect(FILE_ACTIONS.map((entry) => entry.cli.name)).toEqual([
			'info',
			'convert',
			'split',
			'cleanup',
			'transcribe',
			'retry-failed',
			'speakers',
			'chapters',
			'export-chapters',
			'delete',
			'delete-with-links',
		]);
	});

	it.each([
		{
			commandId: COMMAND_IDS.retryFailedParts,
			said: 'Transcription is switched off in settings.',
		},
		{
			commandId: COMMAND_IDS.renameSpeakers,
			said: 'Rename speakers is switched off in settings.',
		},
		{
			commandId: COMMAND_IDS.generateChapters,
			said: 'Auto chapters are switched off in settings.',
		},
		{
			commandId: COMMAND_IDS.deleteRecording,
			note: createFile('Meetings/standup.md'),
			said: `${file.path} was named through a note, whose links to it a plain delete would leave broken. Use delete-with-links to remove them too, or name the recording alone with path=<recording>.`,
		},
		{
			commandId: COMMAND_IDS.deleteRecordingAndLink,
			said: `Name the note to remove the links of ${file.path} from: file=<note>, or note=<note> beside path=<recording>.`,
		},
	])('says why $commandId is not offered', ({ commandId, note, said }) => {
		const { services } = createServices();

		expect(
			action(commandId).cli.unavailable?.({
				file,
				services,
				...(note ? { note } : {}),
			}),
		).toBe(said);
	});

	it('trashes the recording and says so', async () => {
		const { services } = createServices();

		await expect(
			Promise.resolve(
				action(COMMAND_IDS.deleteRecording).cli.execute(
					{ file, services },
					{},
				),
			),
		).resolves.toBe(`Moved ${file.path} to the trash.`);
		expect(services.app.fileManager.trashFile).toHaveBeenCalledWith(file);
		expect(noticeMessages()).toEqual([]);
	});

	it('answers a retry with what the notice would have said', async () => {
		const services = nothingMissingServices();

		await expect(
			Promise.resolve(
				action(COMMAND_IDS.retryFailedParts).cli.execute(
					{ file, services },
					{},
				),
			),
		).resolves.toContain('Nothing is missing');
		expect(noticeMessages()).toEqual([]);
	});
});
