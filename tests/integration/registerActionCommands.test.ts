/**
 * Tests for the real action families on the palette: a file action is a
 * command over the recordings of what is active, a session action over the
 * recorder, and a playback action over the snapshot of what is playing. What
 * differs between them is the family's resolver, so the cases below drive the
 * same registration three times.
 * @module tests/integration/registerActionCommands.test
 */

import type { Plugin } from 'obsidian';
import { registerActionCommands } from 'src/actions/registerActionCommands';
import { FILE_ACTIONS, fileActionFamily } from 'src/actions/fileActions';
import { sessionActionFamily } from 'src/actions/sessionActions';
import { playbackActionFamily } from 'src/actions/playbackActions';
import { showDeviceSelectionModal } from 'src/ui/DeviceSelectionModal';
import { TranscriptionModal } from 'src/ui/TranscriptionModal';
import { useMobilePlatform } from '../helpers/platform';
import { tick } from '../helpers/async';
import { COMMAND_IDS } from 'src/constants';
import { MARKER_KIND } from 'src/markers/markerModel';
import type {
	ActionFamily,
	RecordingSessionPort,
	SessionServices,
} from 'src/actions/PluginAction';
import type { PlaybackControlsState } from 'src/player/playbackControls';
import { makePlaybackState } from '../helpers/playbackHarness';
import type { AudioRecorderSettings } from 'src/settings/settingsSchema';
import { asMockPlugin, mockPluginHost } from '../helpers/obsidianMock';
import { partial } from '../helpers/doubles';
import { createMockApp } from '../helpers/createApp';
import { recordingVault } from '../helpers/recordingVault';
import { at } from '../helpers/assertions';

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

/**
 * Registers one family on a plugin double, with a picker spy for the case of
 * several targets.
 * @param family - The family to register
 * @returns The plugin, its runner, and the picker
 */
function register<TContext>(family: ActionFamily<TContext>): {
	plugin: ReturnType<typeof asMockPlugin>;
	invoke: (id: string) => boolean;
	pick: jest.Mock;
} {
	const host: Plugin = mockPluginHost(createMockApp().app);
	const pick = jest.fn();
	registerActionCommands(host, family, pick);
	const plugin = asMockPlugin(host);
	return { plugin, invoke: (id) => plugin.invokeCommand(id), pick };
}

const STANDUP = 'Recordings/standup.webm';
const RETRO = 'Recordings/retro.mp3';
const MEETING = 'Meetings/Team Meeting.md';

/** The file actions over a vault with two recordings and a meeting note. */
function registerFiles(
	active: string | undefined,
	meeting: readonly string[] = [STANDUP],
): ReturnType<typeof register> & ReturnType<typeof recordingVault> {
	const vault = recordingVault({
		recordings: [STANDUP, RETRO, 'Images/slide.png'],
		notes: { [MEETING]: meeting },
		...(active ? { active } : {}),
		settings: {
			transcriptionSpeakerRenameEnabled: true,
			transcriptionAutoChaptersEnabled: true,
		},
	});
	return { ...vault, ...register(fileActionFamily(vault.services)) };
}

describe('file actions over what is active', () => {
	it('registers a palette command for every file action', () => {
		const { plugin } = registerFiles(undefined);

		// In the family's order, which the file actions suite pins.
		expect(plugin.registeredCommands.map((c) => c.id)).toEqual(
			FILE_ACTIONS.map((entry) => entry.commandId),
		);
	});

	it('offers every command but the link-aware delete on an open recording', () => {
		const { plugin } = registerFiles(STANDUP);

		// The audio file opened on its own has no note, so no link to remove.
		expect(
			plugin.registeredCommands
				.filter((command) => command.checkCallback?.(true) === true)
				.map((command) => command.id),
		).not.toContain(COMMAND_IDS.deleteRecordingAndLink);
		expect(
			plugin.registeredCommands.filter(
				(command) => command.checkCallback?.(true) === false,
			),
		).toHaveLength(1);
	});

	it.each([
		{ name: 'nothing is open', active: undefined },
		{ name: 'an image is open', active: 'Images/slide.png' },
	])('offers none of them when $name', ({ active }) => {
		const { plugin } = registerFiles(active);

		expect(
			plugin.registeredCommands.filter(
				(command) => command.checkCallback?.(true) === true,
			),
		).toEqual([]);
	});

	it('transcribes the recording of the open note into that note', () => {
		const { invoke } = registerFiles(MEETING);

		expect(invoke(COMMAND_IDS.transcribeAudio)).toBe(true);

		expect(jest.mocked(TranscriptionModal)).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ path: STANDUP }),
			expect.any(Function),
			expect.objectContaining({ notePath: MEETING }),
		);
	});

	it('asks which recording when the open note embeds several', () => {
		const { invoke, pick } = registerFiles(MEETING, [STANDUP, RETRO]);

		expect(invoke(COMMAND_IDS.transcribeAudio)).toBe(true);

		expect(at(pick.mock.calls, 0)[0]).toHaveLength(2);
		expect(TranscriptionModal).not.toHaveBeenCalled();
	});

	it('offers the link-aware delete from the open note', () => {
		const { plugin } = registerFiles(MEETING);

		expect(
			plugin.registeredCommands
				.find(
					(command) =>
						command.id === COMMAND_IDS.deleteRecordingAndLink,
				)
				?.checkCallback?.(true),
		).toBe(true);
	});
});

