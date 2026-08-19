/**
 * Pure helpers for the playback-rate control. They are the single source
 * of truth for how a rate is labelled and which dropdown entries are
 * shown, so the player presents the exact same speed chooser in every
 * render mode (reading view and Live Preview).
 * @module player/playbackRate
 */

/** Tolerance that absorbs floating point drift when comparing playback rates. */
const RATE_COMPARISON_EPSILON = 1e-6;

/** Decimals a rate label keeps; every preset from 0.25x to 4x fits in two. */
const RATE_LABEL_DECIMALS = 2;

/**
 * Formats a playback rate for display (e.g. 1.5 becomes "1.5x").
 *
 * The rate reaching the button is read back off the media element, not the
 * preset that was set, so it carries the browser's own float. Rounding to two
 * decimals keeps a drift of 1.0000000001 from spilling eleven characters onto
 * a button sized for three, while leaving every preset label unchanged.
 * @param rate - Playback rate multiplier
 * @returns The label, e.g. "1.5x"
 */
export function formatPlaybackRate(rate: number): string {
	return `${String(Number(rate.toFixed(RATE_LABEL_DECIMALS)))}x`;
}

/** A single entry in the playback-speed dropdown. */
export interface SpeedMenuItem {
	/** Rate this entry applies. */
	rate: number;
	/** Display label (e.g. "1.5x"). */
	label: string;
	/** Whether this entry matches the current rate. */
	checked: boolean;
}

/**
 * Builds the playback-speed dropdown items from the presets, marking the
 * entry that matches the current rate. A small epsilon absorbs floating
 * point drift when comparing rates.
 * @param currentRate - The player's current playback rate
 * @param presets - Selectable rate presets
 */
export function speedMenuItems(
	currentRate: number,
	presets: readonly number[],
): SpeedMenuItem[] {
	return presets.map((rate) => ({
		rate,
		label: formatPlaybackRate(rate),
		checked: Math.abs(currentRate - rate) < RATE_COMPARISON_EPSILON,
	}));
}
