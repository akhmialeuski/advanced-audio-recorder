/**
 * Scripted answers for mediabunny's `canEncodeAudio`, one per device the
 * field reports describe, so a suite states which machine it is on instead
 * of restating the encoder's rules.
 * @module tests/helpers/encoderProfiles
 */

import { canEncodeAudio } from 'mediabunny';

/** The rates a Windows Media Foundation AAC encoder takes, and no others. */
export const WINDOWS_AAC_BITRATES = [96000, 128000, 160000, 192000];

/**
 * The sample rates the platform AAC encoder takes, in Hz. Chromium's WebCodecs
 * encoder checks this list on every platform, outside any platform build flag,
 * in third_party/blink/renderer/modules/webcodecs/audio_encoder.cc, so a
 * low-rate AAC encode is refused whatever profile it is asked for.
 */
export const PLATFORM_AAC_SAMPLE_RATES: readonly number[] = [44100, 48000];

/** Codec string of AAC-LC, the only AAC profile a Chromium encoder has. */
export const AAC_LC = 'mp4a.40.2';

/** At or below this mediabunny builds an HE-AAC string unless told otherwise. */
const HE_AAC_MAX_SAMPLE_RATE = 24000;

/** The shape of the options mediabunny hands the probe. */
interface ProbeOptions {
	sampleRate?: number;
	numberOfChannels?: number;
	quality?: { options?: { bitrate?: number } };
	fullCodecString?: string;
}

/**
 * The codec string mediabunny would hand the platform for a question: the one
 * the caller named, or the one it builds from the layout. Mirrors
 * `buildAudioCodecString` in mediabunny's codec module, so a probe that
 * leaves the string to mediabunny asks this double about HE-AAC exactly where
 * it would ask the platform about it.
 * @param options - What the probe asked
 * @param defaultRate - The rate assumed when the probe states none
 */
export function aacCodecStringAsked(
	options: ProbeOptions | undefined,
	defaultRate: number,
): string {
	if (options?.fullCodecString !== undefined) {
		return options.fullCodecString;
	}
	if ((options?.sampleRate ?? defaultRate) > HE_AAC_MAX_SAMPLE_RATE) {
		return AAC_LC;
	}
	return (options?.numberOfChannels ?? 2) >= 2 ? 'mp4a.40.29' : 'mp4a.40.5';
}

/**
 * An AAC encoder that has the AAC-LC profile and nothing else, at every rate
 * and bitrate: no HE-AAC, which is the profile mediabunny names at 24 kHz and
 * below unless it is told otherwise. Every other codec accepts anything.
 * The `mediabunny` module must already be replaced by the shared double.
 */
export function installAacLcOnlyEncoder(): void {
	jest.mocked(canEncodeAudio).mockImplementation(
		(codec: unknown, options?: ProbeOptions): Promise<boolean> =>
			Promise.resolve(
				codec !== 'aac' ||
					aacCodecStringAsked(options, 48000) === AAC_LC,
			),
	);
}

/**
 * A Windows desktop: the platform AAC encoder takes four bitrates, two sample
 * rates and only AAC-LC; every other codec accepts anything.
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
				aacCodecStringAsked(options, defaultRate) === AAC_LC &&
					PLATFORM_AAC_SAMPLE_RATES.includes(
						options?.sampleRate ?? defaultRate,
					) &&
					(bitrate === undefined ||
						WINDOWS_AAC_BITRATES.includes(bitrate)),
			);
		},
	);
}
