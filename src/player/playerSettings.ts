/**
 * Render-ready player settings resolved from the plugin configuration.
 * Lives with the player: this is player-domain logic, and keeping it
 * here removes the player's dependency on settings internals.
 * @module player/playerSettings
 */

import type { AudioRecorderSettings } from '../settings/Settings';

/**
 * Render-ready view of the enhanced player's two user-toggleable windows.
 * Every other player element (speed, skip, volume, mute, loop, time display,
 * timecode links, marker list, chapter navigation) is fixed and rendered
 * unconditionally from constants, so this only carries the two toggles that
 * actually vary. Player settings are deliberately kept off validateSettings:
 * they are unrelated to recording and must never throw on the recording path.
 */
export interface ResolvedPlayerSettings {
	/** Draw the waveform behind the seek bar; false renders the plain bar. */
	showWaveform: boolean;
	/** Show the markers and chapters window (list, ticks, edit controls). */
	enableMarkers: boolean;
}

/**
 * Builds the render-ready player layout from the two window toggles.
 * @param settings - Current plugin settings
 * @returns Render-ready player settings
 */
export function resolvePlayerSettings(
	settings: AudioRecorderSettings,
): ResolvedPlayerSettings {
	return {
		showWaveform: settings.playerShowWaveform,
		enableMarkers: settings.playerEnableMarkers,
	};
}

/**
 * Whether two resolved player layouts are identical. A settings save that
 * does not change either window toggle re-applies nothing to live players,
 * so an unrelated setting change never rebuilds an open player.
 * @param a - One resolved layout
 * @param b - Another resolved layout
 * @returns True when both toggles match
 */
export function playerSettingsEqual(
	a: ResolvedPlayerSettings,
	b: ResolvedPlayerSettings,
): boolean {
	return (
		a.showWaveform === b.showWaveform && a.enableMarkers === b.enableMarkers
	);
}
