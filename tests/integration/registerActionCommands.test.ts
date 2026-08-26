/**
 * Unit tests for the action registry command registration: every file
 * action becomes a palette command over the active file, and the
 * recording marker actions register kind-fixed commands behind the
 * session gate, and the playback actions register behind the active
 * playback snapshot.
 * @module tests/unit/registerActionCommands.test
 */

import { TFile } from 'obsidian';
import { at } from '../helpers/assertions';
import type { Plugin } from 'obsidian';
import {
	registerFileActionCommands,
	registerPlaybackActionCommands,
	registerRecordingActionCommands,
} from 'src/actions/registerActionCommands';
import { FILE_ACTIONS } from 'src/actions/fileActions';
import { createRecordingMarkerActions } from 'src/actions/recordingMarkerActions';
import { createPlaybackActions } from 'src/actions/playbackActions';
import { COMMAND_IDS } from 'src/constants';
import { MARKER_KIND } from 'src/markers/markerModel';
import type { ActionServices, FileAction } from 'src/actions/PluginAction';
import type { PlaybackControlsState } from 'src/player/playbackControls';
import { makePlaybackState } from '../helpers/playbackHarness';
import type { AudioRecorderSettings } from 'src/settings/settingsSchema';
import { partialPlugin } from '../helpers/obsidianMock';
import { partial } from '../helpers/doubles';
import { createMockApp } from '../helpers/createApp';

jest.mock('src/ui/AudioFileInfoModal', () => ({
	AudioFileInfoModal: jest
		.fn()
		.mockImplementation(() => ({ open: jest.fn() })),
}));
jest.mock('src/ui/ConversionModal', () => ({
	ConversionModal: jest.fn().mockImplementation(() => ({ open: jest.fn() })),
}));
jest.mock('src/ui/SplitModal', () => ({
	SplitModal: jest.fn().mockImplementation(() => ({ open: jest.fn() })),
}));
jest.mock('src/ui/TranscriptionModal', () => ({
	TranscriptionModal: jest
		.fn()
		.mockImplementation(() => ({ open: jest.fn() })),
}));
jest.mock('src/cleanup/AudioProcessingModal', () => ({
	AudioProcessingModal: jest
		.fn()
		.mockImplementation(() => ({ open: jest.fn() })),
}));
jest.mock('src/audio/AudioEncoder', () => ({
	encodeAudioBuffer: jest.fn(),
	isOfflineEncodingSupported: jest.fn().mockReturnValue(true),
}));

/** Command registered through the plugin double. */
interface RegisteredCommand {
	id: string;
	name: string;
	checkCallback: (checking: boolean) => boolean;
}

function audioFile(extension = 'mp3'): TFile {
	return Object.assign(Object.create(TFile.prototype), {
		path: `recording.${extension}`,
		extension,
	}) as TFile;
}

function makeServices(activeFile: TFile | null): ActionServices {
	return {
		app: createMockApp({
			workspace: { getActiveFile: () => activeFile },
			fileManager: { trashFile: jest.fn() },
		}).app,
		getSettings: () =>
			partial<AudioRecorderSettings>({
				transcriptionEnabled: true,
				transcriptionSpeakerRenameEnabled: true,
				transcriptionAutoChaptersEnabled: true,
			}),
		saveSettings: () => Promise.resolve(),
		createTranscriptionModalOptions: () => ({}),
		primeForEnhancement: () => {},
		getWorkerClient: () => null,
		autoChapters: partial<ActionServices>({
			generate: jest.fn(),
		})['autoChapters'],
		recordingSidecar: partial<ActionServices>({
			getTranscript: jest.fn().mockResolvedValue(null),
			updateTranscript: jest.fn().mockResolvedValue(undefined),
		})['recordingSidecar'],
	};
}

function makePlugin(commands: RegisteredCommand[]): Plugin {
	return partialPlugin({
		addCommand: jest.fn((command: RegisteredCommand) => {
			commands.push(command);
		}),
	});
}