/** What the session double reports about itself. */
interface SessionState {
	/** Whether a session is recording or paused right now. */
	active?: boolean;
	/** Whether the player markers feature is on. */
	markersEnabled?: boolean;
	/** Whether quick notes are switched on (transcription is, either way). */
	quickNotesEnabled?: boolean;
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
	quickNotesEnabled = false,
}: SessionState = {}): {
	services: SessionServices;
	recording: jest.Mocked<RecordingSessionPort>;
	quickNote: { toggle: jest.Mock; getStatus: jest.Mock };
	openMarkerModal: jest.Mock;
	saveSettings: jest.Mock;
	settings: AudioRecorderSettings;
} {
	const recording = partial<jest.Mocked<RecordingSessionPort>>({
		toggleRecording: jest.fn().mockResolvedValue(undefined),
		isSessionActive: jest.fn(() => active),
		togglePauseResume: jest.fn(),
		canDropMarker: jest.fn(() => active && markersEnabled),
	});
	const quickNote = {
		toggle: jest.fn().mockResolvedValue(undefined),
		getStatus: jest.fn(),
	};
	const openMarkerModal = jest.fn();
	const saveSettings = jest.fn().mockResolvedValue(undefined);
	const settings = partial<AudioRecorderSettings>({
		audioDeviceId: '',
		transcriptionEnabled: true,
		quickNotesEnabled,
	});
	return {
		recording,
		quickNote,
		openMarkerModal,
		saveSettings,
		settings,
		services: {
			app: createMockApp({}).app,
			getSettings: () => settings,
			saveSettings,
			recording,
			quickNote,
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
	function registerSession(state: SessionState = {}): ReturnType<
		typeof register
	> & {
		session: ReturnType<typeof makeSession>;
	} {
		const session = makeSession(state);
		return { session, ...register(sessionActionFamily(session.services)) };
	}

	it('registers every session command in palette order', () => {
		const { plugin } = registerSession();

		expect(plugin.registeredCommands.map((command) => command.id)).toEqual([
			COMMAND_IDS.startStopRecording,
			COMMAND_IDS.startStopQuickNote,
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

		expect(idle.invoke(COMMAND_IDS.startStopRecording)).toBe(true);
		expect(live.invoke(COMMAND_IDS.startStopRecording)).toBe(true);

		// Starting is what this command does when nothing is running, so it
		// is the one session command with nothing to gate on.
		expect(idle.session.recording.toggleRecording).toHaveBeenCalledTimes(1);
		expect(live.session.recording.toggleRecording).toHaveBeenCalledTimes(1);
	});

	it('offers the quick note command only once quick notes are switched on', () => {
		const off = registerSession({ quickNotesEnabled: false });
		const on = registerSession({ quickNotesEnabled: true });

		expect(off.invoke(COMMAND_IDS.startStopQuickNote)).toBe(false);
		expect(on.invoke(COMMAND_IDS.startStopQuickNote)).toBe(true);

		// Off, the feature does not exist yet, so a key bound to it stays free
		// for whatever else claims it.
		expect(off.session.quickNote.toggle).not.toHaveBeenCalled();
		expect(on.session.quickNote.toggle).toHaveBeenCalledTimes(1);
	});

	it('drives pause only while a session is running', () => {
		const idle = registerSession({ active: false });
		// Markers are off, so the gate that answers here is the session one
		const live = registerSession({ active: true, markersEnabled: false });

		expect(idle.invoke(COMMAND_IDS.pauseResumeRecording)).toBe(false);
		expect(live.invoke(COMMAND_IDS.pauseResumeRecording)).toBe(true);

		// An idle recorder has nothing to pause, so a key bound to this falls
		// through to whatever else claims it.
		expect(idle.session.recording.togglePauseResume).not.toHaveBeenCalled();
		expect(live.session.recording.togglePauseResume).toHaveBeenCalledTimes(
			1,
		);
	});

	it('opens the marker modal with the kind the command fixes', () => {
		const { invoke, session } = registerSession();

		// The chooser command fixes no kind, so the modal asks for one
		expect(invoke(COMMAND_IDS.addRecordingMarker)).toBe(true);
		expect(session.openMarkerModal).toHaveBeenLastCalledWith();
		expect(invoke(COMMAND_IDS.addRecordingBookmark)).toBe(true);
		expect(session.openMarkerModal).toHaveBeenLastCalledWith(
			MARKER_KIND.bookmark,
		);
		expect(invoke(COMMAND_IDS.addRecordingChapter)).toBe(true);
		expect(session.openMarkerModal).toHaveBeenLastCalledWith(
			MARKER_KIND.chapter,
		);
	});

	it('withholds all three marker commands when nothing can be dropped', () => {
		const { invoke, session } = registerSession({
			markersEnabled: false,
		});

		expect(invoke(COMMAND_IDS.addRecordingMarker)).toBe(false);
		expect(invoke(COMMAND_IDS.addRecordingBookmark)).toBe(false);
		expect(invoke(COMMAND_IDS.addRecordingChapter)).toBe(false);
		expect(session.openMarkerModal).not.toHaveBeenCalled();
	});

	it('stores the device the picker returns', async () => {
		jest.mocked(showDeviceSelectionModal).mockImplementation(
			async (_app, onDeviceSelected) => {
				await onDeviceSelected('device-7', 'Device 7');
			},
		);
		const { invoke, session } = registerSession();

		expect(invoke(COMMAND_IDS.selectAudioInputDevice)).toBe(true);
		await tick();

		expect(session.settings.audioDeviceId).toBe('device-7');
		expect(session.saveSettings).toHaveBeenCalledTimes(1);
	});

	it('opens the device picker on the input recordings use now', () => {
		const { invoke, session } = registerSession();
		session.settings.audioDeviceId = 'device-3';

		invoke(COMMAND_IDS.selectAudioInputDevice);

		expect(showDeviceSelectionModal).toHaveBeenCalledWith(
			expect.anything(),
			expect.any(Function),
			'device-3',
		);
	});

	it('hides the device picker where the platform cannot select one', () => {
		// Mobile records from the default microphone, so the command has
		// nothing to offer and must stay out of the palette.
		useMobilePlatform();
		const { invoke } = registerSession();

		expect(invoke(COMMAND_IDS.selectAudioInputDevice)).toBe(false);
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
	function registerAgainst(
		state: PlaybackControlsState | null,
	): ReturnType<typeof register> {
		return register(playbackActionFamily(() => state));
	}

	it('registers every playback command in palette order', () => {
		const { plugin } = registerAgainst(makePlaybackState());

		expect(plugin.registeredCommands.map((command) => command.id)).toEqual([
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
			id: COMMAND_IDS.toggleChapterLoop,
			command: 'onToggleChapterLoop',
			args: [],
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
		const { plugin, invoke } = registerAgainst(null);

		for (const command of plugin.registeredCommands) {
			expect(invoke(command.id)).toBe(false);
		}
	});

	it('withholds the chapter commands when the player has no chapters', () => {
		const state = makePlaybackState({ chaptersEnabled: false });
		const { invoke } = registerAgainst(state);

		expect(invoke(COMMAND_IDS.previousChapter)).toBe(false);
		expect(invoke(COMMAND_IDS.nextChapter)).toBe(false);
		expect(state.onNextChapter).not.toHaveBeenCalled();
	});
});
