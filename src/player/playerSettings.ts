/**
 * Render-ready player settings resolved from the plugin configuration.
 * Lives with the player: this is player-domain logic, and keeping it
 * here removes the player's dependency on settings internals.
 * @module player/playerSettings
 */

import {
	MAX_PLAYER_SKIP_SECONDS,
	MIN_PLAYER_SKIP_SECONDS,
	PLAYER_SKIP_SECONDS,
} from '../constants';
import type { AudioRecorderSettings } from '../settings/settingsSchema';

/**
 * Brings a configured skip step inside the range its settings row declares.
 *
 * The row is the only place that bound was enforced, and a stored value never
 * passes through it: settings are read from disk without validation, so a
 * hand-edited file reached three surfaces and an audio element unchecked, and
 * a zero step made every skip control inert while a non-number moved playback
 * to NaN. Applied here because this is where the step is resolved for all of
 * them at once.
 * @param seconds - Seconds the settings hold
 * @returns Whole seconds within the declared range, or the default for
 * non-finite input
 */
function clampSkipSeconds(seconds: number): number {
	if (!Number.isFinite(seconds)) {
		return PLAYER_SKIP_SECONDS;
	}
	return Math.min(
		MAX_PLAYER_SKIP_SECONDS,
		Math.max(MIN_PLAYER_SKIP_SECONDS, Math.floor(seconds)),
	);
}

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
	/**
	 * Seconds a skip moves by, always inside the range the settings row
	 * declares. Resolved once here so the embed, the status bar and the
	 * commands cannot offer three different steps, and bounded here because
	 * this is the last point before the value reaches an audio element.
	 */
	skipSeconds: number;
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
		skipSeconds: clampSkipSeconds(settings.playerSkipSeconds),
	};
}

/**
 * Whether two resolved player layouts are identical. A settings save that
 * changes none of them re-applies nothing to live players, so an unrelated
 * setting change never rebuilds an open player.
 *
 * Every field of the resolved layout is compared, the skip step included. It
 * is what an open player answers the status bar and the commands with, so a
 * step this call reports as unchanged never reaches them: the embed went on
 * moving by the old number while a timecode playback started afterwards used
 * the new one, which is the disagreement resolving the step in one place
 * exists to prevent.
 * @param a - One resolved layout
 * @param b - Another resolved layout
 * @returns True when every resolved field matches
 */
export function playerSettingsEqual(
	a: ResolvedPlayerSettings,
	b: ResolvedPlayerSettings,
): boolean {
	return (
		a.showWaveform === b.showWaveform &&
		a.enableMarkers === b.enableMarkers &&
		a.skipSeconds === b.skipSeconds
	);
}
