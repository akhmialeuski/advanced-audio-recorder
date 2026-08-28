/**
 * Actions that search the vault rather than act on a file or on playback.
 * They belong to no particular recording, which is why they are their own
 * list: the file resolver returns null for anything that is not an audio
 * file, and a vault-wide search must be offered from any note at all.
 * @module actions/searchActions
 */

import { COMMAND_IDS, PLAYER_ICONS } from '../constants';
import type { SearchAction } from './PluginAction';

/** Needs nothing beyond the plugin being loaded. */
const always = (): boolean => true;

/** Every vault-wide search action, in palette order. */
export const SEARCH_ACTIONS: readonly SearchAction[] = [
	{
		commandId: COMMAND_IDS.searchMarkers,
		title: 'Search markers and chapters',
		icon: PLAYER_ICONS.searchMarkers,
		isAvailable: always,
		run: (services): Promise<void> => services.openMarkerSearch(),
	},
];
