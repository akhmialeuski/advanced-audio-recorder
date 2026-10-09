/**
 * Prominent on-screen recording banner, primarily for mobile where there
 * is no ribbon icon to show that a recording is in progress. Displays a
 * pulsing indicator, the elapsed time, and a stop button, and can be
 * dragged to one of the anchors the stylesheet places it at.
 * @module ui/RecordingBanner
 */

import { setIcon } from 'obsidian';
import { RecordingBannerAnchor } from '../settings/settingsSchema';
import { formatTimecode } from '../utils/TimeUtils';

/**
 * Finger travel, in CSS px, before a press on the banner becomes a drag.
 * Android's touch slop is 8dp; a little more keeps a slightly shaky tap on
 * the stop button a tap, because a tap is the one gesture that loses nothing.
 */
export const BANNER_DRAG_SLOP_PX = 10;

/** What the banner reports to the plugin. */
export interface RecordingBannerCallbacks {
	/** Invoked when the banner's stop button is tapped. */
	onStop(): void;
	/** Invoked when a drag leaves the banner at another anchor. */
	onAnchorChange(anchor: RecordingBannerAnchor): void;
}

/** A press on the banner that has not been released yet. */
interface BannerPress {
	pointerId: number;
	startX: number;
	startY: number;
	/** Whether the press travelled past the slop and now moves the banner. */
	dragging: boolean;
}

/**
 * The anchor a banner dropped at a point snaps to: the half of the screen
 * picks the edge and the third of its width picks the side.
 * @param x - Horizontal centre of the dropped banner, in CSS px
 * @param y - Vertical centre of the dropped banner, in CSS px
 * @param width - Viewport width, in CSS px
 * @param height - Viewport height, in CSS px
 */
export function nearestBannerAnchor(
	x: number,
	y: number,
	width: number,
	height: number,
): RecordingBannerAnchor {
	const top = y < height / 2;
	if (x < width / 3) {
		return top
			? RecordingBannerAnchor.TopLeft
			: RecordingBannerAnchor.BottomLeft;
	}
	if (x < (width * 2) / 3) {
		return top
			? RecordingBannerAnchor.TopCenter
			: RecordingBannerAnchor.BottomCenter;
	}
	return top
		? RecordingBannerAnchor.TopRight
		: RecordingBannerAnchor.BottomRight;
}

/**
 * A floating recording banner appended to the document body.
 */
export class RecordingBanner {
	private el: HTMLElement | null = null;
	private timeEl: HTMLElement | null = null;
	private press: BannerPress | null = null;
	/**
	 * Set when a drag ends, so the click a browser may still deliver to the
	 * stop button under the finger does not stop the recording. Cleared by
	 * the next press, so a browser that sends no such click cannot leave it
	 * armed against a real tap later.
	 */
	private suppressNextClick = false;

	/**
	 * @param callbacks - What a tap on stop and a finished drag report
	 */
	constructor(private readonly callbacks: RecordingBannerCallbacks) {}

	/**
	 * Shows the banner (creating it on first call) and reflects the paused
	 * state and the anchor it rests at.
	 * @param paused - Whether the recording is paused
	 * @param anchor - Where the banner rests
	 */
	show(paused: boolean, anchor: RecordingBannerAnchor): void {
		if (!this.el) {
			this.el = this.create();
		}
		this.el.toggleClass('is-paused', paused);
		// An attribute rather than a class per anchor: setting it replaces
		// the previous anchor, and the stylesheet matches its two halves.
		this.el.setAttribute('data-anchor', anchor);
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
		this.press = null;
		this.suppressNextClick = false;
	}

	/** Builds the banner and wires its stop button and its drag. */
	private create(): HTMLElement {
		const el = activeDocument.body.createDiv({
			cls: 'aar-recording-banner',
		});
		el.createSpan({ cls: 'aar-recording-banner-dot' });
		this.timeEl = el.createSpan({
			cls: 'aar-recording-banner-time',
			text: '0:00',
		});
		const stop = el.createSpan({ cls: 'aar-recording-banner-stop' });
		stop.setAttribute('aria-label', 'Stop recording');
		stop.setAttribute('role', 'button');
		stop.setAttribute('tabindex', '0');
		setIcon(stop, 'square');
		// The listeners live on elements hide() removes, so they go with them
		// rather than accumulating on the plugin for every recording.
		stop.addEventListener('click', (event) => {
			event.stopPropagation();
			if (this.suppressNextClick) {
				this.suppressNextClick = false;
				return;
			}
			this.callbacks.onStop();
		});
		// A role="button" element must also activate on Enter/Space
		stop.addEventListener('keydown', (event) => {
			if (event.key === 'Enter' || event.key === ' ') {
				event.preventDefault();
				event.stopPropagation();
				this.callbacks.onStop();
			}
		});
		this.registerDrag(el);
		return el;
	}

	/**
	 * Wires the drag on the whole banner, the stop button included, because
	 * on a phone the button is most of what a finger can grab. The pointer is
	 * captured only once the press passes the slop: captured on press, a tap
	 * would deliver its click to the banner instead of the stop button.
	 */
	private registerDrag(el: HTMLElement): void {
		el.addEventListener('pointerdown', (event) => {
			if (event.button !== 0) {
				return;
			}
			// Obsidian opens a sidebar on a swipe from the screen edge, and a
			// banner anchored at the side sits right where that swipe starts
			event.stopPropagation();
			this.suppressNextClick = false;
			this.press = {
				pointerId: event.pointerId,
				startX: event.clientX,
				startY: event.clientY,
				dragging: false,
			};
		});
		el.addEventListener('pointermove', (event) => {
			const press = this.press;
			if (!press || press.pointerId !== event.pointerId) {
				return;
			}
			const dx = event.clientX - press.startX;
			const dy = event.clientY - press.startY;
			if (!press.dragging) {
				if (Math.hypot(dx, dy) < BANNER_DRAG_SLOP_PX) {
					return;
				}
				press.dragging = true;
				el.setPointerCapture(event.pointerId);
				el.addClass('is-dragging');
			}
			el.setCssProps({
				'--aar-banner-drag-x': `${String(dx)}px`,
				'--aar-banner-drag-y': `${String(dy)}px`,
			});
		});
		el.addEventListener('pointerup', (event) => {
			const press = this.press;
			if (!press || press.pointerId !== event.pointerId) {
				return;
			}
			this.press = null;
			if (!press.dragging) {
				// A tap: the stop button's own click handles it
				return;
			}
			this.suppressNextClick = true;
			// Measured before the offset is cleared, so this is where the
			// finger left the banner rather than where it started
			const rect = el.getBoundingClientRect();
			const anchor = nearestBannerAnchor(
				rect.left + rect.width / 2,
				rect.top + rect.height / 2,
				activeWindow.innerWidth,
				activeWindow.innerHeight,
			);
			this.endDrag(el);
			if (anchor !== el.getAttribute('data-anchor')) {
				el.setAttribute('data-anchor', anchor);
				this.callbacks.onAnchorChange(anchor);
			}
		});
		// The system took the gesture over, so the banner goes back to where
		// it rested instead of moving to a place nobody chose
		el.addEventListener('pointercancel', (event) => {
			if (this.press?.pointerId !== event.pointerId) {
				return;
			}
			this.press = null;
			this.endDrag(el);
		});
	}

	/** Drops the drag offset, leaving the anchor to place the banner. */
	private endDrag(el: HTMLElement): void {
		el.removeClass('is-dragging');
		el.setCssProps({
			'--aar-banner-drag-x': '',
			'--aar-banner-drag-y': '',
		});
	}
}
