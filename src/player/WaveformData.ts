/**
 * Waveform peak extraction and caching for the enhanced audio player.
 * Peaks are derived once per file revision and reused across re-renders
 * so scrolling a note with many players does not redecode the audio.
 * @module player/WaveformData
 */

import {
	WAVEFORM_CACHE_MAX_ENTRIES,
	WAVEFORM_DECODE_SAMPLE_RATE,
	WAVEFORM_PROGRESSIVE_CHUNK_BUCKETS,
} from '../constants';

/**
 * Options controlling progressive peak extraction.
 */
export interface ProgressivePeaksOptions {
	/**
	 * Invoked with a normalized snapshot of the peaks computed so far after
	 * each chunk, so the waveform can be drawn incrementally as it fills in.
	 */
	onProgress?: (peaks: number[]) => void;
	/** High-resolution buckets computed per chunk before yielding. */
	chunkBuckets?: number;
	/**
	 * Yields control to the event loop between chunks. Defaults to a
	 * macrotask; tests inject an immediate resolver for determinism.
	 */
	yieldControl?: () => Promise<void>;
	/**
	 * Returns true to abort the computation early (e.g. the player unloaded).
	 * The partially computed result is then discarded by the caller.
	 */
	shouldAbort?: () => boolean;
}

/**
 * Computes normalized amplitude peaks for a waveform display, in chunks that
 * yield to the event loop between them, so extracting peaks from a large file
 * never blocks the main thread in one long synchronous pass. Every output
 * bucket holds the maximum absolute mono-mixed sample amplitude across its
 * slice; the result is normalized so the loudest bucket reaches 1. Snapshots
 * are reported through onProgress (normalized against the running maximum) so
 * the waveform can be drawn as it fills in, and the final array is normalized
 * against the true global maximum.
 * @param channels - Decoded per-channel sample data
 * @param bucketCount - Number of peaks to produce (waveform bar count)
 * @param options - Progress, chunking, yielding, and abort hooks
 * @returns Array of bucketCount normalized peaks in the range 0..1
 */
export async function computeWaveformPeaksProgressive(
	channels: Float32Array[],
	bucketCount: number,
	options: ProgressivePeaksOptions = {},
): Promise<number[]> {
	const chunkBuckets =
		options.chunkBuckets ?? WAVEFORM_PROGRESSIVE_CHUNK_BUCKETS;
	const yieldControl = options.yieldControl ?? defaultYield;

	if (bucketCount <= 0 || channels.length === 0) {
		return [];
	}
	const frameCount = channels[0].length;
	if (frameCount === 0) {
		return new Array<number>(bucketCount).fill(0);
	}

	const raw = new Array<number>(bucketCount).fill(0);
	const framesPerBucket = frameCount / bucketCount;
	const channelCount = channels.length;
	let runningMax = 0;

	for (
		let chunkStart = 0;
		chunkStart < bucketCount;
		chunkStart += chunkBuckets
	) {
		if (options.shouldAbort?.()) {
			return raw;
		}
		const chunkEnd = Math.min(bucketCount, chunkStart + chunkBuckets);
		for (let bucket = chunkStart; bucket < chunkEnd; bucket++) {
			const [start, end] = bucketBounds(
				bucket,
				bucketCount,
				framesPerBucket,
				frameCount,
			);
			const peak = bucketPeak(channels, channelCount, start, end);
			raw[bucket] = peak;
			if (peak > runningMax) {
				runningMax = peak;
			}
		}
		options.onProgress?.(normalizePeaks(raw.slice(), runningMax));
		if (chunkEnd < bucketCount) {
			await yieldControl();
		}
	}
	return normalizePeaks(raw, runningMax);
}

/**
 * Resolves the [start, end) frame bounds of a bucket. The final bucket always
 * extends to the last frame so trailing samples are never dropped by rounding.
 */
function bucketBounds(
	bucket: number,
	bucketCount: number,
	framesPerBucket: number,
	frameCount: number,
): [number, number] {
	const start = Math.floor(bucket * framesPerBucket);
	const end =
		bucket === bucketCount - 1
			? frameCount
			: Math.floor((bucket + 1) * framesPerBucket);
	return [start, end];
}

/**
 * Returns the maximum absolute mono-mixed amplitude across a frame range.
 */
function bucketPeak(
	channels: Float32Array[],
	channelCount: number,
	start: number,
	end: number,
): number {
	let maxAmplitude = 0;
	for (let frame = start; frame < end; frame++) {
		let mixed = 0;
		for (let channel = 0; channel < channelCount; channel++) {
			mixed += channels[channel][frame];
		}
		const amplitude = Math.abs(mixed / channelCount);
		if (amplitude > maxAmplitude) {
			maxAmplitude = amplitude;
		}
	}
	return maxAmplitude;
}

/**
 * Normalizes peaks in place so the given maximum maps to 1, keeping quiet
 * recordings visible. A non-positive maximum leaves the peaks untouched.
 */
function normalizePeaks(peaks: number[], max: number): number[] {
	if (max > 0) {
		for (let i = 0; i < peaks.length; i++) {
			peaks[i] /= max;
		}
	}
	return peaks;
}

/**
 * Default inter-chunk yield: a macrotask, which lets the browser paint and
 * handle input between chunks.
 */
function defaultYield(): Promise<void> {
	return new Promise<void>((resolve) => {
		window.setTimeout(resolve, 0);
	});
}

