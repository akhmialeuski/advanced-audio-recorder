/**
 * Guards the playback-position logic that drives both the waveform and the
 * plain seek bar. A regression here is what made the seek bar show no
 * position when the waveform was off.
 */

import { playbackProgress } from 'src/player/playbackProgress';

describe('playbackProgress', () => {
	it.each([
		{ name: 'the start', position: 0, duration: 100, expected: 0 },
		{ name: 'a quarter in', position: 25, duration: 100, expected: 0.25 },
		{ name: 'the end', position: 100, duration: 100, expected: 1 },
	])('is $expected at $name', ({ position, duration, expected }) => {
		expect(playbackProgress(position, duration)).toBe(expected);
	});

	it.each([
		{ name: 'before the start', position: -5, expected: 0 },
		{ name: 'past the end', position: 150, expected: 1 },
	])('clamps a position $name to $expected', ({ position, expected }) => {
		// A seek that overshoots, or an element reporting a stale position
		// after a source swap, must not push the fill outside the bar.
		expect(playbackProgress(position, 100)).toBe(expected);
	});

	it.each([
		{ name: 'has not loaded yet', duration: Number.NaN },
		{ name: 'is a live stream', duration: Number.POSITIVE_INFINITY },
		{ name: 'reads as zero', duration: 0 },
		{ name: 'reads as negative', duration: -100 },
	])('shows no progress while the length $name', ({ duration }) => {
		// Any of these would divide into nonsense; the bar stays at the start
		// until a real length arrives.
		expect(playbackProgress(10, duration)).toBe(0);
	});
});
