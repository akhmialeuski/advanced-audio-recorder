/**
 * Tests for waveform peak extraction and the peak cache.
 */

import {
	computeWaveformPeaks,
	computeWaveformPeaksProgressive,
	downsamplePeaks,
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
	it('changes when the file content changes but not with width', () => {
		const base = waveformCacheKey('a.wav', 100, 2000);
		// Stable for the same file (width is not part of the key, so a
		// resize or mode switch reuses the cached peaks)
		expect(waveformCacheKey('a.wav', 100, 2000)).toBe(base);
		expect(waveformCacheKey('b.wav', 100, 2000)).not.toBe(base);
		expect(waveformCacheKey('a.wav', 101, 2000)).not.toBe(base);
		expect(waveformCacheKey('a.wav', 100, 2001)).not.toBe(base);
	});
});

describe('downsamplePeaks', () => {
	it('returns the input unchanged when it already fits', () => {
		const peaks = [0.1, 0.2, 0.3];
		expect(downsamplePeaks(peaks, 4)).toBe(peaks);
		expect(downsamplePeaks(peaks, 3)).toBe(peaks);
	});

	it('reduces to the target count by taking the max of each group', () => {
		const peaks = [0.1, 0.9, 0.3, 0.2];
		const result = downsamplePeaks(peaks, 2);
		expect(result).toHaveLength(2);
		expect(result[0]).toBeCloseTo(0.9);
		expect(result[1]).toBeCloseTo(0.3);
	});

	it('returns empty for a non-positive target', () => {
		expect(downsamplePeaks([0.1, 0.2], 0)).toEqual([]);
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

describe('computeWaveformPeaks — edge and negative cases', () => {
	it('uses absolute amplitude for negative samples', () => {
		const peaks = computeWaveformPeaks([new Float32Array([-1, 0])], 2);
		expect(peaks[0]).toBeCloseTo(1);
		expect(peaks[1]).toBeCloseTo(0);
	});

	it('returns all zeros for silent input', () => {
		expect(
			computeWaveformPeaks([new Float32Array([0, 0, 0, 0])], 2),
		).toEqual([0, 0]);
	});

	it('handles a bucket count larger than the frame count', () => {
		const peaks = computeWaveformPeaks([new Float32Array([1, 0])], 8);
		expect(peaks).toHaveLength(8);
		expect(Math.max(...peaks)).toBeCloseTo(1);
	});

	it('averages an uneven number of channels', () => {
		const peaks = computeWaveformPeaks(
			[
				new Float32Array([1]),
				new Float32Array([0]),
				new Float32Array([0.5]),
			],
			1,
		);
		expect(peaks[0]).toBeCloseTo(1);
	});

	it('returns empty for a negative bucket count', () => {
		expect(computeWaveformPeaks([new Float32Array([1])], -3)).toEqual([]);
	});
});

describe('computeWaveformPeaksProgressive', () => {
	const immediateYield = (): Promise<void> => Promise.resolve();

	it('produces the same normalized result as the synchronous version', async () => {
		const channel = new Float32Array([
			0.1, 0.1, 0.5, 0.5, 0.9, 0.2, 0.3, 0.0,
		]);
		const progressive = await computeWaveformPeaksProgressive(
			[channel],
			4,
			{
				chunkBuckets: 1,
				yieldControl: immediateYield,
			},
		);
		const sync = computeWaveformPeaks([channel], 4);
		expect(progressive).toHaveLength(4);
		progressive.forEach((value, i) => {
			expect(value).toBeCloseTo(sync[i]);
		});
	});

	it('reports a normalized snapshot after each chunk and yields between chunks', async () => {
		const channel = new Float32Array([0.2, 0.4, 0.6, 0.8]);
		const snapshots: number[][] = [];
		let yields = 0;
		const final = await computeWaveformPeaksProgressive([channel], 4, {
			chunkBuckets: 2,
			onProgress: (peaks) => snapshots.push([...peaks]),
			yieldControl: () => {
				yields++;
				return Promise.resolve();
			},
		});
		// 4 buckets / 2 per chunk = 2 chunks -> 2 snapshots, 1 yield between
		expect(snapshots).toHaveLength(2);
		expect(yields).toBe(1);
		for (const snapshot of snapshots) {
			expect(snapshot).toHaveLength(4);
			for (const value of snapshot) {
				expect(value).toBeGreaterThanOrEqual(0);
				expect(value).toBeLessThanOrEqual(1);
			}
		}
		// The last snapshot matches the returned, fully normalized peaks
		expect(snapshots[snapshots.length - 1]).toEqual(final);
	});

	it('aborts early and stops computing further chunks', async () => {
		const channel = new Float32Array([1, 1, 1, 1, 1, 1, 1, 1]);
		let progressCalls = 0;
		const result = await computeWaveformPeaksProgressive([channel], 8, {
			chunkBuckets: 2,
			yieldControl: immediateYield,
			onProgress: () => {
				progressCalls++;
			},
			// Abort once the first chunk has reported progress
			shouldAbort: () => progressCalls >= 1,
		});
		expect(result).toHaveLength(8);
		expect(progressCalls).toBe(1);
		// Buckets past the first chunk were never computed
		expect(result.slice(2)).toEqual([0, 0, 0, 0, 0, 0]);
	});

	it('mirrors the synchronous edge cases', async () => {
		expect(
			await computeWaveformPeaksProgressive([], 4, {
				yieldControl: immediateYield,
			}),
		).toEqual([]);
		expect(
			await computeWaveformPeaksProgressive([new Float32Array([1])], 0, {
				yieldControl: immediateYield,
			}),
		).toEqual([]);
		expect(
			await computeWaveformPeaksProgressive([new Float32Array(0)], 3, {
				yieldControl: immediateYield,
			}),
		).toEqual([0, 0, 0]);
	});
});

describe('WaveformPeakCache — eviction and overwrite', () => {
	it('evicts when the bound is a single entry', () => {
		const cache = new WaveformPeakCache(1);
		cache.set('a', [1]);
		cache.set('b', [2]);
		expect(cache.get('a')).toBeUndefined();
		expect(cache.get('b')).toEqual([2]);
	});

	it('overwriting a key does not grow the cache', () => {
		const cache = new WaveformPeakCache(2);
		cache.set('a', [1]);
		cache.set('a', [9]);
		cache.set('b', [2]);
		cache.set('c', [3]);
		expect(cache.get('a')).toBeUndefined();
		expect(cache.get('b')).toEqual([2]);
		expect(cache.get('c')).toEqual([3]);
	});
});
