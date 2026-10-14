/**
 * The recording-session actions offered by the plugin, defined once.
 * Together they cover a session from the palette and the command line:
 * starting and stopping capture, dictating a quick note, pausing, choosing the
 * input device, and dropping a marker at the live position either through the
 * kind chooser or with the kind fixed up front, so bookmark and chapter can
 * each carry their own hotkey.
 * @module actions/sessionActions
 */

import type { CliData } from 'obsidian';
import { COMMAND_IDS, PLAYER_ICONS } from '../constants';
import { MARKER_KIND, type MarkerKind } from '../markers/markerModel';
import { isDeviceSelectionSupported } from '../platform/capabilities';
import { showDeviceSelectionModal } from '../ui/DeviceSelectionModal';
import { ICON_QUICK_NOTE } from '../ui/RibbonIcon';
import { quickNotesAvailable } from '../settings/settingsSchema';
import {
	deviceOptionLabel,
	getAudioInputDevices,
} from '../recording/AudioStreamHandler';
import { RecordingStatus } from '../types';
import { describeRecordingStatus } from '../obsidian/cliCommands';
import {
	choiceParam,
	cliChoice,
	cliText,
	isRefusal,
	valueParam,
} from '../obsidian/cliArgs';
import type {
	ActionFamily,
	SessionAction,
	SessionServices,
} from './PluginAction';

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
	);

/** The marker label, on the command line. */
const LABEL_PARAM = 'label';

/** The label parameter of the marker commands. */
const LABEL_PARAMS = {
	[LABEL_PARAM]: valueParam(
		'<text>',
		'Label of the marker. Numbered by default.',
	),
};

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
		run: ({ recording }: SessionServices): Promise<void> =>
			recording.toggleRecording(),
		cli: {
			name: 'toggle-recording',
			description:
				'Start recording, or stop the recording in progress and save it.',
			execute: async (services: SessionServices): Promise<string> => {
				await services.recording.toggleRecording();
				return recorderState(services);
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
				...LABEL_PARAMS,
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
			params: LABEL_PARAMS,
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
			params: LABEL_PARAMS,
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
			showDeviceSelectionModal(app, async (deviceId: string) => {
				getSettings().audioDeviceId = deviceId;
				await saveSettings();
			}),
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
		cliTarget: { params: {}, resolve: () => [services] },
		describe: () => 'the recorder',
	};
}
