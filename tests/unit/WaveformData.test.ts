/**
 * Tests for waveform peak extraction and the peak cache.
 */

import {
	computeWaveformPeaksProgressive,
	downsamplePeaks,
	SharedAudioDecoder,
	waveformCacheKey,
	WaveformPeakCache,
} from 'src/player/WaveformData';
import { WAVEFORM_DECODE_SAMPLE_RATE } from 'src/constants';

/** Resolve immediately so progressive extraction completes within a test tick. */
const immediateYield = (): Promise<void> => Promise.resolve();

describe('computeWaveformPeaksProgressive - peak extraction', () => {
	it('returns empty for non-positive bucket counts', async () => {
		expect(
			await computeWaveformPeaksProgressive([new Float32Array([1])], 0, {
				yieldControl: immediateYield,
			}),
		).toEqual([]);
	});

	it('returns empty when there are no channels', async () => {
		expect(
			await computeWaveformPeaksProgressive([], 4, {
				yieldControl: immediateYield,
			}),
		).toEqual([]);
	});

	it('returns zeros for empty channel data', async () => {
		expect(
			await computeWaveformPeaksProgressive([new Float32Array(0)], 3, {
				yieldControl: immediateYield,
			}),
		).toEqual([0, 0, 0]);
	});

	it('normalizes peaks so the loudest bucket reaches 1', async () => {
		const channel = new Float32Array([0.1, 0.1, 0.5, 0.5]);
		const peaks = await computeWaveformPeaksProgressive([channel], 2, {
			yieldControl: immediateYield,
		});
		expect(peaks).toHaveLength(2);
		expect(peaks[1]).toBeCloseTo(1);
		expect(peaks[0]).toBeCloseTo(0.2);
	});

	it('mixes channels down to mono by averaging', async () => {
		const left = new Float32Array([1, 0]);
		const right = new Float32Array([0, 0]);
		// Bucket 0 mixes (1+0)/2 = 0.5, bucket 1 mixes 0 -> after
		// normalization bucket 0 is the loudest at 1
		const peaks = await computeWaveformPeaksProgressive([left, right], 2, {
			yieldControl: immediateYield,
		});
		expect(peaks[0]).toBeCloseTo(1);
		expect(peaks[1]).toBeCloseTo(0);
	});

	it('includes trailing frames in the final bucket', async () => {
		const channel = new Float32Array([0, 0, 0, 1]);
		const peaks = await computeWaveformPeaksProgressive([channel], 2, {
			yieldControl: immediateYield,
		});
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

describe('computeWaveformPeaksProgressive - edge and negative cases', () => {
	it('uses absolute amplitude for negative samples', async () => {
		const peaks = await computeWaveformPeaksProgressive(
			[new Float32Array([-1, 0])],
			2,
			{ yieldControl: immediateYield },
		);
		expect(peaks[0]).toBeCloseTo(1);
		expect(peaks[1]).toBeCloseTo(0);
	});

	it('returns all zeros for silent input', async () => {
		expect(
			await computeWaveformPeaksProgressive(
				[new Float32Array([0, 0, 0, 0])],
				2,
				{ yieldControl: immediateYield },
			),
		).toEqual([0, 0]);
	});

	it('handles a bucket count larger than the frame count', async () => {
		const peaks = await computeWaveformPeaksProgressive(
			[new Float32Array([1, 0])],
			8,
			{ yieldControl: immediateYield },
		);
		expect(peaks).toHaveLength(8);
		expect(Math.max(...peaks)).toBeCloseTo(1);
	});

	it('averages an uneven number of channels', async () => {
		const peaks = await computeWaveformPeaksProgressive(
			[
				new Float32Array([1]),
				new Float32Array([0]),
				new Float32Array([0.5]),
			],
			1,
			{ yieldControl: immediateYield },
		);
		expect(peaks[0]).toBeCloseTo(1);
	});

	it('returns empty for a negative bucket count', async () => {
		expect(
			await computeWaveformPeaksProgressive([new Float32Array([1])], -3, {
				yieldControl: immediateYield,
			}),
		).toEqual([]);
	});
});

describe('computeWaveformPeaksProgressive', () => {
	it('produces correctly normalized peaks across chunks', async () => {
		const channel = new Float32Array([
			0.1, 0.1, 0.5, 0.5, 0.9, 0.2, 0.3, 0.0,
		]);
		const peaks = await computeWaveformPeaksProgressive([channel], 4, {
			chunkBuckets: 1,
			yieldControl: immediateYield,
		});
		// Buckets hold the max abs amplitude (0.1, 0.5, 0.9, 0.3), normalized
		// so the loudest (0.9) maps to 1
		expect(peaks).toHaveLength(4);
		expect(peaks[0]).toBeCloseTo(0.1 / 0.9);
		expect(peaks[1]).toBeCloseTo(0.5 / 0.9);
		expect(peaks[2]).toBeCloseTo(1);
		expect(peaks[3]).toBeCloseTo(0.3 / 0.9);
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

describe('WaveformPeakCache - eviction and overwrite', () => {
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

describe('SharedAudioDecoder', () => {
	/** A fake OfflineAudioContext recording how it was constructed and used. */
	class FakeOfflineAudioContext {
		static count = 0;
		static last: FakeOfflineAudioContext | null = null;
		readonly decodeAudioData = jest.fn(
			(): Promise<AudioBuffer> =>
				Promise.resolve({ duration: 1 } as AudioBuffer),
		);
		constructor(
			readonly numberOfChannels: number,
			readonly length: number,
			readonly sampleRate: number,
		) {
			FakeOfflineAudioContext.count += 1;
			FakeOfflineAudioContext.last = this;
		}
	}

	type OfflineCtor = typeof OfflineAudioContext;
	let original: OfflineCtor | undefined;

	beforeEach(() => {
		FakeOfflineAudioContext.count = 0;
		FakeOfflineAudioContext.last = null;
		original = (globalThis as { OfflineAudioContext?: OfflineCtor })
			.OfflineAudioContext;
		(
			globalThis as { OfflineAudioContext?: OfflineCtor }
		).OfflineAudioContext =
			FakeOfflineAudioContext as unknown as OfflineCtor;
	});

	afterEach(() => {
		(
			globalThis as { OfflineAudioContext?: OfflineCtor | undefined }
		).OfflineAudioContext = original;
	});

	it('decodes through a low-sample-rate OfflineAudioContext', async () => {
		const decoder = new SharedAudioDecoder();
		const data = new ArrayBuffer(8);

		await decoder.decode(data);

		// A long recording must not be decoded at its full native rate; the
		// waveform only needs a low-rate amplitude envelope
		expect(FakeOfflineAudioContext.count).toBe(1);
		expect(FakeOfflineAudioContext.last?.sampleRate).toBe(
			WAVEFORM_DECODE_SAMPLE_RATE,
		);
		expect(
			FakeOfflineAudioContext.last?.decodeAudioData,
		).toHaveBeenCalledWith(data);
	});

	it('reuses one decoding context across files', async () => {
		const decoder = new SharedAudioDecoder();

		await decoder.decode(new ArrayBuffer(4));
		await decoder.decode(new ArrayBuffer(4));

		// One shared context, so embeds of several recordings never spawn a
		// context each
		expect(FakeOfflineAudioContext.count).toBe(1);
	});

	it('drops the context on close so a later decode recreates it', async () => {
		const decoder = new SharedAudioDecoder();
		await decoder.decode(new ArrayBuffer(4));
		expect(FakeOfflineAudioContext.count).toBe(1);

		await decoder.close();
		await decoder.decode(new ArrayBuffer(4));

		expect(FakeOfflineAudioContext.count).toBe(2);
	});

	it('close is safe when no context was ever created', async () => {
		const decoder = new SharedAudioDecoder();
		await expect(decoder.close()).resolves.toBeUndefined();
	});
});
