/**
 * The recording-session actions offered by the plugin, defined once.
 * Together they cover a session from the palette and the command line:
 * starting and stopping capture, dictating a quick note, pausing, choosing the
 * input device, and dropping a marker at the live position either through the
 * kind chooser or with the kind fixed up front, so bookmark and chapter can
 * each carry their own hotkey.
 * @module actions/session/sessionActions
 */

import type { App, CliData } from 'obsidian';
import type { AudioRecorderSettings } from '../../settings/settingsSchema';
import type { RecordingMarkerHandle } from '../../recording/recordingMarkers';
import type { RecordingSaveState } from '../../recording/RecordingSaveQueue';
import { COMMAND_IDS, PLAYER_ICONS } from '../../constants';
import { MARKER_KIND, type MarkerKind } from '../../markers/markerModel';
import { isDeviceSelectionSupported } from '../../platform/capabilities';
import { showDeviceSelectionModal } from '../../ui/DeviceSelectionModal';
import { ICON_QUICK_NOTE } from '../../ui/RibbonIcon';
import { quickNotesAvailable } from '../../settings/settingsSchema';
import {
	deviceOptionLabel,
	getAudioInputDevices,
} from '../../recording/AudioStreamHandler';
import { savesInProgress } from '../../recording/RecordingSaveQueue';
import { RecordingStatus } from '../../types';
import { describeRecordingStatus } from '../../obsidian/cliCommands';
import {
	choiceParam,
	cliChoice,
	cliText,
	valueParam,
} from '../../obsidian/cliArgs';
import type { ActionFamily, PluginCommand } from '../core/PluginAction';
import { LABEL_PARAM, MARKER_LABEL_PARAMS } from '../position/positionActions';
import { isRefusal } from '../../utils/refusal';

/**
 * The slice of the recording session the session actions drive. Declared
 * as a port rather than the manager itself, so the action definitions
 * stay independent of the recording subsystem.
 */
export interface RecordingSessionPort {
	/**
	 * Starts capture, or stops and saves a running session.
	 * @returns The reason it did not complete, or null once it has
	 */
	toggleRecording(): Promise<string | null>;
	/** Whether a session is live: capturing or paused mid-capture. */
	isSessionActive(): boolean;
	/** Pauses a running session or resumes a paused one. */
	togglePauseResume(): void;
	/** Whether a marker can be dropped at the live position right now. */
	canDropMarker(): boolean;
	/** What the recorder is doing. */
	getStatus(): RecordingStatus;
	/** What the background saves of stopped recordings are doing. */
	getSaveState(): RecordingSaveState;
	/**
	 * Drops a marker at the live position and returns the handle that names
	 * it, or null when no marker can be dropped now.
	 * @param preselectKind - The kind the marker is created as
	 */
	captureMarkerDraft(
		preselectKind?: MarkerKind,
	): RecordingMarkerHandle | null;
}

/**
 * The slice of quick notes the session actions drive, declared as a port for
 * the same reason as {@link RecordingSessionPort}.
 */
export interface QuickNotePort {
	/** Starts a dictation, or stops the running one and inserts its text. */
	toggle(): Promise<void>;
	/** What the dictation is doing. */
	getStatus(): RecordingStatus;
}

/** Everything a recording-session action needs. */
export interface SessionServices {
	readonly app: App;
	readonly getSettings: () => AudioRecorderSettings;
	/** Persists the (mutated) settings, e.g. after choosing a device. */
	readonly saveSettings: () => Promise<void>;
	/** The live recording session the action drives. */
	readonly recording: RecordingSessionPort;
	/** Quick notes, which dictate into the note at the cursor. */
	readonly quickNote: QuickNotePort;
	/**
	 * Freezes a marker draft of the given kind at the live position and
	 * opens the naming modal. Without a kind the modal asks for one.
	 */
	readonly openMarkerModal: (kind?: MarkerKind) => void;
}

/**
 * An action on the recording session. Registered as a palette command
 * whose gate reads the live session, so each gets its own hotkey.
 */
export type SessionAction = PluginCommand<SessionServices>;

/** Availability gate for the action that starts a session as well as ends it. */
const always = (): boolean => true;

/** Availability gate for actions that need a live session. */
const whileRecording = ({ recording }: SessionServices): boolean =>
	recording.isSessionActive();

/** Availability gate for actions that need a live, marker-enabled session. */
const whileDropping = ({ recording }: SessionServices): boolean =>
	recording.canDropMarker();