/**
 * Builds a cache key that changes whenever the file content changes, so
 * peaks computed for an earlier revision are never reused after the
 * file is edited or replaced. The key intentionally does not depend on the
 * rendered width: peaks are cached at a fixed resolution and downsampled
 * for display, so resizing never invalidates the cache.
 * @param path - Vault-relative file path
 * @param mtime - File modification time in milliseconds
 * @param size - File size in bytes
 * @returns Stable cache key
 */
export function waveformCacheKey(
	path: string,
	mtime: number,
	size: number,
): string {
	return `${path}:${String(mtime)}:${String(size)}`;
}

/**
 * Downsamples a high-resolution peak array to a smaller bar count by taking
 * the max of each group, so the cached peaks can be drawn at any width
 * without re-decoding. Returns the input unchanged when it already has at
 * most `target` peaks.
 * @param peaks - Source peaks (0..1)
 * @param target - Desired number of bars
 * @returns Downsampled peaks of length min(target, peaks.length)
 */
export function downsamplePeaks(peaks: number[], target: number): number[] {
	if (target <= 0) {
		return [];
	}
	if (peaks.length <= target) {
		return peaks;
	}
	const result = new Array<number>(target).fill(0);
	const perBucket = peaks.length / target;
	for (let i = 0; i < target; i++) {
		const start = Math.floor(i * perBucket);
		const end =
			i === target - 1 ? peaks.length : Math.floor((i + 1) * perBucket);
		let max = 0;
		for (let j = start; j < end; j++) {
			if (peaks[j] > max) {
				max = peaks[j];
			}
		}
		result[i] = max;
	}
	return result;
}

/**
 * Bounded LRU cache of computed waveform peaks. The bound keeps memory
 * use predictable in vaults with many distinct audio files; the least
 * recently used entry is evicted once the limit is reached.
 */
export class WaveformPeakCache {
	private readonly entries = new Map<string, number[]>();

	/**
	 * @param maxEntries - Maximum number of distinct waveforms to retain
	 */
	constructor(
		private readonly maxEntries: number = WAVEFORM_CACHE_MAX_ENTRIES,
	) {}

	/**
	 * Returns cached peaks for a key, refreshing its recency, or
	 * undefined when the key is absent.
	 * @param key - Cache key from waveformCacheKey
	 */
	get(key: string): number[] | undefined {
		const cached = this.entries.get(key);
		if (cached === undefined) {
			return undefined;
		}
		// Re-insert to mark as most recently used
		this.entries.delete(key);
		this.entries.set(key, cached);
		return cached;
	}

	/**
	 * Stores peaks for a key, evicting the least recently used entry when
	 * the cache is full.
	 * @param key - Cache key from waveformCacheKey
	 * @param peaks - Computed peaks to retain
	 */
	set(key: string, peaks: number[]): void {
		if (this.entries.has(key)) {
			this.entries.delete(key);
		} else if (this.entries.size >= this.maxEntries) {
			const oldest = this.entries.keys().next().value;
			if (oldest !== undefined) {
				this.entries.delete(oldest);
			}
		}
		this.entries.set(key, peaks);
	}

	/**
	 * Removes every cached waveform. Used when the player feature is torn
	 * down so retained peaks do not outlive the plugin.
	 */
	clear(): void {
		this.entries.clear();
	}
}

/**
 * Decodes encoded audio bytes into an AudioBuffer for waveform
 * extraction.
 */
export interface AudioDecoder {
	/**
	 * Decodes encoded audio file contents into samples.
	 * @param data - Encoded audio file bytes
	 */
	decode(data: ArrayBuffer): Promise<AudioBuffer>;
}

/**
 * Decodes audio through a single, lazily created OfflineAudioContext shared
 * by every player. The context's low sample rate (WAVEFORM_DECODE_SAMPLE_RATE)
 * makes decodeAudioData resample while decoding, so a long recording yields a
 * small decoded buffer instead of the full native-rate PCM (hundreds of MB for
 * an hour of stereo) - the waveform needs only an amplitude envelope. One
 * shared context also avoids the per-file create overhead and the realtime
 * AudioContext count cap. The reference is dropped when the player feature is
 * disposed; an OfflineAudioContext holds no realtime audio thread to close.
 */
export class SharedAudioDecoder implements AudioDecoder {
	private context: OfflineAudioContext | null = null;

	/**
	 * Decodes encoded audio bytes, creating the shared low-rate context on
	 * first use. decodeAudioData resamples the result to the context's sample
	 * rate, so the decoded PCM stays small regardless of the file's native
	 * rate. Correctness does not depend on the resample: peak extraction is
	 * rate-agnostic, so a platform that ignored the target rate would still
	 * produce the right waveform, just less cheaply.
	 * @param data - Encoded audio file bytes
	 */
	decode(data: ArrayBuffer): Promise<AudioBuffer> {
		if (!this.context) {
			// The length (1) is irrelevant to decoding, which uses only the
			// context's sample rate to resample the decoded result
			this.context = new OfflineAudioContext(
				1,
				1,
				WAVEFORM_DECODE_SAMPLE_RATE,
			);
		}
		return this.context.decodeAudioData(data);
	}

	/**
	 * Drops the shared context. An OfflineAudioContext owns no realtime audio
	 * thread, so there is nothing to close; releasing the reference lets a
	 * fresh one be created if decoding resumes later.
	 */
	close(): Promise<void> {
		this.context = null;
		return Promise.resolve();
	}
}
