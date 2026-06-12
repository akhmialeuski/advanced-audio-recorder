/**
 * Time-related utilities shared across modules.
 * @module utils/TimeUtils
 */

/**
 * Delays execution for the specified number of milliseconds.
 * Uses activeWindow so the timer is attached to the active Obsidian
 * window (multi-window support).
 * @param ms - Delay duration in milliseconds
 * @returns Promise resolved after the delay
 */
export function delay(ms: number): Promise<void> {
	return new Promise((resolve) => window.setTimeout(resolve, ms));
}