/**
 * The recorder's state after an action, as the command line says it.
 * @param services - The session
 */
const recorderState = ({ recording, getSettings }: SessionServices): string =>
	describeRecordingStatus(
		recording.getStatus(),
		getSettings().recordingFormat,
		savesInProgress(recording.getSaveState()),
	);

/** Why no marker can be dropped, said where the palette hides the command. */
const noMarker = (): string =>
	'Nothing is recording, or markers are switched off in settings.';

/**
 * Drops a marker at the live position with the label typed, without the
 * naming dialog the palette opens.
 * @param services - The session
 * @param kind - The kind fixed by the command, or undefined for the last used
 * @param args - The arguments as typed
 * @returns The answer
 */
function dropMarker(
	services: SessionServices,
	kind: MarkerKind | undefined,
	args: CliData,
): string {
	const handle = services.recording.captureMarkerDraft(kind);
	if (!handle) {
		return noMarker();
	}
	const chosen = kind ?? handle.initialKind;
	const label = cliText(args, LABEL_PARAM) ?? handle.defaultLabelFor(chosen);
	handle.commit(label, chosen);
	return `${label} added to the recording as a ${chosen}.`;
}

/**
 * Lists the input devices, or picks the one typed.
 * @param services - The session
 * @param args - The arguments as typed
 * @returns The answer
 */
async function selectDevice(
	services: SessionServices,
	args: CliData,
): Promise<string> {
	const devices = await getAudioInputDevices();
	if (devices.length === 0) {
		return 'No audio input devices found.';
	}
	const settings = services.getSettings();
	const wanted = cliText(args, 'id') ?? cliText(args, 'name');
	if (wanted === null) {
		return devices
			.map(
				(device) =>
					`${device.deviceId === settings.audioDeviceId ? '* ' : '  '}${deviceOptionLabel(device)}  id=${device.deviceId}`,
			)
			.join('\n');
	}
	const lower = wanted.toLowerCase();
	const device =
		devices.find((candidate) => candidate.deviceId === wanted) ??
		devices.find((candidate) =>
			deviceOptionLabel(candidate).toLowerCase().includes(lower),
		);
	if (!device) {
		return `No audio input device matches "${wanted}". Run the command without id or name to list them.`;
	}
	settings.audioDeviceId = device.deviceId;
	await services.saveSettings();
	return `Selected audio device: ${deviceOptionLabel(device)}`;
}

/**
 * All recording-session actions in palette order: capture, quick note, pause,
 * the marker chooser, the two kind-fixed markers, and the device picker.
 */
