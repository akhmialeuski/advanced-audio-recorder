/**
 * What a merged multi-track file is made of: where each track sits in it and
 * which format it is written in. A session stopped normally and a session
 * recovered after a crash both merge through these, so the two produce the
 * same file.
 * @module recording/mergeOutput
 */

import { FORMAT_WAV } from '../constants';
import { INT16_MAX } from '../audio/pcm';
import { isOfflineEncodingSupported } from '../audio/AudioEncoder';
import type { MergePlacement } from '../audio/AudioFormatConverter';
import type { TrackMix } from '../types';
import { gainFactor, normalizeFactor, panGains } from './mixMath';

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
