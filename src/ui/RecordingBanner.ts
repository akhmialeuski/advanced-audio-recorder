/**
 * Prominent on-screen recording banner, primarily for mobile where there
 * is no ribbon icon to show that a recording is in progress. Displays a
 * pulsing indicator, the elapsed time, and a stop button.
 * @module ui/RecordingBanner
 */

import { setIcon } from 'obsidian';
import { formatTimecode } from '../utils/TimeUtils';

/**
 * A floating recording banner appended to the document body.
 */
export class RecordingBanner {
	private el: HTMLElement | null = null;
	private timeEl: HTMLElement | null = null;

	/**
	 * @param onStop - Invoked when the banner's stop button is tapped
	 */
	constructor(private readonly onStop: () => void) {}

	/**
	 * Shows the banner (creating it on first call) and reflects the paused
	 * state.
	 * @param paused - Whether the recording is paused
	 */
	show(paused: boolean): void {
		if (!this.el) {
			this.el = activeDocument.body.createDiv({
				cls: 'aar-recording-banner',
			});
			this.el.createSpan({ cls: 'aar-recording-banner-dot' });
			this.timeEl = this.el.createSpan({
				cls: 'aar-recording-banner-time',
				text: '0:00',
			});
			const stop = this.el.createSpan({
				cls: 'aar-recording-banner-stop',
			});
			stop.setAttribute('aria-label', 'Stop recording');
			stop.setAttribute('role', 'button');
			stop.setAttribute('tabindex', '0');
			setIcon(stop, 'square');
			stop.addEventListener('click', (event) => {
				event.stopPropagation();
				this.onStop();
			});
			// A role="button" element must also activate on Enter/Space
			stop.addEventListener('keydown', (event) => {
				if (event.key === 'Enter' || event.key === ' ') {
					event.preventDefault();
					event.stopPropagation();
					this.onStop();
				}
			});
		}
		this.el.toggleClass('is-paused', paused);
	}

	/**
	 * Updates the elapsed-time label.
	 * @param elapsedMs - Elapsed active recording time in milliseconds
	 * @param paused - Whether the recording is paused
	 */
	update(elapsedMs: number, paused: boolean): void {
		if (this.timeEl) {
			const time = formatTimecode(elapsedMs / 1000);
			this.timeEl.textContent = paused ? `Paused ${time}` : time;
		}
	}

	/**
	 * Removes the banner from the DOM.
	 */
	hide(): void {
		this.el?.remove();
		this.el = null;
		this.timeEl = null;
	}
}
