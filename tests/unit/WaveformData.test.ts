/**
 * Tests for waveform peak extraction and the peak cache.
 */

import {
	computeWaveformPeaks,
	waveformCacheKey,
	WaveformPeakCache,
} from 'src/player/WaveformData';

describe('computeWaveformPeaks', () => {
	it('returns empty for non-positive bucket counts', () => {
		expect(computeWaveformPeaks([new Float32Array([1])], 0)).toEqual([]);
	});

	it('returns empty when there are no channels', () => {
		expect(computeWaveformPeaks([], 4)).toEqual([]);
	});

	it('returns zeros for empty channel data', () => {
		expect(computeWaveformPeaks([new Float32Array(0)], 3)).toEqual([
			0, 0, 0,
		]);
	});

	it('normalizes peaks so the loudest bucket reaches 1', () => {
		const channel = new Float32Array([0.1, 0.1, 0.5, 0.5]);
		const peaks = computeWaveformPeaks([channel], 2);
		expect(peaks).toHaveLength(2);
		expect(peaks[1]).toBeCloseTo(1);
		expect(peaks[0]).toBeCloseTo(0.2);
	});

	it('mixes channels down to mono by averaging', () => {
		const left = new Float32Array([1, 0]);
		const right = new Float32Array([0, 0]);
		// Bucket 0 mixes (1+0)/2 = 0.5, bucket 1 mixes 0 -> after
		// normalization bucket 0 is the loudest at 1
		const peaks = computeWaveformPeaks([left, right], 2);
		expect(peaks[0]).toBeCloseTo(1);
		expect(peaks[1]).toBeCloseTo(0);
	});

	it('includes trailing frames in the final bucket', () => {
		const channel = new Float32Array([0, 0, 0, 1]);
		const peaks = computeWaveformPeaks([channel], 2);
		// The last frame must influence the final bucket
		expect(peaks[1]).toBeCloseTo(1);
	});
});

describe('waveformCacheKey', () => {
	it('changes when any component changes', () => {
		const base = waveformCacheKey('a.wav', 100, 2000, 64);
		expect(waveformCacheKey('a.wav', 100, 2000, 64)).toBe(base);
		expect(waveformCacheKey('b.wav', 100, 2000, 64)).not.toBe(base);
		expect(waveformCacheKey('a.wav', 101, 2000, 64)).not.toBe(base);
		expect(waveformCacheKey('a.wav', 100, 2001, 64)).not.toBe(base);
		expect(waveformCacheKey('a.wav', 100, 2000, 128)).not.toBe(base);
	});
});

describe('WaveformPeakCache', () => {
	it('stores and retrieves peaks', () => {
		const cache = new WaveformPeakCache(2);
		cache.set('a', [1, 2]);
		expect(cache.get('a')).toEqual([1, 2]);
		expect(cache.get('missing')).toBeUndefined();
	});

	it('evicts the least recently used entry when full', () => {
		const cache = new WaveformPeakCache(2);
		cache.set('a', [1]);
		cache.set('b', [2]);
		// Touch 'a' so 'b' becomes least recently used
		cache.get('a');
		cache.set('c', [3]);
		expect(cache.get('b')).toBeUndefined();
		expect(cache.get('a')).toEqual([1]);
		expect(cache.get('c')).toEqual([3]);
	});

	it('clears all entries', () => {
		const cache = new WaveformPeakCache();
		cache.set('a', [1]);
		cache.clear();
		expect(cache.get('a')).toBeUndefined();
	});
});
