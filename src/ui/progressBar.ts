/**
 * A progress bar built from Obsidian's ProgressBarComponent, inside an
 * element that tells a screen reader what it is and how far along it is.
 * @module ui/progressBar
 */

import { ProgressBarComponent } from 'obsidian';

/** A mounted progress bar. */
export interface ProgressBar {
	/**
	 * Shows how far along the work is.
	 * @param percent - Reported percentage, or undefined before any was
	 *   reported; anything outside a whole 0..100 is brought into it
	 */
	setValue(percent: number | undefined): void;
	/**
	 * Renames what the bar is the progress of, for a screen reader.
	 * @param label - The new name
	 */
	setLabel(label: string): void;
}

/**
 * Brings a reported percentage into the whole 0..100 the bar can show.
 *
 * Progress is read off work in flight: a save divides bytes written by bytes
 * expected, which is NaN before the first chunk lands and overshoots 100 when
 * a final flush writes more than it announced. Obsidian's component clamps
 * the width but lets a NaN through, and the same number is what a screen
 * reader reads out, so neither may reach either.
 * @param percent - Reported percentage, or undefined before any was reported
 * @returns A whole percentage in 0..100
 */
function wholePercent(percent: number | undefined): number {
	if (percent === undefined || !Number.isFinite(percent)) {
		return 0;
	}
	return Math.round(Math.min(100, Math.max(0, percent)));
}

/**
 * Mounts a progress bar into a container.
 *
 * Obsidian's component draws the bar the app draws everywhere else, and
 * nothing more: it carries no role and no value a screen reader could read.
 * The element it is built into says both, so the bar is announced as a
 * progress bar at the percentage it shows.
 * @param parent - The element the bar is appended to
 * @param cls - The class the caller styles and finds the bar by
 * @param label - What the bar is the progress of, for a screen reader
 * @returns The mounted bar, at zero
 */
export function createProgressBar(
	parent: HTMLElement,
	cls: string,
	label: string,
): ProgressBar {
	const el = parent.createDiv({
		cls,
		attr: {
			role: 'progressbar',
			'aria-label': label,
			'aria-valuemin': '0',
			'aria-valuemax': '100',
		},
	});
	const bar = new ProgressBarComponent(el);
	const progress: ProgressBar = {
		setValue(percent: number | undefined): void {
			const whole = wholePercent(percent);
			bar.setValue(whole);
			el.setAttribute('aria-valuenow', String(whole));
		},
		setLabel(text: string): void {
			el.setAttribute('aria-label', text);
		},
	};
	progress.setValue(0);
	return progress;
}
