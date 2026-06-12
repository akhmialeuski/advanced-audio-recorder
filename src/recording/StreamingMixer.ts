/**
 * Bounded-memory mixer for multi-track PCM/WAV sessions. The tracks
 * already sit on disk as raw int16 segments, so they are mixed in
 * fixed-size windows directly into the preallocated WAV file buffer —
 * peak memory is the output file plus one window per track, instead
 * of decoding every track into float32 AudioBuffers and rendering
 * them through an OfflineAudioContext (which costs multiple gigabytes
 * for hour-long multi-track sessions).
 *
 * Scope: equal sample rates only (the PCM recorders are created with
 * an explicit shared rate, so this is the normal case). Rate
 * mismatches and compressed merged outputs keep using the Web Audio
 * path — OfflineAudioContext is the platform's resampler, and
 * reimplementing resampling here would be reinventing it badly.
 * @module recording/StreamingMixer
 */

import type { App } from 'obsidian';
import { createWavHeader, WAV_HEADER_SIZE } from './WavEncoder';

/** Bytes per int16 sample. */
const BYTES_PER_SAMPLE = 2;

/** Default mix window in sample frames (~1 MiB stereo int16). */
const DEFAULT_WINDOW_FRAMES = 262144;

/**
 * One PCM track to mix.
 */
export interface PcmMixTrack {
	/** Flushed segment files in capture order. */
	segmentPaths: string[];
	/** Interleaved channel count (1 or 2). */
	channels: number;
	/** Sample rate in Hz. */
	sampleRate: number;
}

/**
 * Checks whether the tracks can be mixed by this streaming mixer.
 * @param tracks - Candidate tracks
 * @returns True when all tracks share a sample rate and have data
 */
export function canStreamMix(tracks: PcmMixTrack[]): boolean {
	if (tracks.length === 0) {
		return false;
	}
	const rate = tracks[0].sampleRate;
	return tracks.every(
		(track) =>
			track.segmentPaths.length > 0 &&
			track.sampleRate === rate &&
			track.channels >= 1 &&
			track.channels <= 2,
	);
}

/**
 * Sequential reader over the int16 segments of one track. Reads one
 * segment at a time and serves fixed-size frame windows across
 * segment boundaries.
 */
class PcmSegmentReader {
	private segmentIndex = 0;
	private current: Int16Array | null = null;
	private currentOffset = 0;

	/**
	 * Creates a new PcmSegmentReader.
	 * @param segmentPaths - Segment files in capture order
	 * @param channels - Interleaved channel count
	 * @param app - Obsidian App instance
	 */
	constructor(
		private readonly segmentPaths: string[],
		private readonly channels: number,
		private readonly app: App,
	) {}

	/**
	 * Reads the next window of sample frames into the given buffer,
	 * zero-filling whatever the track can no longer provide.
	 * @param frames - Frames to read
	 * @param window - Reusable buffer of at least frames*channels
	 * @returns Number of samples (not frames) actually read
	 */
	async read(frames: number, window: Int16Array): Promise<number> {
		const samplesWanted = frames * this.channels;
		let written = 0;
		while (written < samplesWanted) {
			if (!this.current || this.currentOffset >= this.current.length) {
				if (this.segmentIndex >= this.segmentPaths.length) {
					break;
				}
				const bytes = await this.app.vault.adapter.readBinary(
					this.segmentPaths[this.segmentIndex],
				);
				this.segmentIndex += 1;
				// Whole int16 samples only; a torn trailing byte is dropped
				this.current = new Int16Array(
					bytes,
					0,
					Math.floor(bytes.byteLength / BYTES_PER_SAMPLE),
				);
				this.currentOffset = 0;
			}
			const available = this.current.length - this.currentOffset;
			const take = Math.min(available, samplesWanted - written);
			window.set(
				this.current.subarray(
					this.currentOffset,
					this.currentOffset + take,
				),
				written,
			);
			this.currentOffset += take;
			written += take;
		}
		window.fill(0, written, samplesWanted);
		return written;
	}
}

