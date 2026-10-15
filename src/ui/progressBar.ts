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
	 * @param percent - A whole percentage in 0..100
	 */
	setValue(percent: number): void;
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
	const setValue = (percent: number): void => {
		bar.setValue(percent);
		el.setAttribute('aria-valuenow', String(percent));
	};
	setValue(0);
	return { setValue };
}
