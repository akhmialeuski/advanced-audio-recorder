/**
 * The streaming conversion writing AAC from a low-rate source, run on the real
 * mediabunny against an encoder that takes only what Chromium's takes.
 *
 * A 16 kHz mono recording converted to M4A used to come out as stereo 48 kHz:
 * the platform encoder refused 16 kHz, and mediabunny's Conversion answered
 * the refusal with its own fixed fallback layout instead of the nearest rate
 * the encoder takes at the source's channel count. Here a real WAV goes
 * through the real demuxer, Conversion, resampler and MP4 muxer, and the file
 * that comes out is read back with the real demuxer.
 * @module tests/integration/streamingAacConversion.test
 */

import { runStreamingConversion } from 'src/audio/streamingConversion';
import { ChannelMode } from 'src/audio/downmix';
import { assembleWavFromPcmSegments } from 'src/audio/WavEncoder';
import { PcmSampleFormat } from 'src/audio/pcm';
import { encodePcmSamples } from '../helpers/pcmFixtures';
import { registerChromiumAacEncoder } from '../helpers/chromiumAacEncoder';
import { withPrimaryAudioTrack } from '../helpers/encodedAudioFixtures';

/** Bitrate of every conversion here, one the Windows encoder also takes. */
const BITRATE = 96000;

/**
 * A one-second 16-bit WAV of a quiet ramp on every channel.
 * @param sampleRate - Rate of the recording
 * @param numberOfChannels - Channels of the recording
 */
function wav(sampleRate: number, numberOfChannels: number): Blob {
	const interleaved: number[] = [];
	for (let frame = 0; frame < sampleRate; frame++) {
		for (let channel = 0; channel < numberOfChannels; channel++) {
			interleaved.push((frame % 2000) * 4);
		}
	}
	const pcm = encodePcmSamples(PcmSampleFormat.Int16, interleaved);
	return new Blob(
		[assembleWavFromPcmSegments([pcm], numberOfChannels, sampleRate)],
		{ type: 'audio/wav' },
	);
}

/**
 * The layout a converted file states, read back through the real demuxer.
 * @param bytes - The converted file
 */
async function layoutOf(bytes: ArrayBuffer): Promise<{
	codec: string | null;
	channels: number;
	sampleRate: number;
}> {
	return withPrimaryAudioTrack(bytes, async (track) => ({
		codec: await track.getCodec(),
		channels: await track.getNumberOfChannels(),
		sampleRate: await track.getSampleRate(),
	}));
}

describe('converting a low-rate recording to AAC through the streaming pipeline', () => {
	beforeAll(() => {
		registerChromiumAacEncoder();
	});

	beforeEach(() => {
		jest.spyOn(console, 'warn').mockImplementation(() => {});
	});

	it('keeps a 16 kHz mono source mono at the nearest rate the encoder takes', async () => {
		const onSampleRateChange = jest.fn();

		const converted = await runStreamingConversion(
			wav(16000, 1),
			'm4a',
			BITRATE,
			false,
			undefined,
			undefined,
			onSampleRateChange,
		);

		expect(await layoutOf(converted)).toEqual({
			codec: 'aac',
			channels: 1,
			sampleRate: 44100,
		});
		expect(onSampleRateChange).toHaveBeenCalledWith({
			from: 16000,
			to: 44100,
		});
	});

	it('keeps a 22.05 kHz stereo source stereo, resampled to 44.1 kHz', async () => {
		const converted = await runStreamingConversion(
			wav(22050, 2),
			'm4a',
			BITRATE,
			false,
		);

		expect(await layoutOf(converted)).toEqual({
			codec: 'aac',
			channels: 2,
			sampleRate: 44100,
		});
	});

	it('leaves a source at a rate the encoder takes at that rate', async () => {
		const onSampleRateChange = jest.fn();

		const converted = await runStreamingConversion(
			wav(48000, 1),
			'm4a',
			BITRATE,
			false,
			undefined,
			undefined,
			onSampleRateChange,
		);

		expect(onSampleRateChange).not.toHaveBeenCalled();
		expect(await layoutOf(converted)).toEqual({
			codec: 'aac',
			channels: 1,
			sampleRate: 48000,
		});
	});

	it('downmixes a 16 kHz stereo source to mono at 44.1 kHz', async () => {
		const converted = await runStreamingConversion(
			wav(16000, 2),
			'm4a',
			BITRATE,
			false,
			undefined,
			ChannelMode.MonoMix,
		);

		expect(await layoutOf(converted)).toEqual({
			codec: 'aac',
			channels: 1,
			sampleRate: 44100,
		});
	});
});
