/**
 * Guards the playback-position logic that drives both the waveform and the
 * plain seek bar. A regression here is what made the seek bar show no
 * position when the waveform was off.
 */

import { playbackProgress } from 'src/player/playbackProgress';

describe('playbackProgress', () => {
	it('is the played fraction for a known duration', () => {
		expect(playbackProgress(0, 100)).toBe(0);
		expect(playbackProgress(25, 100)).toBe(0.25);
		expect(playbackProgress(100, 100)).toBe(1);
	});

	it('clamps out-of-range positions into 0..1', () => {
		expect(playbackProgress(-5, 100)).toBe(0);
		expect(playbackProgress(150, 100)).toBe(1);
	});

	it('returns 0 when the duration is unknown or non-positive', () => {
		expect(playbackProgress(10, Number.NaN)).toBe(0);
		expect(playbackProgress(10, Number.POSITIVE_INFINITY)).toBe(0);
		expect(playbackProgress(10, 0)).toBe(0);
		expect(playbackProgress(10, -100)).toBe(0);
	});
});
