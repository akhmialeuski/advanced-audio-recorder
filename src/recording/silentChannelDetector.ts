/**
 * Post-recording detection of a lopsided stereo file: a two-channel
 * recording where one channel carries audio and the other is silent -
 * the signature of a single microphone captured through an audio
 * interface that the OS exposes as one stereo device. The pure
 * analysis (per-channel RMS, the loud/quiet decision) lives here so it
 * is unit tested without Web Audio; the decode wrapper is a thin
 * adapter around it.
 * @module recording/silentChannelDetector
 */

import type { App, TFile } from 'obsidian';
import {
	PLUGIN_LOG_PREFIX,
	SILENT_CHANNEL_FLOOR_DB,
	SILENT_CHANNEL_MIN_GAP_DB,
	SILENT_CHANNEL_MAX_DECODE_SECONDS,
} from '../constants';
import { computeRms } from './InputLevelMonitor';
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

/** Converts an RMS amplitude (0..1) to dBFS, with a floor for silence. */
function rmsToDb(rms: number): number {
	return rms > 0 ? 20 * Math.log10(rms) : -Infinity;
}

/**
 * Analyzes decoded stereo channels for the lopsided pattern. Returns a
 * result only when exactly one of two channels is at or below the
 * silence floor while the other sits clearly above it by at least the
 * minimum gap - so a centered or merely off-balance stereo mix, where
 * both channels carry audio, never qualifies.
 * @param channels - Per-channel decoded samples
 * @param floorDb - Silence floor in dBFS
 * @param minGapDb - Minimum loud-to-quiet gap in dB
 * @returns The lopsided result, or null when it does not apply
 */
export function analyzeChannelBalance(
	channels: Float32Array[],
	floorDb: number = SILENT_CHANNEL_FLOOR_DB,
	minGapDb: number = SILENT_CHANNEL_MIN_GAP_DB,
): SilentChannelResult | null {
	if (channels.length !== 2) {
		return null;
	}
	const left = channels[0];
	const right = channels[1];
	if (!left || !right) {
		return null;
	}
	const leftDb = rmsToDb(computeRms(left));
	const rightDb = rmsToDb(computeRms(right));

	const leftSilent = leftDb <= floorDb;
	const rightSilent = rightDb <= floorDb;
	// Exactly one side silent, and the other clearly present
	if (leftSilent === rightSilent) {
		return null;
	}
	if (rightSilent && leftDb - rightDb >= minGapDb) {
		return {
			silentChannel: 1,
			audioChannel: 0,
			keepMode: CHANNEL_MODE_MONO_LEFT,
		};
	}
	if (leftSilent && rightDb - leftDb >= minGapDb) {
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
 * @param maxDecodeSeconds - Duration cap; longer files are skipped
 * @returns The lopsided result, or null
 */
export async function detectSilentChannel(
	app: App,
	file: TFile,
	maxDecodeSeconds: number = SILENT_CHANNEL_MAX_DECODE_SECONDS,
): Promise<SilentChannelResult | null> {
	let audioContext: AudioContext | null = null;
	try {
		const data = await app.vault.readBinary(file);
		audioContext = new AudioContext();
		const buffer = await audioContext.decodeAudioData(data);
		if (
			buffer.numberOfChannels !== 2 ||
			buffer.duration > maxDecodeSeconds
		) {
			return null;
		}
		return analyzeChannelBalance([
			buffer.getChannelData(0),
			buffer.getChannelData(1),
		]);
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
