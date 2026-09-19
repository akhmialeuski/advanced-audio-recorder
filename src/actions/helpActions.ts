/**
 * Actions that explain the plugin rather than act on audio. They belong to no
 * file, no session and no playback, which is why they are their own list: the
 * release notes are read while nothing is recording and nothing is playing,
 * and most often right after an update, when there is no recording to speak of
 * yet.
 * @module actions/helpActions
 */

import { COMMAND_IDS } from '../constants';
import type { HelpAction } from './PluginAction';

/** Needs nothing beyond the plugin being loaded. */
const always = (): boolean => true;

/** Every action about the plugin itself, in palette order. */
export const HELP_ACTIONS: readonly HelpAction[] = [
	{
		commandId: COMMAND_IDS.showReleaseNotes,
		title: "Show what's new",
		// Not `sparkles`, which the chapter generation already carries: two
		// commands under one glyph is two commands nobody can tell apart in
		// the palette.
		icon: 'megaphone',
		isAvailable: always,
		run: (services): void => {
			services.showReleaseNotes();
		},
	},
];
