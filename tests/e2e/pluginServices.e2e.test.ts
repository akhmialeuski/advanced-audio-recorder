/**
 * The services the plugin hands its collaborators, exercised from the plugin.
 *
 * main.ts wires its parts together with closures - the settings getter the
 * player registrar reads, the refresh the chapter service calls when it writes
 * markers, the encoder the file actions borrow, the options every transcription
 * run is opened with. Each is one or two lines, and every one of them was
 * unexecuted: the suites for the collaborators pass their own stubs in, so
 * nothing ever ran the closure the plugin actually supplies.
 *
 * A wrong closure here is a whole feature silently disconnected - markers that
 * never refresh, a settings change the player never sees - with every unit
 * suite still green.
 * @module tests/e2e/pluginServices.e2e.test
 */

import type { TFile } from 'obsidian';
import AudioRecorderPlugin from 'src/main';
import type { ActionServices } from 'src/actions/PluginAction';
import type { TranscriptionModalOptions } from 'src/ui/TranscriptionModal';
import type { Transcript } from 'src/transcription/TranscriptTypes';
import { AutoChapterService } from 'src/chapters/AutoChapterService';
import { ContextMenu } from 'src/ui/ContextMenu';
import { EnhancedPlayerRegistrar } from 'src/player/EnhancedPlayerRegistrar';
import { RecordingManager } from 'src/recording/RecordingManager';
import { at, defined } from '../helpers/assertions';
import { loadPlugin } from '../helpers/pluginHarness';

jest.mock('src/chapters/AutoChapterService', () => ({
	AutoChapterService: jest.fn().mockImplementation(() => ({
		generate: jest.fn().mockResolvedValue(undefined),
	})),
}));

/** The services the plugin built for its file actions. */
function actionServices(): ActionServices {
	return at(jest.mocked(ContextMenu).mock.calls, 0)[1];
}

/** The player registrar double the plugin built. */
function registrar(): { reloadMarkersFor: jest.Mock } {
	return at(jest.mocked(EnhancedPlayerRegistrar).mock.results, 0).value as {
		reloadMarkersFor: jest.Mock;
	};
}

/** The chapter-service double the plugin built. */
function chapterService(): { generate: jest.Mock } {
	return at(jest.mocked(AutoChapterService).mock.results, 0).value as {
		generate: jest.Mock;
	};
}

describe('the settings getter every collaborator reads through', () => {
	it.each([
		{
			name: 'the player registrar',
			getter: (): (() => unknown) =>
				at(jest.mocked(EnhancedPlayerRegistrar).mock.calls, 0)[2],
		},
		{
			name: 'the chapter service',
			getter: (): (() => unknown) =>
				at(jest.mocked(AutoChapterService).mock.calls, 0)[1],
		},
		{
			name: 'the file actions',
			getter: (): (() => unknown) => actionServices().getSettings,
		},
	])('gives $name the live settings, not a copy', async ({ getter }) => {
		// A snapshot taken at load would leave every one of them acting on
		// the settings as they were when Obsidian started the plugin.
		const { plugin } = await loadPlugin();

		plugin.settings.filePrefix = 'changed-after-load';

		expect((getter()() as { filePrefix: string }).filePrefix).toBe(
			'changed-after-load',
		);
	});
});

describe('the chapter service writing markers', () => {
	it('refreshes the open players of the file it wrote to', async () => {
		// Chapters are generated in the background; without this the note has
		// to be reopened before the chapters appear under the player.
		await loadPlugin();
		const refresh = defined(
			at(jest.mocked(AutoChapterService).mock.calls, 0)[3],
			'the chapter service refresh callback',
		);

		refresh('Recordings/take.webm');

		expect(registrar().reloadMarkersFor).toHaveBeenCalledWith(
			'Recordings/take.webm',
		);
	});
});

describe('the encoder the plugin shares', () => {
	it.each([
		{
			name: 'the recorder',
			getter: (): (() => unknown) =>
				defined(
					at(jest.mocked(RecordingManager).mock.calls, 0)[6],
					'the recorder worker getter',
				),
		},
		{
			name: 'the file actions',
			getter: (): (() => unknown) => actionServices().getWorkerClient,
		},
	])('hands $name the one worker client', async ({ getter }) => {
		// One encoder process per session: a second would double the memory a
		// long conversion needs on a phone.
		const { plugin } = await loadPlugin();
		const worker = (plugin as unknown as { encodingWorker: unknown })
			.encodingWorker;

		expect(getter()()).toBe(worker);
	});
});

