/**
 * Tests for the playback-rate helpers - the single source of truth for
 * the speed control shared by both render modes.
 */

import {
	formatPlaybackRate,
	speedMenuItems,
	steppedPlaybackRate,
} from 'src/player/playbackRate';

describe('formatPlaybackRate', () => {
	it.each([
		{ rate: 1, shown: '1x' },
		{ rate: 1.5, shown: '1.5x' },
		{ rate: 0.5, shown: '0.5x' },
		{ rate: 2, shown: '2x' },
		// The ends of what a media element accepts, plus the two shapes the
		// browser hands back that a naive toString would render badly: a
		// rounding drift, and a rate with more decimals than the button fits.
		{ rate: 0.25, shown: '0.25x' },
		{ rate: 4, shown: '4x' },
		{ rate: 1.0000000001, shown: '1x' },
		{ rate: 1.25, shown: '1.25x' },
	])('shows $rate as "$shown"', ({ rate, shown }) => {
		// The label goes on a narrow button, so a trailing zero would cost a
		// character the control does not have.
		expect(formatPlaybackRate(rate)).toBe(shown);
	});
});

describe('speedMenuItems', () => {
	const presets = [0.5, 1, 1.5, 2];

	it('produces one labelled entry per preset', () => {
		const items = speedMenuItems(1, presets);
		expect(items.map((i) => i.label)).toEqual(['0.5x', '1x', '1.5x', '2x']);
		expect(items.map((i) => i.rate)).toEqual(presets);
	});

	it.each([
		{ name: 'the rate exactly', current: 1.5, checked: [1.5] },
		{
			name: 'a rate the element drifted off by a rounding error',
			current: 1.5000000001,
			checked: [1.5],
		},
		{ name: 'a rate no preset offers', current: 1.23, checked: [] },
	])('ticks $name', ({ current, checked }) => {
		// The element's playbackRate comes back from the browser, not from
		// the preset that was set, so an exact comparison ticks nothing.
		const items = speedMenuItems(current, presets);

		expect(items.filter((item) => item.checked).map((i) => i.rate)).toEqual(
			checked,
		);
	});

	it('returns an empty list for no presets', () => {
		expect(speedMenuItems(1, [])).toEqual([]);
	});
});

describe('steppedPlaybackRate', () => {
	const presets = [0.5, 1, 1.5, 2];

	it.each([
		{
			name: 'up from a preset',
			current: 1,
			direction: 1 as const,
			next: 1.5,
		},
		{
			name: 'down from a preset',
			current: 1.5,
			direction: -1 as const,
			next: 1,
		},
		{
			name: 'up from between two presets',
			current: 1.2,
			direction: 1 as const,
			next: 1.5,
		},
		{
			name: 'down from between two presets',
			current: 1.2,
			direction: -1 as const,
			next: 1,
		},
	])('steps $name', ({ current, direction, next }) => {
		expect(steppedPlaybackRate(current, presets, direction)).toBe(next);
	});

	it.each([
		{ name: 'the fastest preset', current: 2, direction: 1 as const },
		{ name: 'the slowest preset', current: 0.5, direction: -1 as const },
	])('holds at $name', ({ current, direction }) => {
		// A held hotkey must stop at the end instead of wrapping around to
		// the opposite extreme, which would make the audio unlistenable.
		expect(steppedPlaybackRate(current, presets, direction)).toBe(current);
	});

	it.each([
		{ name: 'up', direction: 1 as const, next: 1.5 },
		{ name: 'down', direction: -1 as const, next: 0.5 },
	])(
		'steps $name past a rate the element drifted off',
		({ direction, next }) => {
			// The rate comes back from the browser, so a drifted 1 must not
			// count as a step of its own.
			expect(steppedPlaybackRate(1.0000000001, presets, direction)).toBe(
				next,
			);
		},
	);

	it.each([1 as const, -1 as const])(
		'keeps the current rate with no presets in direction %s',
		(direction) => {
			expect(steppedPlaybackRate(1.25, [], direction)).toBe(1.25);
		},
	);
});