describe('registerFileActionCommands', () => {
	it('registers a palette command for every file action', () => {
		const commands: RegisteredCommand[] = [];
		registerFileActionCommands(
			makePlugin(commands),
			FILE_ACTIONS,
			makeServices(audioFile()),
		);

		expect(commands.map((c) => c.id)).toEqual([
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

	it('reports commands available when the active file is audio', () => {
		const commands: RegisteredCommand[] = [];
		registerFileActionCommands(
			makePlugin(commands),
			FILE_ACTIONS,
			makeServices(audioFile()),
		);

		for (const command of commands) {
			expect(command.checkCallback(true)).toBe(true);
		}
	});

	it('reports commands unavailable without an active audio file', () => {
		const commands: RegisteredCommand[] = [];
		registerFileActionCommands(
			makePlugin(commands),
			FILE_ACTIONS,
			makeServices(null),
		);

		for (const command of commands) {
			expect(command.checkCallback(true)).toBe(false);
		}
	});

	it('reports commands unavailable for a non-audio active file', () => {
		const commands: RegisteredCommand[] = [];
		registerFileActionCommands(
			makePlugin(commands),
			FILE_ACTIONS,
			makeServices(audioFile('md')),
		);

		for (const command of commands) {
			expect(command.checkCallback(true)).toBe(false);
		}
	});

	it('honors the per-action availability gate', () => {
		const commands: RegisteredCommand[] = [];
		const services = makeServices(audioFile());
		const gated: FileAction = {
			commandId: 'gated-action',
			title: 'Gated action',
			icon: 'info',
			showInEditorMenu: true,
			isAvailable: () => false,
			run: jest.fn(),
		};
		registerFileActionCommands(makePlugin(commands), [gated], services);

		expect(at(commands, 0).checkCallback(true)).toBe(false);
	});

	it('runs the action with the active file when invoked', () => {
		const commands: RegisteredCommand[] = [];
		const file = audioFile();
		const services = makeServices(file);
		const run = jest.fn();
		const action: FileAction = {
			commandId: 'run-me',
			title: 'Run me',
			icon: 'info',
			showInEditorMenu: true,
			isAvailable: () => true,
			run,
		};
		registerFileActionCommands(makePlugin(commands), [action], services);

		expect(at(commands, 0).checkCallback(false)).toBe(true);
		expect(run).toHaveBeenCalledWith(file, services);
	});

	it('does not run the action while only checking', () => {
		const commands: RegisteredCommand[] = [];
		const run = jest.fn();
		const action: FileAction = {
			commandId: 'check-only',
			title: 'Check only',
			icon: 'info',
			showInEditorMenu: true,
			isAvailable: () => true,
			run,
		};
		registerFileActionCommands(
			makePlugin(commands),
			[action],
			makeServices(audioFile()),
		);

		at(commands, 0).checkCallback(true);
		expect(run).not.toHaveBeenCalled();
	});
});

describe('registerRecordingActionCommands', () => {
	it('registers kind-fixed bookmark and chapter commands', () => {
		const commands: RegisteredCommand[] = [];
		const openMarkerModal = jest.fn();
		registerRecordingActionCommands(
			makePlugin(commands),
			createRecordingMarkerActions(openMarkerModal),
			() => true,
		);

		expect(commands.map((c) => c.id)).toEqual([
			COMMAND_IDS.addRecordingBookmark,
			COMMAND_IDS.addRecordingChapter,
		]);

		at(commands, 0).checkCallback(false);
		expect(openMarkerModal).toHaveBeenLastCalledWith(MARKER_KIND.bookmark);
		at(commands, 1).checkCallback(false);
		expect(openMarkerModal).toHaveBeenLastCalledWith(MARKER_KIND.chapter);
	});

	it('gates both commands on the recording state', () => {
		const commands: RegisteredCommand[] = [];
		const openMarkerModal = jest.fn();
		registerRecordingActionCommands(
			makePlugin(commands),
			createRecordingMarkerActions(openMarkerModal),
			() => false,
		);

		for (const command of commands) {
			expect(command.checkCallback(true)).toBe(false);
			expect(command.checkCallback(false)).toBe(false);
		}
		expect(openMarkerModal).not.toHaveBeenCalled();
	});
});

describe('registerPlaybackActionCommands', () => {
	/**
	 * Registers the real playback actions against one snapshot and returns
	 * a runner that invokes a command the way the palette would.
	 * @param state - Snapshot the commands see, null while nothing plays
	 * @returns The registered commands and a palette-style runner
	 */
	function registerAgainst(state: PlaybackControlsState | null): {
		commands: RegisteredCommand[];
		invoke: (id: string) => boolean;
	} {
		const commands: RegisteredCommand[] = [];
		registerPlaybackActionCommands(
			makePlugin(commands),
			createPlaybackActions(),
			() => state,
		);
		const invoke = (id: string): boolean => {
			const command = at(
				commands.filter((entry) => entry.id === id),
				0,
			);
			if (!command.checkCallback(true)) {
				return false;
			}
			command.checkCallback(false);
			return true;
		};
		return { commands, invoke };
	}

	it('registers every playback command in palette order', () => {
		const { commands } = registerAgainst(makePlaybackState());

		expect(commands.map((command) => command.id)).toEqual([
			COMMAND_IDS.togglePlayback,
			COMMAND_IDS.stopPlayback,
			COMMAND_IDS.skipPlaybackBack,
			COMMAND_IDS.skipPlaybackForward,
			COMMAND_IDS.togglePlaybackMute,
			COMMAND_IDS.increasePlaybackSpeed,
			COMMAND_IDS.decreasePlaybackSpeed,
			COMMAND_IDS.previousChapter,
			COMMAND_IDS.nextChapter,
			COMMAND_IDS.addPlaybackBookmark,
			COMMAND_IDS.addPlaybackChapter,
		]);
	});

	it.each([
		{ id: COMMAND_IDS.togglePlayback, command: 'onTogglePlay', args: [] },
		{ id: COMMAND_IDS.stopPlayback, command: 'onStop', args: [] },
		{ id: COMMAND_IDS.skipPlaybackBack, command: 'onSkip', args: [-10] },
		{ id: COMMAND_IDS.skipPlaybackForward, command: 'onSkip', args: [10] },
		{
			id: COMMAND_IDS.togglePlaybackMute,
			command: 'onToggleMute',
			args: [],
		},
		{
			id: COMMAND_IDS.previousChapter,
			command: 'onPreviousChapter',
			args: [],
		},
		{ id: COMMAND_IDS.nextChapter, command: 'onNextChapter', args: [] },
		{
			id: COMMAND_IDS.addPlaybackBookmark,
			command: 'onAddMarker',
			args: [MARKER_KIND.bookmark],
		},
		{
			id: COMMAND_IDS.addPlaybackChapter,
			command: 'onAddMarker',
			args: [MARKER_KIND.chapter],
		},
	] satisfies {
		id: string;
		command: keyof PlaybackControlsState;
		args: unknown[];
	}[])('$id calls $command', ({ id, command, args }) => {
		const state = makePlaybackState();
		const { invoke } = registerAgainst(state);

		expect(invoke(id)).toBe(true);

		expect(state[command]).toHaveBeenCalledWith(...args);
	});

	it.each([
		{ id: COMMAND_IDS.increasePlaybackSpeed, rate: 1.5 },
		{ id: COMMAND_IDS.decreasePlaybackSpeed, rate: 1 },
	])('$id steps to the neighbouring preset', ({ id, rate }) => {
		// The step lands on a preset the player's own speed menu offers, so
		// the button never shows a speed the menu cannot tick.
		const state = makePlaybackState({ playbackRate: 1.25 });
		const { invoke } = registerAgainst(state);

		expect(invoke(id)).toBe(true);

		expect(state.onSetPlaybackRate).toHaveBeenCalledWith(rate);
	});

	it('offers nothing while no playback is active', () => {
		const { commands, invoke } = registerAgainst(null);

		for (const command of commands) {
			expect(invoke(command.id)).toBe(false);
		}
	});

	it('withholds the marker commands when the player forbids markers', () => {
		const state = makePlaybackState({ markersEnabled: false });
		const { invoke } = registerAgainst(state);

		expect(invoke(COMMAND_IDS.addPlaybackBookmark)).toBe(false);
		expect(invoke(COMMAND_IDS.addPlaybackChapter)).toBe(false);
		expect(state.onAddMarker).not.toHaveBeenCalled();
		// Transport is unaffected by the marker setting
		expect(invoke(COMMAND_IDS.togglePlayback)).toBe(true);
	});

	it('withholds the chapter commands when the player has no chapters', () => {
		const state = makePlaybackState({ chaptersEnabled: false });
		const { invoke } = registerAgainst(state);

		expect(invoke(COMMAND_IDS.previousChapter)).toBe(false);
		expect(invoke(COMMAND_IDS.nextChapter)).toBe(false);
		expect(state.onNextChapter).not.toHaveBeenCalled();
	});
});
