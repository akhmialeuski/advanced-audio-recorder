/**
 * The streaming conversion writing WAV, run on the real mediabunny.
 *
 * WAV used to be decoded whole into an AudioBuffer before it was encoded, on
 * the belief that the streaming pipeline only wrote compressed formats. It
 * writes WAV as well, and mediabunny decodes PCM itself, without WebCodecs,
 * which is what lets jsdom run the whole path here: a real WAV goes in, the
 * real demuxer, decoder, mono hook and WAV muxer run, and the file that comes
 * out is read back with the real demuxer.
 * @module tests/integration/streamingWavConversion.test
 */

import { AudioSampleSink } from 'mediabunny';
import { runStreamingConversion } from 'src/audio/streamingConversion';
import { ChannelMode } from 'src/audio/downmix';
import { assembleWavFromPcmSegments } from 'src/audio/WavEncoder';
import { PcmSampleFormat } from 'src/audio/pcm';
import { encodePcmSamples } from '../helpers/pcmFixtures';
import { withPrimaryAudioTrack } from '../helpers/encodedAudioFixtures';

/** Sample rate of the fixture, deliberately not the device's own. */
const SAMPLE_RATE = 22050;

/** Frames in the fixture: a little over one second. */
const FRAMES = 24000;

/**
 * A stereo 16-bit WAV whose left channel ramps up and whose right channel is
 * a constant, so the mono mix of every frame is known in advance.
 */
function stereoWav(): Blob {
	const interleaved: number[] = [];
	for (let frame = 0; frame < FRAMES; frame++) {
		interleaved.push((frame % 2000) * 8, 4000);
	}
	const pcm = encodePcmSamples(PcmSampleFormat.Int16, interleaved);
	return new Blob([assembleWavFromPcmSegments([pcm], 2, SAMPLE_RATE)], {
		type: 'audio/wav',
	});
}

/**
 * What a converted file holds, read back through the real demuxer.
 * @param bytes - The converted file
 */
async function readBack(bytes: ArrayBuffer): Promise<{
	mimeType: string;
	codec: string | null;
	channels: number;
	sampleRate: number;
	first: Float32Array;
}> {
	return withPrimaryAudioTrack(bytes, async (track, input) => {
		const sink = new AudioSampleSink(track);
		const first = await sink.getSample(0);
		const samples = new Float32Array(first?.numberOfFrames ?? 0);
		first?.copyTo(samples, { planeIndex: 0, format: 'f32-planar' });
		return {
			mimeType: await input.getMimeType(),
			codec: await track.getCodec(),
			channels: await track.getNumberOfChannels(),
			sampleRate: await track.getSampleRate(),
			first: samples,
		};
	});
}

describe('converting to WAV through the streaming pipeline', () => {
	it('writes a 16-bit WAV at the source rate', async () => {
		const { data: converted } = await runStreamingConversion(
			stereoWav(),
			'wav',
			0,
			false,
		);

		expect(await readBack(converted)).toMatchObject({
			mimeType: 'audio/wav',
			codec: 'pcm-s16',
			channels: 2,
			sampleRate: SAMPLE_RATE,
		});
	});

	it('downmixes to mono with the average of both channels', async () => {
		const { data: converted } = await runStreamingConversion(
			stereoWav(),
			'wav',
			0,
			false,
			undefined,
			ChannelMode.MonoMix,
		);

		const { channels, first } = await readBack(converted);

		expect(channels).toBe(1);
		// Frame 100: left is 800 and right 4000, so the mix is 2400 of full
		// scale, which survives the 16-bit round trip exactly.
		expect(first[100]).toBeCloseTo(2400 / 32768, 6);
	});
});