describe('the services the file actions run with', () => {
	it('persists a settings change made by an action', async () => {
		const { plugin } = await loadPlugin();
		plugin.settings.filePrefix = 'from-an-action';

		await actionServices().saveSettings();

		expect(
			(plugin as unknown as { saveData: jest.Mock }).saveData,
		).toHaveBeenCalled();
	});

	it('enhances the files an action produced', async () => {
		await loadPlugin();

		actionServices().primeForEnhancement(['Recordings/converted.mp3']);

		const primed = at(jest.mocked(EnhancedPlayerRegistrar).mock.results, 0)
			.value as { primeSavedRecordingsForEnhancement: jest.Mock };
		expect(primed.primeSavedRecordingsForEnhancement).toHaveBeenCalledWith([
			'Recordings/converted.mp3',
		]);
	});

	it('shares the one sidecar store, so markers and transcripts agree', async () => {
		const { plugin } = await loadPlugin();

		expect(actionServices().recordingSidecar).toBe(
			(plugin as unknown as { sidecarStore: unknown }).sidecarStore,
		);
	});

	it('shares the one chapter service, so its cost joins the session total', async () => {
		const { plugin } = await loadPlugin();

		expect(actionServices().autoChapters).toBe(
			(plugin as unknown as { autoChapterService: unknown })
				.autoChapterService,
		);
	});
});

describe('the options a transcription run is opened with', () => {
	/** Fresh options, as an action asks for them. */
	async function options(): Promise<{
		plugin: AudioRecorderPlugin;
		modalOptions: TranscriptionModalOptions;
	}> {
		const { plugin } = await loadPlugin();
		return {
			plugin,
			modalOptions: actionServices().createTranscriptionModalOptions(),
		};
	}

	it.each([
		{ name: 'the dictionary profile', kind: 'dictionary' },
		{ name: 'the chapter profile', kind: 'chapterPrompt' },
		{ name: 'the participant profile', kind: 'participants' },
	] as const)('remembers $name the run was given', async ({ kind }) => {
		// The choice defaults the next run and applies to transcribe-on-save,
		// so it has to survive the dialog it was made in. One callback serves
		// every kind, so the kind it was given is what decides where it lands.
		const { plugin, modalOptions } = await options();

		await modalOptions.onProfileSelected?.(kind, 'profile-7');

		expect(plugin.settings.selectedProfileIds[kind]).toBe('profile-7');
		expect(
			(plugin as unknown as { saveData: jest.Mock }).saveData,
		).toHaveBeenCalled();
	});

	it('generates chapters from the transcript the run just produced', async () => {
		// Working from the in-memory transcript is what lets chapters appear
		// without a second read of the note that was only just written.
		const { modalOptions } = await options();
		const file = { path: 'Recordings/take.webm' } as TFile;
		const transcript: Transcript = { segments: [], speakers: [] };

		await modalOptions.generateChapters?.(file, transcript);

		expect(chapterService().generate).toHaveBeenCalledWith(
			file,
			transcript,
		);
	});

	it('reports its cost to the one session counter', async () => {
		const { plugin, modalOptions } = await options();

		expect(modalOptions.costTracker).toBe(
			(plugin as unknown as { transcriptionCostTracker: unknown })
				.transcriptionCostTracker,
		);
	});

	it('writes its outputs into the shared sidecar', async () => {
		const { plugin, modalOptions } = await options();

		expect(modalOptions.sidecar).toBe(
			(plugin as unknown as { sidecarStore: unknown }).sidecarStore,
		);
	});
});

describe('a collaborator that fails under the plugin', () => {
	beforeEach(() => {
		jest.spyOn(console, 'error').mockImplementation(() => undefined);
		jest.spyOn(console, 'warn').mockImplementation(() => undefined);
	});

	it('surfaces a chapter-generation failure to whoever asked for it', async () => {
		// The plugin's closure awaits the chapter service and hands the
		// rejection back to the transcription run, which is the only place
		// that knows a dialog is open and can report it. Swallowing it here
		// would leave the run claiming chapters it never wrote.
		const { plugin } = await loadPlugin();
		const modalOptions = actionServices().createTranscriptionModalOptions();
		chapterService().generate.mockRejectedValue(
			new Error('note is read-only'),
		);

		await expect(
			modalOptions.generateChapters?.(
				{ path: 'Recordings/take.webm' } as TFile,
				{ segments: [], speakers: [] },
			),
		).rejects.toThrow('note is read-only');
		// The plugin is still the one holding the service afterwards, so a
		// second run does not need a reload.
		expect(actionServices().autoChapters).toBe(
			(plugin as unknown as { autoChapterService: unknown })
				.autoChapterService,
		);
	});

	it('keeps the settings usable when persisting a choice fails', async () => {
		// data.json can be unwritable - a full disk, a sync lock. The choice
		// still has to apply to the run in progress, because the alternative
		// is a dialog that silently ignores what the user just picked.
		const { plugin } = await loadPlugin();
		(
			plugin as unknown as { saveData: jest.Mock }
		).saveData.mockRejectedValue(new Error('disk full'));
		const modalOptions = actionServices().createTranscriptionModalOptions();

		await modalOptions
			.onProfileSelected?.('dictionary', 'profile-7')
			.catch(() => {
				// The write failing is the scenario; what it did to the
				// settings in memory is what this test is about.
			});

		expect(plugin.settings.selectedProfileIds.dictionary).toBe('profile-7');
	});
});
