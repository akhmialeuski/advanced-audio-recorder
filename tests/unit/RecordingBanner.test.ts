/**
 * Unit tests for RecordingBanner, the only recording-in-progress
 * indicator on mobile (no ribbon icon there). DOM-driven: renders the
 * real banner into the document, asserts on the rendered output and the
 * stop callback, and covers the pause-state and teardown behavior a
 * phone-only regression would otherwise hide.
 * @module tests/unit/RecordingBanner.test
 */

import { RecordingBannerAnchor } from 'src/settings/settingsSchema';
import {
	BANNER_DRAG_SLOP_PX,
	RecordingBanner,
	nearestBannerAnchor,
} from 'src/ui/RecordingBanner';
import { allEls, el, maybeEl } from '../helpers/dom';
import { BANNER } from '../helpers/selectors';
import { addObsidianDomExtensions } from '../mocks/obsidian';

// The banner mounts onto activeDocument.body, which Obsidian extends with
// createDiv/createSpan at runtime; mirror that on jsdom's body once.
beforeAll(() => {
	addObsidianDomExtensions(document.body);
});

/** The banner, asserting it is on screen. */
function bannerEl(): HTMLElement {
	return el(document.body, BANNER.root);
}

/** The banner's stop control, asserting it is there. */
function stopEl(): HTMLElement {
	return el(bannerEl(), BANNER.stop);
}

afterEach(() => {
	document.body.innerHTML = '';
});

/** A banner with spy callbacks, shown at the default anchor. */
function mount(paused = false): {
	banner: RecordingBanner;
	onStop: jest.Mock;
	onAnchorChange: jest.Mock;
} {
	const onStop = jest.fn();
	const onAnchorChange = jest.fn();
	const banner = new RecordingBanner({ onStop, onAnchorChange });
	banner.show(paused, RecordingBannerAnchor.TopCenter);
	return { banner, onStop, onAnchorChange };
}

describe('RecordingBanner', () => {
	it('renders the dot, timer, and an accessible stop control', () => {
		mount();

		expect(maybeEl(bannerEl(), BANNER.dot)).not.toBeNull();
		expect(bannerEl()).toShowTime('0:00');
		const stop = stopEl();
		expect(stop.getAttribute('role')).toBe('button');
		expect(stop.getAttribute('aria-label')).toBe('Stop recording');
		expect(stop.getAttribute('tabindex')).toBe('0');
	});

	it('creates the banner once across repeated show calls', () => {
		const { banner } = mount();
		banner.show(true, RecordingBannerAnchor.TopCenter);
		banner.show(false, RecordingBannerAnchor.TopCenter);

		expect(allEls(document.body, BANNER.root)).toHaveLength(1);
	});

	it('reflects the paused state on the banner class', () => {
		const { banner } = mount(true);
		expect(bannerEl().classList.contains('is-paused')).toBe(true);

		banner.show(false, RecordingBannerAnchor.TopCenter);
		expect(bannerEl().classList.contains('is-paused')).toBe(false);
	});

	it('updates the elapsed time, prefixing Paused while paused', () => {
		const { banner } = mount();

		banner.update(65_000, false);
		expect(bannerEl()).toShowTime('1:05');

		banner.update(65_000, true);
		expect(bannerEl()).toShowTime('Paused 1:05');
	});

	it('fires the stop callback on click', () => {
		const { onStop } = mount();

		stopEl().click();

		expect(onStop).toHaveBeenCalledTimes(1);
	});

	it.each([['Enter'], [' ']])(
		'fires the stop callback on %s for keyboard users',
		(key) => {
			const { onStop } = mount();

			stopEl().dispatchEvent(
				new KeyboardEvent('keydown', { key, bubbles: true }),
			);

			expect(onStop).toHaveBeenCalledTimes(1);
		},
	);

	it('ignores other keys on the stop control', () => {
		const { onStop } = mount();

		stopEl().dispatchEvent(
			new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
		);

		expect(onStop).not.toHaveBeenCalled();
	});

	it('hide removes the banner and a later show recreates it', () => {
		const { banner } = mount();
		banner.hide();

		expect(maybeEl(document.body, BANNER.root)).toBeNull();

		banner.show(true, RecordingBannerAnchor.TopCenter);
		expect(bannerEl().classList.contains('is-paused')).toBe(true);
	});
});

