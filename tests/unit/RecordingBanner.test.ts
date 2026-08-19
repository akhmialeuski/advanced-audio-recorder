/**
 * Unit tests for RecordingBanner, the only recording-in-progress
 * indicator on mobile (no ribbon icon there). DOM-driven: renders the
 * real banner into the document, asserts on the rendered output and the
 * stop callback, and covers the pause-state and teardown behavior a
 * phone-only regression would otherwise hide.
 * @module tests/unit/RecordingBanner.test
 */

import { RecordingBanner } from 'src/ui/RecordingBanner';
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

describe('RecordingBanner', () => {
	it('renders the dot, timer, and an accessible stop control', () => {
		new RecordingBanner(jest.fn()).show(false);

		expect(maybeEl(bannerEl(), BANNER.dot)).not.toBeNull();
		expect(bannerEl()).toShowTime('0:00');
		const stop = stopEl();
		expect(stop.getAttribute('role')).toBe('button');
		expect(stop.getAttribute('aria-label')).toBe('Stop recording');
		expect(stop.getAttribute('tabindex')).toBe('0');
	});

	it('creates the banner once across repeated show calls', () => {
		const banner = new RecordingBanner(jest.fn());
		banner.show(false);
		banner.show(true);
		banner.show(false);

		expect(allEls(document.body, BANNER.root)).toHaveLength(1);
	});

	it('reflects the paused state on the banner class', () => {
		const banner = new RecordingBanner(jest.fn());
		banner.show(true);
		expect(bannerEl().classList.contains('is-paused')).toBe(true);

		banner.show(false);
		expect(bannerEl().classList.contains('is-paused')).toBe(false);
	});

	it('updates the elapsed time, prefixing Paused while paused', () => {
		const banner = new RecordingBanner(jest.fn());
		banner.show(false);

		banner.update(65_000, false);
		expect(bannerEl()).toShowTime('1:05');

		banner.update(65_000, true);
		expect(bannerEl()).toShowTime('Paused 1:05');
	});

	it('fires the stop callback on click', () => {
		const onStop = jest.fn();
		new RecordingBanner(onStop).show(false);

		stopEl().click();

		expect(onStop).toHaveBeenCalledTimes(1);
	});

	it.each([['Enter'], [' ']])(
		'fires the stop callback on %s for keyboard users',
		(key) => {
			const onStop = jest.fn();
			new RecordingBanner(onStop).show(false);

			stopEl().dispatchEvent(
				new KeyboardEvent('keydown', { key, bubbles: true }),
			);

			expect(onStop).toHaveBeenCalledTimes(1);
		},
	);

	it('ignores other keys on the stop control', () => {
		const onStop = jest.fn();
		new RecordingBanner(onStop).show(false);

		stopEl().dispatchEvent(
			new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
		);

		expect(onStop).not.toHaveBeenCalled();
	});

	it('hide removes the banner and a later show recreates it', () => {
		const banner = new RecordingBanner(jest.fn());
		banner.show(false);
		banner.hide();

		expect(maybeEl(document.body, BANNER.root)).toBeNull();

		banner.show(true);
		expect(bannerEl().classList.contains('is-paused')).toBe(true);
	});
});
