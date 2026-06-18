/**
 * Tests for the playback-rate helpers — the single source of truth for
 * the speed control shared by both render modes.
 */

import { formatPlaybackRate, speedMenuItems } from 'src/player/playbackRate';

describe('formatPlaybackRate', () => {
	it('appends an x to the rate', () => {
		expect(formatPlaybackRate(1)).toBe('1x');
		expect(formatPlaybackRate(1.5)).toBe('1.5x');
		expect(formatPlaybackRate(0.5)).toBe('0.5x');
	});
});

describe('speedMenuItems', () => {
	const presets = [0.5, 1, 1.5, 2];

	it('produces one labelled entry per preset', () => {
		const items = speedMenuItems(1, presets);
		expect(items.map((i) => i.label)).toEqual(['0.5x', '1x', '1.5x', '2x']);
		expect(items.map((i) => i.rate)).toEqual(presets);
	});

	it('checks exactly the entry matching the current rate', () => {
		const items = speedMenuItems(1.5, presets);
		expect(items.filter((i) => i.checked).map((i) => i.rate)).toEqual([
			1.5,
		]);
	});

	it('tolerates floating-point drift when matching', () => {
		const items = speedMenuItems(1.5000000001, presets);
		expect(items.find((i) => i.rate === 1.5)?.checked).toBe(true);
	});

	it('checks nothing when the current rate matches no preset', () => {
		const items = speedMenuItems(1.23, presets);
		expect(items.some((i) => i.checked)).toBe(false);
	});

	it('returns an empty list for no presets', () => {
		expect(speedMenuItems(1, [])).toEqual([]);
	});
});
