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

import { App } from 'obsidian';
import type { PluginManifest, TFile } from 'obsidian';
import AudioRecorderPlugin from 'src/main';
import { RecordingStatus } from 'src/types';
import type { ActionServices } from 'src/actions/PluginAction';
import type { TranscriptionModalOptions } from 'src/ui/TranscriptionModal';
import type { Transcript } from 'src/transcription/TranscriptTypes';
import { AutoChapterService } from 'src/chapters/AutoChapterService';
import { ContextMenu } from 'src/ui/ContextMenu';
import { EnhancedPlayerRegistrar } from 'src/player/EnhancedPlayerRegistrar';
import { RecordingManager } from 'src/recording/RecordingManager';
import { at, defined } from '../helpers/assertions';
import { partial } from '../helpers/doubles';

jest.mock('src/recording/RecordingManager', () => ({
	RecordingManager: jest.fn().mockImplementation(() => ({
		toggleRecording: jest.fn().mockResolvedValue(undefined),
		togglePauseResume: jest.fn(),
		stopRecording: jest.fn().mockResolvedValue(undefined),
		cleanup: jest.fn(),
		updateSettings: jest.fn(),
		getStatus: jest.fn(() => RecordingStatus.Idle),
		canDropMarker: jest.fn(() => false),
		captureMarkerDraft: jest.fn(() => null),
		getElapsedMs: jest.fn(() => 0),
		getRecordedBytes: jest.fn(() => 0),
		getInputLevel: jest.fn(() => 0),
	})),
}));
jest.mock('src/ui/ContextMenu', () => ({
	ContextMenu: jest.fn().mockImplementation(() => ({ register: jest.fn() })),
}));
jest.mock('src/player/EnhancedPlayerRegistrar', () => ({
	EnhancedPlayerRegistrar: jest.fn().mockImplementation(() => ({
		register: jest.fn(),
		dispose: jest.fn(),
		refresh: jest.fn(),
		subscribePlayback: jest.fn(),
		reloadMarkersFor: jest.fn(),
		primeSavedRecordingsForEnhancement: jest.fn(),
	})),
}));
jest.mock('src/chapters/AutoChapterService', () => ({
	AutoChapterService: jest.fn().mockImplementation(() => ({
		generate: jest.fn().mockResolvedValue(undefined),
	})),
}));
jest.mock('src/recording/RecoveryService', () => ({
	collectRecoverableSessions: jest.fn().mockResolvedValue([]),
	recoverSession: jest
		.fn()
		.mockResolvedValue({ recoveredPaths: [], failedTracks: [] }),
	discardSession: jest.fn().mockResolvedValue([]),
}));

const MANIFEST = partial<PluginManifest>({
	id: 'advanced-audio-recorder',
	name: 'Advanced Audio Recorder',
	version: '2.2.2',
	dir: 'config-dir/plugins/advanced-audio-recorder',
});

/** Loads the plugin the way Obsidian does and hands it back. */
async function loadPlugin(): Promise<AudioRecorderPlugin> {
	const plugin = new AudioRecorderPlugin(new App(), MANIFEST);
	const store = plugin as unknown as Record<string, unknown>;
	store.loadData = jest.fn().mockResolvedValue(null);
	store.saveData = jest.fn().mockResolvedValue(undefined);
	await plugin.onload();
	return plugin;
}

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
		const plugin = await loadPlugin();

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
		const plugin = await loadPlugin();
		const worker = (plugin as unknown as { encodingWorker: unknown })
			.encodingWorker;

		expect(getter()()).toBe(worker);
	});
});

describe('the services the file actions run with', () => {
	it('persists a settings change made by an action', async () => {
		const plugin = await loadPlugin();
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
		const plugin = await loadPlugin();

		expect(actionServices().recordingSidecar).toBe(
			(plugin as unknown as { sidecarStore: unknown }).sidecarStore,
		);
	});

	it('shares the one chapter service, so its cost joins the session total', async () => {
		const plugin = await loadPlugin();

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
		const plugin = await loadPlugin();
		return {
			plugin,
			modalOptions: actionServices().createTranscriptionModalOptions(),
		};
	}

	it.each([
		{
			name: 'the dictionary profile',
			callback: 'onProfileSelected',
			setting: 'transcriptionDictionaryProfileId',
		},
		{
			name: 'the chapter profile',
			callback: 'onChapterProfileSelected',
			setting: 'transcriptionChapterPromptProfileId',
		},
		{
			name: 'the participant profile',
			callback: 'onSpeakerProfileSelected',
			setting: 'transcriptionSpeakerProfileId',
		},
	])('remembers $name the run was given', async ({ callback, setting }) => {
		// The choice defaults the next run and applies to transcribe-on-save,
		// so it has to survive the dialog it was made in.
		const { plugin, modalOptions } = await options();
		const remember = modalOptions[
			callback as keyof TranscriptionModalOptions
		] as (id: string) => Promise<void>;

		await remember('profile-7');

		expect(
			(plugin.settings as unknown as Record<string, unknown>)[setting],
		).toBe('profile-7');
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
