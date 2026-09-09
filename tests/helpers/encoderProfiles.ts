/**
 * Scripted answers for mediabunny's `canEncodeAudio`, one per device the
 * field reports describe, so a suite states which machine it is on instead
 * of restating the encoder's rules.
 * @module tests/helpers/encoderProfiles
 */

import { canEncodeAudio } from 'mediabunny';

/** The rates a Windows Media Foundation AAC encoder takes, and no others. */
export const WINDOWS_AAC_BITRATES = [96000, 128000, 160000, 192000];

/** Above this mediabunny asks for AAC-LC; at or below, for HE-AAC. */
export const AAC_LC_MIN_SAMPLE_RATE = 24000;

/** The shape of the options mediabunny hands the probe. */
interface ProbeOptions {
	sampleRate?: number;
	numberOfChannels?: number;
	quality?: { options?: { bitrate?: number } };
}

/**
 * A Windows desktop: the platform AAC encoder takes four rates and only
 * AAC-LC, so nothing at 24 kHz or below; every other codec accepts anything.
 * The `mediabunny` module must already be replaced by the shared double.
 * @param defaultRate - The rate assumed when the probe states none
 */
export function installWindowsAacEncoder(defaultRate = 48000): void {
	jest.mocked(canEncodeAudio).mockImplementation(
		(codec: unknown, options?: ProbeOptions): Promise<boolean> => {
			if (codec !== 'aac') {
				return Promise.resolve(true);
			}
			const bitrate = options?.quality?.options?.bitrate;
			return Promise.resolve(
				(options?.sampleRate ?? defaultRate) > AAC_LC_MIN_SAMPLE_RATE &&
					(bitrate === undefined ||
						WINDOWS_AAC_BITRATES.includes(bitrate)),
			);
		},
	);
}
