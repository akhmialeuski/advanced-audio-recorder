/**
 * The conversion downmix hooks run on real mediabunny samples, compared with
 * the capture-time downmix bit for bit.
 *
 * The hooks exist because the mono modes are defined once, by
 * downmixChannelData, and every path that reduces audio to mono must agree with
 * it to the last bit: a recording downmixed while it was captured and the same
 * recording converted afterwards are the same file. Mediabunny's own
 * `numberOfChannels: 1` was measured against that and misses by a float32 step
 * in about one sample in ten (see averageChannelsSample), so the hooks stay and
 * this suite pins what they are kept for. It runs against the real AudioSample
 * because the double only stores what it was given and would agree with any
 * layout the hook assumed.
 * @module tests/unit/conversionDownmix.test
 */

import { AudioSample } from 'mediabunny';
import { ChannelMode, downmixChannelData } from 'src/audio/downmix';
import {
	averageChannelsSample,
	extractChannelSample,
} from 'src/audio/streamingConversion';

/** Frames in one decoded sample, the size an Opus packet decodes to. */
const FRAMES = 960;

/**
 * Deterministic noise across the full range, including the rails, so the
 * comparison meets every rounding case rather than a few smooth values.
 * @param seed - Distinguishes one channel from another
 */
function noise(seed: number): Float32Array {
	const data = new Float32Array(FRAMES);
	let state = seed;
	for (let index = 0; index < FRAMES; index++) {
		state = (state * 16807) % 2147483647;
		data[index] = (state / 2147483647) * 2 - 1;
	}
	data[0] = 1;
	data[1] = -1;
	return data;
}

/**
 * A real planar sample holding the given channels.
 * @param channels - One array of samples per channel
 */
function planarSample(channels: Float32Array[]): AudioSample {
	const data = new Float32Array(FRAMES * channels.length);
	channels.forEach((channel, index) => {
		data.set(channel, index * FRAMES);
	});
	return new AudioSample({
		data,
		format: 'f32-planar',
		numberOfChannels: channels.length,
		sampleRate: 48000,
		timestamp: 1.5,
	});
}

/**
 * The mono samples a hook produced.
 * @param sample - What the hook returned
 */
function monoOf(sample: AudioSample): Float32Array {
	const data = new Float32Array(sample.numberOfFrames);
	sample.copyTo(data, { planeIndex: 0, format: 'f32-planar' });
	return data;
}

describe('the conversion downmix', () => {
	it.each([
		{ layout: 'stereo', count: 2 },
		{ layout: '5.1', count: 6 },
	])(
		'mixes a $layout sample exactly as the capture downmix does',
		({ count }) => {
			const channels = Array.from({ length: count }, (_, index) =>
				noise(index + 1),
			);

			const mixed = new AudioSample(
				averageChannelsSample(planarSample(channels)),
			);

			expect(monoOf(mixed)).toEqual(
				downmixChannelData(channels, ChannelMode.MonoMix),
			);
		},
	);

	it.each([
		{ mode: ChannelMode.MonoLeft, index: 0 },
		{ mode: ChannelMode.MonoRight, index: 1 },
	])('keeps the $mode channel exactly', ({ mode, index }) => {
		const channels = [noise(1), noise(2)];

		const picked = new AudioSample(
			extractChannelSample(planarSample(channels), index),
		);

		expect(monoOf(picked)).toEqual(downmixChannelData(channels, mode));
	});

	it('keeps the timing of the sample it mixed', () => {
		const sample = planarSample([noise(1), noise(2)]);

		const mixed = new AudioSample(averageChannelsSample(sample));

		expect({
			timestamp: mixed.timestamp,
			sampleRate: mixed.sampleRate,
			numberOfFrames: mixed.numberOfFrames,
			numberOfChannels: mixed.numberOfChannels,
		}).toEqual({
			timestamp: 1.5,
			sampleRate: 48000,
			numberOfFrames: FRAMES,
			numberOfChannels: 1,
		});
	});
});
