/**
 * Unit tests for RecordingBanner, the only recording-in-progress
 * indicator on mobile (no ribbon icon there). DOM-driven: renders the
 * real banner into the document, asserts on the rendered output and the
 * stop callback, and covers the pause-state and teardown behavior a
 * phone-only regression would otherwise hide.
 * @module tests/unit/RecordingBanner.test
 */

import { RecordingBanner } from 'src/ui/RecordingBanner';
import { addObsidianDomExtensions } from '../mocks/obsidian';

// The banner mounts onto activeDocument.body, which Obsidian extends with
// createDiv/createSpan at runtime; mirror that on jsdom's body once.
beforeAll(() => {
	addObsidianDomExtensions(document.body);
});

function bannerEl(): HTMLElement {
	const el = document.body.querySelector<HTMLElement>(
		'.aar-recording-banner',
	);
	if (!el) {
		throw new Error('banner not rendered');
	}
	return el;
}

function stopEl(): HTMLElement {
	const el = bannerEl().querySelector<HTMLElement>(
		'.aar-recording-banner-stop',
	);
	if (!el) {
		throw new Error('stop control not rendered');
	}
	return el;
}

afterEach(() => {
	document.body.innerHTML = '';
});

describe('RecordingBanner', () => {
	it('renders the dot, timer, and an accessible stop control', () => {
		new RecordingBanner(jest.fn()).show(false);

		expect(
			bannerEl().querySelector('.aar-recording-banner-dot'),
		).not.toBeNull();
		expect(
			bannerEl().querySelector('.aar-recording-banner-time')?.textContent,
		).toBe('0:00');
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

		expect(
			document.body.querySelectorAll('.aar-recording-banner'),
		).toHaveLength(1);
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
		expect(
			bannerEl().querySelector('.aar-recording-banner-time')?.textContent,
		).toBe('1:05');

		banner.update(65_000, true);
		expect(
			bannerEl().querySelector('.aar-recording-banner-time')?.textContent,
		).toBe('Paused 1:05');
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

		expect(document.body.querySelector('.aar-recording-banner')).toBeNull();

		banner.show(true);
		expect(bannerEl().classList.contains('is-paused')).toBe(true);
	});
});
