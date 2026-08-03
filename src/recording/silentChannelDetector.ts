/**
 * Post-recording detection of a lopsided stereo file: a two-channel
 * recording where one channel carries audio and the other is silent -
 * the signature of a single microphone captured through an audio
 * interface that the OS exposes as one stereo device. The pure
 * analysis (per-channel peak-window RMS and the loud/quiet decision) lives
 * here so it is unit tested without Web Audio; the decode wrapper first uses
 * known/container metadata to avoid unnecessary full decodes.
 * @module recording/silentChannelDetector
 */

import type { App, TFile } from 'obsidian';
import {
	PLUGIN_LOG_PREFIX,
	SILENT_CHANNEL_FLOOR_DB,
	SILENT_CHANNEL_MIN_GAP_DB,
	SILENT_CHANNEL_MIN_AUDIO_DB,
	SILENT_CHANNEL_ANALYSIS_WINDOW_SECONDS,
	SILENT_CHANNEL_MAX_DECODE_SECONDS,
} from '../constants';
import {
	isKnownLongerThan,
	probeAudioMetadata,
} from '../utils/AudioFileAnalyzer';
import {
	CHANNEL_MODE_MONO_LEFT,
	CHANNEL_MODE_MONO_RIGHT,
	type ChannelMode,
} from '../audio/downmix';

/**
 * Outcome of the lopsided-stereo analysis: which channel is silent (so
 * the caller keeps the other), or null when the file is balanced, mono,
 * or both channels are effectively silent.
 */
export interface SilentChannelResult {
	/** Zero-based index of the silent channel (0 = left, 1 = right). */
	silentChannel: 0 | 1;
	/** Zero-based index of the channel that carries audio. */
	audioChannel: 0 | 1;
	/** Channel mode that keeps only the audio channel. */
	keepMode: ChannelMode;
}

/** Tunable thresholds for the pure channel-balance analysis. */
export interface ChannelBalanceOptions {
	floorDb?: number;
	minGapDb?: number;
	minAudioDb?: number;
	windowFrames?: number;
}

/** Early-bound recording metadata used to avoid opening large files. */
export interface SilentChannelDetectionOptions {
	knownDurationSeconds?: number | undefined;
	maxDecodeSeconds?: number;
}

/** Converts an RMS amplitude (0..1) to dBFS, with a floor for silence. */
function rmsToDb(rms: number): number {
	return rms > 0 ? 20 * Math.log10(rms) : -Infinity;
}

/**
 * Highest RMS among fixed-size windows. A real but brief sound therefore
 * remains visible instead of being diluted by the duration of the whole
 * recording. The final partial window is included.
 */
function peakWindowRmsDb(samples: Float32Array, windowFrames: number): number {
	if (samples.length === 0) {
		return -Infinity;
	}
	const size = Math.max(1, Math.floor(windowFrames));
	let peakRms = 0;
	for (let start = 0; start < samples.length; start += size) {
		const end = Math.min(samples.length, start + size);
		let sumSquares = 0;
		for (let i = start; i < end; i++) {
			const sample = samples[i] ?? 0;
			sumSquares += sample * sample;
		}
		peakRms = Math.max(peakRms, Math.sqrt(sumSquares / (end - start)));
	}
	return rmsToDb(peakRms);
}

/**
 * Analyzes decoded stereo channels for the lopsided pattern. Returns a
 * result only when exactly one of two channels never rises above the silence
 * floor while the other reaches a useful level with at least the minimum
 * gap. Peak windows preserve a short real event instead of diluting it over
 * the entire file.
 * @param channels - Per-channel decoded samples
 * @param options - Window size and level thresholds
 * @returns The lopsided result, or null when it does not apply
 */
export function analyzeChannelBalance(
	channels: Float32Array[],
	options: ChannelBalanceOptions = {},
): SilentChannelResult | null {
	if (channels.length !== 2) {
		return null;
	}
	const left = channels[0];
	const right = channels[1];
	if (!left || !right) {
		return null;
	}
	const floorDb = options.floorDb ?? SILENT_CHANNEL_FLOOR_DB;
	const minGapDb = options.minGapDb ?? SILENT_CHANNEL_MIN_GAP_DB;
	const minAudioDb = options.minAudioDb ?? SILENT_CHANNEL_MIN_AUDIO_DB;
	const windowFrames = options.windowFrames ?? Math.max(left.length, 1);
	const leftDb = peakWindowRmsDb(left, windowFrames);
	const rightDb = peakWindowRmsDb(right, windowFrames);

	const leftSilent = leftDb <= floorDb;
	const rightSilent = rightDb <= floorDb;
	// Exactly one side silent, and the other clearly present
	if (leftSilent === rightSilent) {
		return null;
	}
	if (rightSilent && leftDb >= minAudioDb && leftDb - rightDb >= minGapDb) {
		return {
			silentChannel: 1,
			audioChannel: 0,
			keepMode: CHANNEL_MODE_MONO_LEFT,
		};
	}
	if (leftSilent && rightDb >= minAudioDb && rightDb - leftDb >= minGapDb) {
		return {
			silentChannel: 0,
			audioChannel: 1,
			keepMode: CHANNEL_MODE_MONO_RIGHT,
		};
	}
	return null;
}

/**
 * Decodes an audio file and reports whether it is a lopsided stereo
 * recording. Skips files that are not decodable, not stereo, or longer
 * than the decode cap (a full decode is the only way to read per-channel
 * levels, so long sessions are not paid for on every save). Never
 * throws: any failure resolves to null so the post-save flow continues.
 * @param app - Obsidian app handle
 * @param file - Saved audio file to inspect
 * @param options - Known duration and decode cap
 * @returns The lopsided result, or null
 */
export async function detectSilentChannel(
	app: App,
	file: TFile,
	options: SilentChannelDetectionOptions = {},
): Promise<SilentChannelResult | null> {
	let audioContext: AudioContext | null = null;
	try {
		const maxDecodeSeconds =
			options.maxDecodeSeconds ?? SILENT_CHANNEL_MAX_DECODE_SECONDS;
		if (
			Number.isFinite(options.knownDurationSeconds) &&
			(options.knownDurationSeconds ?? 0) > maxDecodeSeconds
		) {
			return null;
		}
		const data = await app.vault.readBinary(file);
		const metadata = await probeAudioMetadata(data, file.path);
		if (
			metadata &&
			(metadata.channels !== 2 ||
				isKnownLongerThan(metadata.durationSeconds, maxDecodeSeconds))
		) {
			return null;
		}
		audioContext = new AudioContext();
		const buffer = await audioContext.decodeAudioData(data);
		if (
			buffer.numberOfChannels !== 2 ||
			buffer.duration > maxDecodeSeconds
		) {
			return null;
		}
		return analyzeChannelBalance(
			[buffer.getChannelData(0), buffer.getChannelData(1)],
			{
				windowFrames: Math.max(
					1,
					Math.round(
						buffer.sampleRate *
							SILENT_CHANNEL_ANALYSIS_WINDOW_SECONDS,
					),
				),
			},
		);
	} catch (error) {
		console.warn(
			`${PLUGIN_LOG_PREFIX} Silent-channel check skipped:`,
			error,
		);
		return null;
	} finally {
		if (audioContext) {
			void audioContext.close().catch(() => {
				// Closing a context that already failed is non-fatal
			});
		}
	}
}
