/**
 * What a merged multi-track file is made of: where each track sits in it and
 * which format it is written in, and the bounded-memory route a PCM session
 * takes to it. A session stopped normally and a session recovered after a
 * crash both merge through these, so the two produce the same file.
 * @module recording/mergeOutput
 */

import type { App } from 'obsidian';
import { FORMAT_WAV, PLUGIN_LOG_PREFIX } from '../constants';
import { INT16_MAX } from '../audio/pcm';
import { isOfflineEncodingSupported } from '../audio/AudioEncoder';
import type { MergePlacement } from '../audio/AudioFormatConverter';
import { WavSizeLimitError } from '../audio/WavEncoder';
import type { TrackMix } from '../types';
import { gainFactor, normalizeFactor, panGains } from './mixMath';
import { canStreamMix, mixPcmTracksToWav } from './StreamingMixer';
import type { MixOptions, PcmMixTrack } from './StreamingMixer';

/**
 * Where a session's tracks sit in a merged file, in the terms the Web Audio
 * merge takes them.
 *
 * Derived from the rules the streaming mixer applies rather than written
 * again, so a session is placed the same by either route: the level in
 * decibels through {@link gainFactor}, the position through the balance law
 * of {@link panGains}, and the alignment through {@link normalizeFactor}.
 * Only the unit differs, because the mixer reads a level on the scale the
 * captured representation works in while a decoded buffer is always a share
 * of full scale, which is why the level is put on the sixteen-bit scale
 * {@link normalizeFactor} answers on by default.
 *
 * The placement is the same; the final level is not, once levels are
 * aligned. This route renders the mix and measures the peak it actually
 * reached, while the streaming one cannot: its measuring pass runs before
 * the alignment figures exist, so it bounds the sum by the tracks' separate
 * peaks and comes out quieter by however far apart they peak. Closing that
 * would cost the streaming route a third full read of the session, which is
 * the memory-bounded route's whole reason for existing.
 * @param trackMix - Level and position of each track, in track order
 * @param alignTrackLevels - Whether the tracks are brought to one level first
 * @returns The placement for the merge
 */
export function mergePlacement(
	trackMix: readonly TrackMix[],
	alignTrackLevels: boolean,
): MergePlacement {
	return {
		levels: trackMix.map((mix) => {
			const level = gainFactor(mix.gainDb);
			const pan = panGains(mix.pan);
			return {
				left: level * pan.left,
				right: level * pan.right,
			};
		}),
		...(alignTrackLevels
			? {
					normalize: (rms: number): number =>
						normalizeFactor(rms * INT16_MAX),
				}
			: {}),
	};
}

/**
 * The format a merged file is written in: the session's output format where
 * this platform can encode it offline, WAV otherwise. Resolved once and passed
 * to the encoder, so the file extension and the encoded content never diverge.
 * @param outputFormat - Output format of the session
 * @returns The format to encode the merged file in
 */
export function mergedFileFormat(outputFormat: string): string {
	return isOfflineEncodingSupported(outputFormat) ? outputFormat : FORMAT_WAV;
}

/**
 * Mixes PCM tracks into a WAV from their segment files in bounded memory,
 * where the streaming mixer takes them.
 *
 * Every reason the streaming mix gives up but one is a property of the
 * route - a rate mismatch, an adapter without stat - and the Web Audio mix
 * takes another route to the same file, so those answer null. The container
 * ceiling is a property of the audio: that mix encodes through mediabunny,
 * which is outside the check entirely, so it would spend the decode only to
 * write a file whose stated sizes have wrapped. That refusal is rethrown.
 * @param tracks - The tracks with their segments, in placement order
 * @param app - Obsidian App instance
 * @param options - Progress, sample format, and whether to align levels
 * @returns The WAV bytes, or null when the caller has to mix another way
 * @throws WavSizeLimitError when the mix would pass the container ceiling
 */
export async function streamMixToWav(
	tracks: PcmMixTrack[],
	app: App,
	options: MixOptions,
): Promise<ArrayBuffer | null> {
	if (!canStreamMix(tracks)) {
		return null;
	}
	try {
		return await mixPcmTracksToWav(tracks, app, options);
	} catch (error) {
		if (error instanceof WavSizeLimitError) {
			throw error;
		}
		console.warn(
			`${PLUGIN_LOG_PREFIX} Streaming mix failed, falling back to the Web Audio mix:`,
			error,
		);
		return null;
	}
}
