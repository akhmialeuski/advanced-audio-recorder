/**
 * Waveform peak extraction and caching for the enhanced audio player.
 * Peaks are derived once per file revision and reused across re-renders
 * so scrolling a note with many players does not redecode the audio.
 * @module player/WaveformData
 */

/**
 * Computes normalized amplitude peaks for a waveform display. Every
 * output bucket holds the maximum absolute sample amplitude (0..1)
 * across the corresponding slice of the audio, with the channels mixed
 * down to mono by averaging. The result is normalized so the loudest
 * bucket reaches 1, which keeps quiet recordings visible.
 * @param channels - Decoded per-channel sample data
 * @param bucketCount - Number of peaks to produce (waveform bar count)
 * @returns Array of bucketCount normalized peaks in the range 0..1
 */
export function computeWaveformPeaks(
	channels: Float32Array[],
	bucketCount: number,
): number[] {
	if (bucketCount <= 0 || channels.length === 0) {
		return [];
	}
	const frameCount = channels[0].length;
	if (frameCount === 0) {
		return new Array<number>(bucketCount).fill(0);
	}

	const peaks = new Array<number>(bucketCount).fill(0);
	const framesPerBucket = frameCount / bucketCount;
	const channelCount = channels.length;

	for (let bucket = 0; bucket < bucketCount; bucket++) {
		const start = Math.floor(bucket * framesPerBucket);
		// The final bucket always extends to the last frame so trailing
		// samples are never dropped by rounding
		const end =
			bucket === bucketCount - 1
				? frameCount
				: Math.floor((bucket + 1) * framesPerBucket);
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
		peaks[bucket] = maxAmplitude;
	}

	let loudest = 0;
	for (const peak of peaks) {
		if (peak > loudest) {
			loudest = peak;
		}
	}
	if (loudest > 0) {
		for (let bucket = 0; bucket < bucketCount; bucket++) {
			peaks[bucket] /= loudest;
		}
	}
	return peaks;
}

/**
 * Builds a cache key that changes whenever the file content changes, so
 * peaks computed for an earlier revision are never reused after the
 * file is edited or replaced.
 * @param path - Vault-relative file path
 * @param mtime - File modification time in milliseconds
 * @param size - File size in bytes
 * @param bucketCount - Bucket count the peaks were computed for
 * @returns Stable cache key
 */
export function waveformCacheKey(
	path: string,
	mtime: number,
	size: number,
	bucketCount: number,
): string {
	return `${path}:${String(mtime)}:${String(size)}:${String(bucketCount)}`;
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
	constructor(private readonly maxEntries: number = 64) {}

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
 * Decodes audio through a single, lazily created AudioContext shared by
 * every player. Browsers cap the number of concurrent AudioContexts (six
 * in Chromium), so creating one per file would throw as soon as a note
 * embeds several recordings; reusing one context avoids the cap and the
 * per-file create/close overhead. The context is closed when the player
 * feature is disposed.
 */
export class SharedAudioDecoder implements AudioDecoder {
	private context: AudioContext | null = null;

	/**
	 * Decodes encoded audio bytes, creating the shared context on first
	 * use. Decoding does not require a running context, so an autoplay
	 * suspension does not affect it.
	 * @param data - Encoded audio file bytes
	 */
	decode(data: ArrayBuffer): Promise<AudioBuffer> {
		if (!this.context) {
			this.context = new AudioContext();
		}
		return this.context.decodeAudioData(data);
	}

	/**
	 * Closes the shared context, releasing its audio thread.
	 */
	async close(): Promise<void> {
		if (!this.context) {
			return;
		}
		const context = this.context;
		this.context = null;
		await context.close();
	}
}
