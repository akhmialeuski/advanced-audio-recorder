/**
 * Registers plugin actions as palette commands. File actions resolve
 * the active file and reuse the same availability gate the context
 * menus use, so the palette, the menus, and the Hotkeys settings all
 * expose the same feature set. No default hotkeys are assigned; the
 * user binds them in Settings -> Hotkeys.
 * @module actions/registerActionCommands
 */

import { TFile } from 'obsidian';
import type { Plugin } from 'obsidian';
import { isAudioFile } from '../utils/audioFile';
import type { PlaybackControlsState } from '../player/playbackControls';
import type {
	ActionServices,
	FileAction,
	PlaybackAction,
	RecordingMarkerAction,
} from './PluginAction';

/**
 * Registers each file action as a checkCallback command over the
 * active file.
 * @param plugin - Plugin to register commands on
 * @param actions - File actions to register
 * @param services - Injected action services
 */
export function registerFileActionCommands(
	plugin: Plugin,
	actions: readonly FileAction[],
	services: ActionServices,
): void {
	for (const action of actions) {
		plugin.addCommand({
			id: action.commandId,
			name: action.title,
			checkCallback: (checking: boolean): boolean => {
				const file = services.app.workspace.getActiveFile();
				if (!(file instanceof TFile) || !isAudioFile(file)) {
					return false;
				}
				if (!action.isAvailable(file, services)) {
					return false;
				}
				if (!checking) {
					void action.run(file, services);
				}
				return true;
			},
		});
	}
}

/**
 * Registers recording-session actions gated on a live session.
 * @param plugin - Plugin to register commands on
 * @param actions - Recording actions to register
 * @param recordingGate - True while the action is usable (e.g. a
 *   session is recording or paused and markers are enabled)
 */
export function registerRecordingActionCommands(
	plugin: Plugin,
	actions: readonly RecordingMarkerAction[],
	recordingGate: () => boolean,
): void {
	for (const action of actions) {
		plugin.addCommand({
			id: action.commandId,
			name: action.title,
			checkCallback: (checking: boolean): boolean => {
				if (!recordingGate()) {
					return false;
				}
				if (!checking) {
					action.run();
				}
				return true;
			},
		});
	}
}

/**
 * Registers playback actions gated on the active playback snapshot. The
 * snapshot is read at check time rather than captured, so a command that
 * is offered now always drives the audio that is playing now, and every
 * command disappears from the palette once playback ends.
 * @param plugin - Plugin to register commands on
 * @param actions - Playback actions to register
 * @param getState - Reads the current playback snapshot, null while idle
 */
export function registerPlaybackActionCommands(
	plugin: Plugin,
	actions: readonly PlaybackAction[],
	getState: () => PlaybackControlsState | null,
): void {
	for (const action of actions) {
		plugin.addCommand({
			id: action.commandId,
			name: action.title,
			icon: action.icon,
			checkCallback: (checking: boolean): boolean => {
				const state = getState();
				if (!state || !action.isAvailable(state)) {
					return false;
				}
				if (!checking) {
					action.run(state);
				}
				return true;
			},
		});
	}
}
