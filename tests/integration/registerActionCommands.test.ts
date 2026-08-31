/**
 * Tests for the one registration path every action kind shares: a file
 * action becomes a palette command over the active audio file, a session
 * action over the recorder, and a playback action over the snapshot of
 * what is playing. What differs between them is the resolver, so the
 * cases below drive the same registrar three times.
 * @module tests/integration/registerActionCommands.test
 */

import { TFile } from 'obsidian';
import { at } from '../helpers/assertions';
import type { Plugin } from 'obsidian';
import { registerActionCommands } from 'src/actions/registerActionCommands';
import { activeAudioFile, FILE_ACTIONS } from 'src/actions/fileActions';
import { SESSION_ACTIONS } from 'src/actions/sessionActions';
import { PLAYBACK_ACTIONS } from 'src/actions/playbackActions';
import { showDeviceSelectionModal } from 'src/ui/DeviceSelectionModal';
import { useMobilePlatform } from '../helpers/platform';
import { tick } from '../helpers/async';
import { COMMAND_IDS } from 'src/constants';
import { MARKER_KIND } from 'src/markers/markerModel';
import type {
	ActionServices,
	FileAction,
	PluginCommand,
	RecordingSessionPort,
	SessionServices,
} from 'src/actions/PluginAction';
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
jest.mock('src/ui/DeviceSelectionModal', () => ({
	showDeviceSelectionModal: jest.fn().mockResolvedValue(undefined),
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

describe('file actions over the active audio file', () => {
	it('registers a palette command for every file action', () => {
		const commands: RegisteredCommand[] = [];
		registerActionCommands(
			makePlugin(commands),
			FILE_ACTIONS,
			activeAudioFile(makeServices(audioFile())),
		);

		expect(commands.map((c) => c.id)).toEqual([
			COMMAND_IDS.audioFileInfo,
			COMMAND_IDS.convertAudioFormat,
			COMMAND_IDS.splitAudio,
			COMMAND_IDS.cleanupAudio,
			COMMAND_IDS.transcribeAudio,
			COMMAND_IDS.retryFailedParts,
			COMMAND_IDS.renameSpeakers,
			COMMAND_IDS.generateChapters,
			COMMAND_IDS.deleteRecording,
		]);
	});

	it('reports commands available when the active file is audio', () => {
		const commands: RegisteredCommand[] = [];
		registerActionCommands(
			makePlugin(commands),
			FILE_ACTIONS,
			activeAudioFile(makeServices(audioFile())),
		);

		for (const command of commands) {
			expect(command.checkCallback(true)).toBe(true);
		}
	});

	it('reports commands unavailable without an active audio file', () => {
		const commands: RegisteredCommand[] = [];
		registerActionCommands(
			makePlugin(commands),
			FILE_ACTIONS,
			activeAudioFile(makeServices(null)),
		);

		for (const command of commands) {
			expect(command.checkCallback(true)).toBe(false);
		}
	});

	it('reports commands unavailable for a non-audio active file', () => {
		const commands: RegisteredCommand[] = [];
		registerActionCommands(
			makePlugin(commands),
			FILE_ACTIONS,
			activeAudioFile(makeServices(audioFile('md'))),
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
		registerActionCommands(
			makePlugin(commands),
			[gated],
			activeAudioFile(services),
		);

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
		registerActionCommands(
			makePlugin(commands),
			[action],
			activeAudioFile(services),
		);

		expect(at(commands, 0).checkCallback(false)).toBe(true);
		expect(run).toHaveBeenCalledWith({ file, services });
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
		registerActionCommands(
			makePlugin(commands),
			[action],
			activeAudioFile(makeServices(audioFile())),
		);

		at(commands, 0).checkCallback(true);
		expect(run).not.toHaveBeenCalled();
	});
});

/**
 * Runs a registered command the way the palette does: ask first, run only
 * when the answer is yes.
 * @param commands - The commands the registrar recorded
 * @param id - Command to invoke
 * @returns Whether the command reported itself available
 */
function invokeCommand(commands: RegisteredCommand[], id: string): boolean {
	const command = at(
		commands.filter((entry) => entry.id === id),
		0,
	);
	if (!command.checkCallback(true)) {
		return false;
	}
	command.checkCallback(false);
	return true;
}

/** What the session double reports about itself. */
interface SessionState {
	/** Whether a session is recording or paused right now. */
	active?: boolean;
	/** Whether the player markers feature is on. */
	markersEnabled?: boolean;
}

/**
 * A recording session double whose port calls are observable. It derives
 * canDropMarker from the two conditions the manager derives it from, so a
 * test cannot describe a recorder that could not exist.
 * @param state - The session the double stands for
 * @returns The services the actions run against, plus the spies behind them
 */
function makeSession({
	active = true,
	markersEnabled = true,
}: SessionState = {}): {
	services: SessionServices;
	recording: jest.Mocked<RecordingSessionPort>;
	openMarkerModal: jest.Mock;
	saveSettings: jest.Mock;
	settings: AudioRecorderSettings;
} {
	const recording = {
		toggleRecording: jest.fn().mockResolvedValue(undefined),
		isSessionActive: jest.fn(() => active),
		togglePauseResume: jest.fn(),
		canDropMarker: jest.fn(() => active && markersEnabled),
	} as unknown as jest.Mocked<RecordingSessionPort>;
	const openMarkerModal = jest.fn();
	const saveSettings = jest.fn().mockResolvedValue(undefined);
	const settings = partial<AudioRecorderSettings>({ audioDeviceId: '' });
	return {
		recording,
		openMarkerModal,
		saveSettings,
		settings,
		services: {
			app: createMockApp({}).app,
			getSettings: () => settings,
			saveSettings,
			recording,
			openMarkerModal,
		},
	};
}

describe('session actions over the recorder', () => {
	/**
	 * Registers the real session actions against one session double.
	 * @param state - The session the double stands for
	 * @returns The registered commands and the session double behind them
	 */
	function registerSession(state: SessionState = {}): {
		commands: RegisteredCommand[];
		session: ReturnType<typeof makeSession>;
	} {
		const commands: RegisteredCommand[] = [];
		const session = makeSession(state);
		registerActionCommands(
			makePlugin(commands),
			SESSION_ACTIONS,
			() => session.services,
		);
		return { commands, session };
	}

	it('registers every session command in palette order', () => {
		const { commands } = registerSession();

		expect(commands.map((command) => command.id)).toEqual([
			COMMAND_IDS.startStopRecording,
			COMMAND_IDS.pauseResumeRecording,
			COMMAND_IDS.addRecordingMarker,
			COMMAND_IDS.addRecordingBookmark,
			COMMAND_IDS.addRecordingChapter,
			COMMAND_IDS.selectAudioInputDevice,
		]);
	});

	it('drives capture whether or not a session is running', () => {
		const idle = registerSession({ active: false });
		const live = registerSession({ active: true });

		expect(
			invokeCommand(idle.commands, COMMAND_IDS.startStopRecording),
		).toBe(true);
		expect(
			invokeCommand(live.commands, COMMAND_IDS.startStopRecording),
		).toBe(true);

		// Starting is what this command does when nothing is running, so it
		// is the one session command with nothing to gate on.
		expect(idle.session.recording.toggleRecording).toHaveBeenCalledTimes(1);
		expect(live.session.recording.toggleRecording).toHaveBeenCalledTimes(1);
	});

	it('drives pause only while a session is running', () => {
		const idle = registerSession({ active: false });
		// Markers are off, so the gate that answers here is the session one
		const live = registerSession({ active: true, markersEnabled: false });

		expect(
			invokeCommand(idle.commands, COMMAND_IDS.pauseResumeRecording),
		).toBe(false);
		expect(
			invokeCommand(live.commands, COMMAND_IDS.pauseResumeRecording),
		).toBe(true);

		// An idle recorder has nothing to pause, so a key bound to this falls
		// through to whatever else claims it.
		expect(idle.session.recording.togglePauseResume).not.toHaveBeenCalled();
		expect(live.session.recording.togglePauseResume).toHaveBeenCalledTimes(
			1,
		);
	});

	it('opens the marker modal with the kind the command fixes', () => {
		const { commands, session } = registerSession();

		// The chooser command fixes no kind, so the modal asks for one
		expect(invokeCommand(commands, COMMAND_IDS.addRecordingMarker)).toBe(
			true,
		);
		expect(session.openMarkerModal).toHaveBeenLastCalledWith();
		expect(invokeCommand(commands, COMMAND_IDS.addRecordingBookmark)).toBe(
			true,
		);
		expect(session.openMarkerModal).toHaveBeenLastCalledWith(
			MARKER_KIND.bookmark,
		);
		expect(invokeCommand(commands, COMMAND_IDS.addRecordingChapter)).toBe(
			true,
		);
		expect(session.openMarkerModal).toHaveBeenLastCalledWith(
			MARKER_KIND.chapter,
		);
	});

	it('withholds all three marker commands when nothing can be dropped', () => {
		const { commands, session } = registerSession({
			markersEnabled: false,
		});

		expect(invokeCommand(commands, COMMAND_IDS.addRecordingMarker)).toBe(
			false,
		);
		expect(invokeCommand(commands, COMMAND_IDS.addRecordingBookmark)).toBe(
			false,
		);
		expect(invokeCommand(commands, COMMAND_IDS.addRecordingChapter)).toBe(
			false,
		);
		expect(session.openMarkerModal).not.toHaveBeenCalled();
	});

	it('stores the device the picker returns', async () => {
		jest.mocked(showDeviceSelectionModal).mockImplementation(
			async (_app, onDeviceSelected) => {
				await onDeviceSelected('device-7', 'Device 7');
			},
		);
		const { commands, session } = registerSession();

		expect(
			invokeCommand(commands, COMMAND_IDS.selectAudioInputDevice),
		).toBe(true);
		await tick();

		expect(session.settings.audioDeviceId).toBe('device-7');
		expect(session.saveSettings).toHaveBeenCalledTimes(1);
	});

	it('hides the device picker where the platform cannot select one', () => {
		// Mobile records from the default microphone, so the command has
		// nothing to offer and must stay out of the palette.
		useMobilePlatform();
		const { commands } = registerSession();

		expect(
			invokeCommand(commands, COMMAND_IDS.selectAudioInputDevice),
		).toBe(false);
		expect(showDeviceSelectionModal).not.toHaveBeenCalled();
	});
});

describe('playback actions over the active snapshot', () => {
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
		registerActionCommands(
			makePlugin(commands),
			PLAYBACK_ACTIONS,
			() => state,
		);
		return {
			commands,
			invoke: (id: string): boolean => invokeCommand(commands, id),
		};
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
			COMMAND_IDS.toggleChapterLoop,
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

describe('an action that fails', () => {
	it('names the command in the console instead of vanishing', async () => {
		const commands: RegisteredCommand[] = [];
		const failure = new Error('the modal refused to open');
		const reported = jest
			.spyOn(console, 'error')
			.mockImplementation(() => undefined);
		const failing: PluginCommand<object> = {
			commandId: 'failing-action',
			title: 'Failing action',
			icon: 'bug',
			isAvailable: () => true,
			run: () => Promise.reject(failure),
		};
		registerActionCommands(makePlugin(commands), [failing], () => ({}));

		expect(at(commands, 0).checkCallback(false)).toBe(true);
		await tick();

		// Obsidian discards whatever a command returns, so this line is the
		// only trace a rejected action leaves behind.
		expect(reported).toHaveBeenCalledWith(
			expect.stringContaining('failing-action'),
			failure,
		);
	});
});