export const SESSION_ACTIONS: readonly SessionAction[] = [
	{
		commandId: COMMAND_IDS.startStopRecording,
		title: 'Start/stop recording',
		icon: 'microphone',
		isAvailable: always,
		run: async ({ recording }: SessionServices): Promise<void> => {
			// The recorder shows its own notice for a start it refused.
			await recording.toggleRecording();
		},
		cli: {
			name: 'toggle-recording',
			description:
				'Start recording, or stop the recording in progress and save it.',
			execute: async (services: SessionServices): Promise<string> => {
				// A refused start leaves the recorder idle, and the idle line
				// alone would read as nothing having gone wrong.
				const failure = await services.recording.toggleRecording();
				return failure ?? recorderState(services);
			},
		},
	},
	{
		commandId: COMMAND_IDS.startStopQuickNote,
		title: 'Start/stop quick note',
		icon: ICON_QUICK_NOTE,
		// Absent from the palette, and inert as a hotkey, until quick notes
		// are switched on: the feature does not exist before that.
		isAvailable: ({ getSettings }: SessionServices): boolean =>
			quickNotesAvailable(getSettings()),
		run: ({ quickNote }: SessionServices): Promise<void> =>
			quickNote.toggle(),
		cli: {
			name: 'quick-note',
			description:
				'Start dictating into the active note, or stop and insert the text.',
			unavailable: (): string =>
				'Quick notes are switched off in settings.',
			execute: async ({
				quickNote,
			}: SessionServices): Promise<string> => {
				await quickNote.toggle();
				return quickNote.getStatus() === RecordingStatus.Recording
					? 'Quick note recording. Run the command again to stop.'
					: 'Quick note stopped; its text goes into the note it was started in.';
			},
		},
	},
	{
		commandId: COMMAND_IDS.pauseResumeRecording,
		title: 'Pause/resume recording',
		icon: PLAYER_ICONS.pause,
		// There is nothing to pause or resume without a session, so the key
		// bound to this stays free while the recorder is idle.
		isAvailable: whileRecording,
		run: ({ recording }: SessionServices): void => {
			recording.togglePauseResume();
		},
		cli: {
			name: 'pause',
			description: 'Pause the recording in progress, or resume it.',
			unavailable: (): string => 'Nothing is recording.',
			execute: (services: SessionServices): string => {
				services.recording.togglePauseResume();
				return recorderState(services);
			},
		},
	},
	{
		commandId: COMMAND_IDS.addRecordingMarker,
		title: 'Add marker/chapter at current position',
		icon: 'bookmark',
		isAvailable: whileDropping,
		run: ({ openMarkerModal }: SessionServices): void => {
			openMarkerModal();
		},
		cli: {
			name: 'recording-marker',
			description:
				'Mark the current moment of the recording in progress.',
			params: {
				kind: choiceParam(
					Object.values(MARKER_KIND),
					'Bookmark or chapter. Defaults to the kind used last.',
				),
				...MARKER_LABEL_PARAMS,
			},
			opensDialog: true,
			unavailable: noMarker,
			execute: (services: SessionServices, args: CliData): string => {
				const kind = cliChoice(
					args,
					'kind',
					Object.values(MARKER_KIND),
				);
				return isRefusal(kind)
					? kind.refusal
					: dropMarker(services, kind.value ?? undefined, args);
			},
		},
	},
	{
		commandId: COMMAND_IDS.addRecordingBookmark,
		title: 'Add bookmark at current recording position',
		icon: PLAYER_ICONS.addBookmark,
		isAvailable: whileDropping,
		run: ({ openMarkerModal }: SessionServices): void => {
			openMarkerModal(MARKER_KIND.bookmark);
		},
		cli: {
			name: 'recording-bookmark',
			description:
				'Add a bookmark at the current moment of the recording in progress.',
			params: MARKER_LABEL_PARAMS,
			opensDialog: true,
			unavailable: noMarker,
			execute: (services: SessionServices, args: CliData): string =>
				dropMarker(services, MARKER_KIND.bookmark, args),
		},
	},
	{
		commandId: COMMAND_IDS.addRecordingChapter,
		title: 'Add chapter at current recording position',
		icon: PLAYER_ICONS.addChapter,
		isAvailable: whileDropping,
		run: ({ openMarkerModal }: SessionServices): void => {
			openMarkerModal(MARKER_KIND.chapter);
		},
		cli: {
			name: 'recording-chapter',
			description:
				'Start a chapter at the current moment of the recording in progress.',
			params: MARKER_LABEL_PARAMS,
			opensDialog: true,
			unavailable: noMarker,
			execute: (services: SessionServices, args: CliData): string =>
				dropMarker(services, MARKER_KIND.chapter, args),
		},
	},
	{
		commandId: COMMAND_IDS.selectAudioInputDevice,
		title: 'Select audio input device',
		icon: 'mic',
		// Hidden from the palette where device selection is unavailable
		// (mobile records from the default microphone).
		isAvailable: (): boolean => isDeviceSelectionSupported(),
		run: ({
			app,
			getSettings,
			saveSettings,
		}: SessionServices): Promise<void> =>
			showDeviceSelectionModal(
				app,
				async (deviceId: string) => {
					getSettings().audioDeviceId = deviceId;
					await saveSettings();
				},
				getSettings().audioDeviceId,
			),
		cli: {
			name: 'device',
			description:
				'List the audio input devices, or choose the one to record from.',
			params: {
				id: valueParam(
					'<device id>',
					'Device to record from, by its id.',
				),
				name: valueParam(
					'<text>',
					'Device to record from, by a part of its name.',
				),
			},
			opensDialog: true,
			unavailable: (): string =>
				'This platform records from its default microphone.',
			execute: selectDevice,
		},
	},
];

/**
 * The session actions as a family: there is one recorder, so the palette and
 * the command line always target it.
 * @param services - The session
 * @returns The family
 */
export function sessionActionFamily(
	services: SessionServices,
): ActionFamily<SessionServices> {
	return {
		actions: SESSION_ACTIONS,
		activeTargets: () => [services],
		cliTarget: { params: {}, resolve: () => ({ value: [services] }) },
		describe: () => 'the recorder',
	};
}
