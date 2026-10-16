/**
 * An AAC encoder that refuses what Chromium's refuses, registered with the
 * real mediabunny so a suite runs the real Conversion against it.
 *
 * jsdom has no WebCodecs, and the scripted `canEncodeAudio` answers in
 * encoderProfiles need mediabunny mocked out, which hides exactly the
 * fallback a low-rate conversion goes through. mediabunny asks a registered
 * custom encoder before the platform, both in `canEncodeAudio` and when it
 * builds the encoder, so this one stands in for the platform end to end. It
 * writes placeholder packets: the suites read back the container, not the
 * audio.
 * @module tests/helpers/chromiumAacEncoder
 */

import { CustomAudioEncoder, EncodedPacket, registerEncoder } from 'mediabunny';
import type { AudioCodec, AudioSample } from 'mediabunny';

/**
 * The sample rates Chromium's WebCodecs AAC encoder takes, in Hz. Blink checks
 * this list on every platform, outside any platform build flag, in
 * third_party/blink/renderer/modules/webcodecs/audio_encoder.cc.
 */
export const CHROMIUM_AAC_SAMPLE_RATES: readonly number[] = [44100, 48000];

/** The channel counts the same check takes. */
const CHROMIUM_AAC_CHANNEL_COUNTS: readonly number[] = [1, 2, 6];

/**
 * The MPEG-4 sampling frequency table, in index order, which is how an
 * AudioSpecificConfig names a rate.
 */
const MPEG4_SAMPLING_FREQUENCIES: readonly number[] = [
	96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025,
	8000, 7350,
];

/** The audio object type of AAC-LC in an AudioSpecificConfig. */
const AAC_LC_OBJECT_TYPE = 2;

/**
 * The two-byte AudioSpecificConfig of an AAC-LC stream, which the MP4 muxer
 * writes into the file and the demuxer reads the layout back from.
 * @param sampleRate - Rate of the stream, one of the table's
 * @param numberOfChannels - Channel configuration of the stream
 */
function audioSpecificConfig(
	sampleRate: number,
	numberOfChannels: number,
): Uint8Array {
	const index = MPEG4_SAMPLING_FREQUENCIES.indexOf(sampleRate);
	return new Uint8Array([
		(AAC_LC_OBJECT_TYPE << 3) | (index >> 1),
		((index & 1) << 7) | (numberOfChannels << 3),
	]);
}

/** Encodes nothing real, at only the layouts Chromium would encode. */
class ChromiumAacEncoder extends CustomAudioEncoder {
	/** Whether the decoder configuration has gone out with a packet yet. */
	private described = false;

	static override supports(
		codec: AudioCodec,
		config: AudioEncoderConfig,
	): boolean {
		return (
			codec === 'aac' &&
			CHROMIUM_AAC_SAMPLE_RATES.includes(config.sampleRate) &&
			CHROMIUM_AAC_CHANNEL_COUNTS.includes(config.numberOfChannels)
		);
	}

	init(): void {}

	encode(sample: AudioSample): void {
		const { sampleRate, numberOfChannels } = this.config;
		const meta = this.described
			? undefined
			: {
					decoderConfig: {
						codec: this.config.codec,
						sampleRate,
						numberOfChannels,
						description: audioSpecificConfig(
							sampleRate,
							numberOfChannels,
						),
					},
				};
		this.described = true;
		this.onPacket(
			new EncodedPacket(
				new Uint8Array(8),
				'key',
				sample.timestamp,
				sample.duration,
			),
			meta,
		);
	}

	flush(): void {}

	close(): void {}
}

/**
 * Registers the encoder with mediabunny for the rest of the test file, which
 * has a module registry of its own.
 */
export function registerChromiumAacEncoder(): void {
	registerEncoder(ChromiumAacEncoder);
}
