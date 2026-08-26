/**
 * Pure helpers for the playback-rate control. They are the single source
 * of truth for how a rate is labelled, which dropdown entries are shown,
 * and where a step lands, so the player presents the exact same speed
 * chooser in every render mode (reading view and Live Preview) and the
 * palette commands step between the very entries that chooser offers.
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

/**
 * Returns the preset one step away from the current rate, in the given
 * direction. The rate reaching this helper is read off the media element,
 * so it may sit between two presets (or carry a float drift); the scan
 * therefore looks for the first preset strictly past it rather than for an
 * index. At either end of the presets the current rate is returned, so a
 * repeated hotkey press stops instead of wrapping around to the opposite
 * extreme.
 * @param currentRate - The player's current playback rate
 * @param presets - Selectable rate presets in ascending order
 * @param direction - 1 to speed up, -1 to slow down
 * @returns The rate to apply
 */
export function steppedPlaybackRate(
	currentRate: number,
	presets: readonly number[],
	direction: 1 | -1,
): number {
	if (direction === 1) {
		for (const rate of presets) {
			if (rate > currentRate + RATE_COMPARISON_EPSILON) {
				return rate;
			}
		}
		return currentRate;
	}
	for (const rate of [...presets].reverse()) {
		if (rate < currentRate - RATE_COMPARISON_EPSILON) {
			return rate;
		}
	}
	return currentRate;
}
