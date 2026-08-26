/**
 * The recording-session actions offered by the plugin, defined once.
 * Together they cover a session from the palette: starting and stopping
 * capture, pausing it, choosing the input device, and dropping a marker
 * at the live position either through the kind chooser or with the kind
 * fixed up front, so bookmark and chapter can each carry their own
 * hotkey.
 * @module actions/sessionActions
 */

import { COMMAND_IDS, PLAYER_ICONS } from '../constants';
import { MARKER_KIND } from '../markers/markerModel';
import { isDeviceSelectionSupported } from '../platform/capabilities';
import { showDeviceSelectionModal } from '../ui/DeviceSelectionModal';
import type { SessionAction, SessionServices } from './PluginAction';

/** Availability gate for the action that starts a session as well as ends it. */
const always = (): boolean => true;

/** Availability gate for actions that need a live session. */
const whileRecording = ({ recording }: SessionServices): boolean =>
	recording.isSessionActive();

/** Availability gate for actions that need a live, marker-enabled session. */
const whileDropping = ({ recording }: SessionServices): boolean =>
	recording.canDropMarker();

/**
 * All recording-session actions in palette order: capture, pause, the
 * marker chooser, the two kind-fixed markers, and the device picker.
 */
export const SESSION_ACTIONS: readonly SessionAction[] = [
	{
		commandId: COMMAND_IDS.startStopRecording,
		title: 'Start/stop recording',
		icon: 'microphone',
		isAvailable: always,
		run: ({ recording }: SessionServices): Promise<void> =>
			recording.toggleRecording(),
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
	},
	{
		commandId: COMMAND_IDS.addRecordingMarker,
		title: 'Add marker/chapter at current position',
		icon: 'bookmark',
		isAvailable: whileDropping,
		run: ({ openMarkerModal }: SessionServices): void => {
			openMarkerModal();
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
	},
	{
		commandId: COMMAND_IDS.addRecordingChapter,
		title: 'Add chapter at current recording position',
		icon: PLAYER_ICONS.addChapter,
		isAvailable: whileDropping,
		run: ({ openMarkerModal }: SessionServices): void => {
			openMarkerModal(MARKER_KIND.chapter);
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
	},
];