describe('dragging the banner', () => {
	// jsdom's default viewport, which the drop point is measured against
	const VIEWPORT = { width: 1024, height: 768 };

	/**
	 * Dispatches a pointer event on a target. jsdom has no PointerEvent, and
	 * a MouseEvent of the same type reaches the same listeners.
	 */
	function pointer(
		target: HTMLElement,
		type: string,
		clientX: number,
		clientY: number,
		{ pointerId = 1, button = 0 } = {},
	): void {
		const event = new MouseEvent(type, {
			clientX,
			clientY,
			button,
			bubbles: true,
		});
		Object.defineProperty(event, 'pointerId', { value: pointerId });
		target.dispatchEvent(event);
	}

	/** Stubs the capture API jsdom lacks and places the banner's box. */
	function layout(centre: { x: number; y: number }): HTMLElement {
		const banner = bannerEl();
		banner.setPointerCapture = jest.fn();
		banner.getBoundingClientRect = jest.fn(
			() =>
				({
					left: centre.x - 60,
					top: centre.y - 20,
					width: 120,
					height: 40,
				}) as DOMRect,
		);
		return banner;
	}

	/** Presses the stop button, moves by an offset, and releases. */
	function dragFromStop(dx: number, dy: number): void {
		const stop = stopEl();
		pointer(stop, 'pointerdown', 500, 40);
		pointer(stop, 'pointermove', 500 + dx, 40 + dy);
		pointer(stop, 'pointerup', 500 + dx, 40 + dy);
	}

	it('moves the banner with the finger once the press passes the slop', () => {
		mount();
		const banner = layout({ x: 512, y: 40 });
		const stop = stopEl();

		pointer(stop, 'pointerdown', 500, 40);
		pointer(stop, 'pointermove', 500, 40 + BANNER_DRAG_SLOP_PX + 30);

		expect(banner.classList.contains('is-dragging')).toBe(true);
		expect(banner.setPointerCapture).toHaveBeenCalledWith(1);
		expect(banner.style.getPropertyValue('--aar-banner-drag-y')).toBe(
			`${String(BANNER_DRAG_SLOP_PX + 30)}px`,
		);
	});

	it('keeps following the finger after the drag has started', () => {
		mount();
		const banner = layout({ x: 512, y: 40 });
		const stop = stopEl();

		pointer(stop, 'pointerdown', 500, 40);
		pointer(stop, 'pointermove', 500, 100);
		pointer(stop, 'pointermove', 420, 300);

		expect(banner.setPointerCapture).toHaveBeenCalledTimes(1);
		expect(banner.style.getPropertyValue('--aar-banner-drag-x')).toBe(
			'-80px',
		);
		expect(banner.style.getPropertyValue('--aar-banner-drag-y')).toBe(
			'260px',
		);
	});

	it('treats a press that stays inside the slop as a tap on stop', () => {
		const { onStop, onAnchorChange } = mount();
		const banner = layout({ x: 512, y: 40 });

		dragFromStop(BANNER_DRAG_SLOP_PX - 1, 0);
		stopEl().click();

		expect(banner.classList.contains('is-dragging')).toBe(false);
		expect(banner.setPointerCapture).not.toHaveBeenCalled();
		expect(onStop).toHaveBeenCalledTimes(1);
		expect(onAnchorChange).not.toHaveBeenCalled();
	});

	it('never stops the recording when a drag starts on the stop button', () => {
		const { onStop, onAnchorChange } = mount();
		layout({ x: 900, y: 700 });

		dragFromStop(400, 660);
		// The click a browser may deliver to the button under the finger
		stopEl().click();

		expect(onStop).not.toHaveBeenCalled();
		expect(onAnchorChange).toHaveBeenCalledWith(
			RecordingBannerAnchor.BottomRight,
		);
	});

	it('rests at the anchor it snapped to and drops the drag offset', () => {
		mount();
		const banner = layout({ x: 100, y: 700 });

		dragFromStop(-400, 660);

		expect(banner.getAttribute('data-anchor')).toBe(
			RecordingBannerAnchor.BottomLeft,
		);
		expect(banner.classList.contains('is-dragging')).toBe(false);
		expect(banner.style.getPropertyValue('--aar-banner-drag-x')).toBe('');
		expect(banner.style.getPropertyValue('--aar-banner-drag-y')).toBe('');
	});

	it('reports nothing when a drag ends at the anchor it started from', () => {
		const { onAnchorChange } = mount();
		layout({ x: 520, y: 60 });

		dragFromStop(20, 20);

		expect(onAnchorChange).not.toHaveBeenCalled();
	});

	it('lets the next tap stop the recording after a drag', () => {
		// A browser that sends no click after the drag must not leave the
		// suppression armed against the tap that follows.
		const { onStop } = mount();
		layout({ x: 900, y: 700 });
		dragFromStop(400, 660);

		const stop = stopEl();
		pointer(stop, 'pointerdown', 900, 700);
		pointer(stop, 'pointerup', 900, 700);
		stop.click();

		expect(onStop).toHaveBeenCalledTimes(1);
	});

	it('goes back to its anchor when the system cancels the gesture', () => {
		const { onAnchorChange } = mount();
		const banner = layout({ x: 900, y: 700 });
		const stop = stopEl();

		pointer(stop, 'pointerdown', 500, 40);
		pointer(stop, 'pointermove', 900, 700);
		pointer(stop, 'pointercancel', 900, 700);
		pointer(stop, 'pointerup', 900, 700);

		expect(onAnchorChange).not.toHaveBeenCalled();
		expect(banner.getAttribute('data-anchor')).toBe(
			RecordingBannerAnchor.TopCenter,
		);
		expect(banner.classList.contains('is-dragging')).toBe(false);
	});

	it('leaves a press with another mouse button to the context menu', () => {
		const { onAnchorChange } = mount();
		const banner = layout({ x: 900, y: 700 });
		const stop = stopEl();

		pointer(stop, 'pointerdown', 500, 40, { button: 2 });
		pointer(stop, 'pointermove', 900, 700);
		pointer(stop, 'pointerup', 900, 700);

		expect(banner.classList.contains('is-dragging')).toBe(false);
		expect(onAnchorChange).not.toHaveBeenCalled();
	});

	it('ignores a pointer that only hovers over the banner', () => {
		mount();
		const banner = layout({ x: 900, y: 700 });

		pointer(stopEl(), 'pointermove', 900, 700);
		pointer(stopEl(), 'pointerup', 900, 700);
		pointer(stopEl(), 'pointercancel', 900, 700);

		expect(banner.classList.contains('is-dragging')).toBe(false);
		expect(banner.setPointerCapture).not.toHaveBeenCalled();
	});

	it('follows only the finger that pressed, not a second one', () => {
		const { onAnchorChange } = mount();
		const banner = layout({ x: 900, y: 700 });
		const stop = stopEl();

		pointer(stop, 'pointerdown', 500, 40);
		pointer(stop, 'pointermove', 900, 700, { pointerId: 2 });
		pointer(stop, 'pointerup', 900, 700, { pointerId: 2 });
		pointer(stop, 'pointercancel', 900, 700, { pointerId: 2 });

		expect(banner.classList.contains('is-dragging')).toBe(false);
		expect(onAnchorChange).not.toHaveBeenCalled();
	});

	it('replaces the anchor rather than accumulating anchors', () => {
		const { banner } = mount();

		banner.show(false, RecordingBannerAnchor.BottomLeft);

		expect(bannerEl().getAttribute('data-anchor')).toBe(
			RecordingBannerAnchor.BottomLeft,
		);
	});

	it.each([
		[100, 100, RecordingBannerAnchor.TopLeft],
		[512, 100, RecordingBannerAnchor.TopCenter],
		[1000, 100, RecordingBannerAnchor.TopRight],
		[100, 700, RecordingBannerAnchor.BottomLeft],
		[512, 700, RecordingBannerAnchor.BottomCenter],
		[1000, 700, RecordingBannerAnchor.BottomRight],
		// The borders belong to the region after them
		[VIEWPORT.width / 3, 0, RecordingBannerAnchor.TopCenter],
		[(VIEWPORT.width * 2) / 3, 0, RecordingBannerAnchor.TopRight],
		[0, VIEWPORT.height / 2, RecordingBannerAnchor.BottomLeft],
		// A drop past the edge still snaps to the screen
		[-50, -50, RecordingBannerAnchor.TopLeft],
		[2000, 2000, RecordingBannerAnchor.BottomRight],
	])('snaps a drop at (%d, %d) to %s', (x, y, anchor) => {
		expect(nearestBannerAnchor(x, y, VIEWPORT.width, VIEWPORT.height)).toBe(
			anchor,
		);
	});
});
