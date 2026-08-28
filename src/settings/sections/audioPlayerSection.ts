/**
 * The enhanced player: what it replaces, and which of its parts are offered.
 * @module settings/sections/audioPlayerSection
 */

import {
	MAX_PLAYER_SKIP_SECONDS,
	MIN_PLAYER_SKIP_SECONDS,
} from '../../constants';
import type { AudioRecorderSettings } from '../settingsSchema';
import { sectionItems } from './rowHelpers';
import type { SettingGroupItem } from 'obsidian';

/**
 * The enhanced player and the two windows it can open, behind an entry of its
 * own. The sub-options are revealed by a predicate rather than by redrawing the
 * section.
 * @param settings - Live settings, read by the predicates
 */
export function audioPlayerPage(
	settings: AudioRecorderSettings,
): SettingGroupItem {
	const enhanced = (): boolean => settings.enhancedPlayerEnabled;
	return {
		type: 'page',
		name: 'Audio player',
		desc: "The embed that replaces Obsidian's own audio player.",
		displayValue: (): string => (enhanced() ? 'On' : 'Off'),
		items: sectionItems([
			{
				name: 'Enhanced audio player',
				aliases: ['waveform player', 'embed'],
				desc: 'Replace the built-in audio embed with a richer player (waveform, speed, skip, volume, loop, timecode links, markers and chapters). Video files keep the built-in player.',
				control: { type: 'toggle', key: 'enhancedPlayerEnabled' },
			},
			{
				name: 'Show waveform',
				desc: 'Draw a waveform behind the seek bar.',
				visible: enhanced,
				control: { type: 'toggle', key: 'playerShowWaveform' },
			},
			{
				name: 'Markers and chapters',
				desc: 'Show the markers and chapters list below the player. Markers are stored next to the recording, not in your vault.',
				visible: enhanced,
				control: { type: 'toggle', key: 'playerEnableMarkers' },
			},
			{
				name: 'Skip step',
				aliases: ['skip seconds', 'jump'],
				desc: 'Seconds the skip-forward and skip-back controls move by, in the player, in the status bar, and from their commands. Five suits picking apart speech, thirty suits a lecture.',
				visible: enhanced,
				control: {
					type: 'number',
					key: 'playerSkipSeconds',
					min: MIN_PLAYER_SKIP_SECONDS,
					max: MAX_PLAYER_SKIP_SECONDS,
					step: 1,
				},
			},
		]),
	};
}