/**
 * Mixes the given PCM tracks into one complete WAV file buffer.
 * Output is mono when every input is mono, stereo otherwise (mono
 * inputs are duplicated into both channels); the length is the
 * longest track, with shorter tracks padded by silence; sample sums
 * are clamped to the int16 range.
 * @param tracks - Tracks to mix (validate with canStreamMix first)
 * @param app - Obsidian App instance
 * @param onProgress - Optional progress callback (0-100)
 * @param windowFrames - Mix window size in frames (test hook)
 * @returns Complete WAV file bytes
 * @throws Error when the adapter cannot report segment sizes (the
 * caller falls back to the Web Audio mixing path)
 */
export async function mixPcmTracksToWav(
	tracks: PcmMixTrack[],
	app: App,
	onProgress?: (percent: number) => void,
	windowFrames: number = DEFAULT_WINDOW_FRAMES,
): Promise<ArrayBuffer> {
	const adapter = app.vault.adapter;
	if (typeof adapter.stat !== 'function') {
		throw new Error(
			'Vault adapter cannot report file sizes for streaming mix',
		);
	}

	// Frame counts per track from the segment sizes on disk
	const frameCounts: number[] = [];
	for (const track of tracks) {
		let bytes = 0;
		for (const path of track.segmentPaths) {
			const stat = await adapter.stat(path);
			if (!stat) {
				throw new Error('PCM segment is missing for the streaming mix');
			}
			bytes += stat.size;
		}
		frameCounts.push(
			Math.floor(bytes / (BYTES_PER_SAMPLE * track.channels)),
		);
	}
	const totalFrames = Math.max(...frameCounts);
	const outChannels = Math.min(
		2,
		Math.max(...tracks.map((track) => track.channels)),
	);
	const sampleRate = tracks[0].sampleRate;

	const wavBuffer = new ArrayBuffer(
		WAV_HEADER_SIZE + totalFrames * outChannels * BYTES_PER_SAMPLE,
	);
	const output = new Int16Array(wavBuffer, WAV_HEADER_SIZE);
	new Uint8Array(wavBuffer).set(
		new Uint8Array(
			createWavHeader(
				outChannels,
				sampleRate,
				totalFrames * outChannels * BYTES_PER_SAMPLE,
			),
		),
		0,
	);

	const readers = tracks.map(
		(track) =>
			new PcmSegmentReader(track.segmentPaths, track.channels, app),
	);
	const windows = tracks.map(
		(track) => new Int16Array(windowFrames * track.channels),
	);
	const accumulator = new Int32Array(windowFrames * outChannels);

	let frameOffset = 0;
	while (frameOffset < totalFrames) {
		const frames = Math.min(windowFrames, totalFrames - frameOffset);
		accumulator.fill(0, 0, frames * outChannels);

		for (let trackIndex = 0; trackIndex < tracks.length; trackIndex++) {
			const channels = tracks[trackIndex].channels;
			const window = windows[trackIndex];
			await readers[trackIndex].read(frames, window);

			if (channels === outChannels) {
				for (let i = 0; i < frames * outChannels; i++) {
					accumulator[i] += window[i];
				}
			} else {
				// Mono into stereo: duplicate the sample into both
				// channels, matching the Web Audio up-mix behavior
				for (let frame = 0; frame < frames; frame++) {
					const sample = window[frame];
					accumulator[frame * 2] += sample;
					accumulator[frame * 2 + 1] += sample;
				}
			}
		}

		const outBase = frameOffset * outChannels;
		for (let i = 0; i < frames * outChannels; i++) {
			const sum = accumulator[i];
			output[outBase + i] =
				sum > 32767 ? 32767 : sum < -32768 ? -32768 : sum;
		}

		frameOffset += frames;
		onProgress?.(Math.round((frameOffset / totalFrames) * 100));
	}

	return wavBuffer;
}
