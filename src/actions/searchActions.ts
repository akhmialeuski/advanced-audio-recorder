/**
 * Actions that search the vault rather than act on a file or on playback.
 * They belong to no particular recording, which is why they are their own
 * list: the file resolver returns null for anything that is not an audio
 * file, and a vault-wide search must be offered from any note at all.
 * @module actions/searchActions
 */

import { COMMAND_IDS, PLAYER_ICONS } from '../constants';
import { ICON_MIC } from '../ui/RibbonIcon';
import type { SearchAction } from './PluginAction';

/** Needs nothing beyond the plugin being loaded. */
const always = (): boolean => true;

/** Every vault-wide action that is bound to no file, in palette order. */
export const SEARCH_ACTIONS: readonly SearchAction[] = [
	{
		commandId: COMMAND_IDS.searchMarkers,
		title: 'Search markers and chapters',
		icon: PLAYER_ICONS.searchMarkers,
		isAvailable: always,
		run: (services): Promise<void> => services.openMarkerSearch(),
	},
	{
		commandId: COMMAND_IDS.openTranscriptionQueue,
		title: 'Show the transcription queue',
		icon: 'list-ordered',
		isAvailable: always,
		run: (services): void => {
			services.openTranscriptionQueue();
		},
	},
	{
		commandId: COMMAND_IDS.openRecordingPanel,
		title: 'Open the recording panel',
		// The microphone the panel's sidebar tab and the ribbon carry.
		icon: ICON_MIC,
		isAvailable: always,
		run: (services): Promise<void> => services.openRecordingPanel(),
	},
];
