/**
 * Raw PCM in a named representation, for the suites that read or write it.
 *
 * Three of them built the same loop over `writePcmSample` to turn a list of
 * numbers into the bytes a segment or a WAV payload holds, so the loop lives
 * here and each suite says only which representation it is testing.
 * @module tests/helpers/pcmFixtures
 */

import {
	PCM_SAMPLE_BYTES,
	writePcmSample,
	type PcmSampleFormat,
} from 'src/audio/pcm';

/**
 * Writes samples into raw interleaved PCM bytes.
 * @param format - How one sample is stored
 * @param samples - The samples, on that representation's own scale
 * @returns The bytes a segment or a WAV payload would hold
 */
export function encodePcmSamples(
	format: PcmSampleFormat,
	samples: readonly number[],
): ArrayBuffer {
	const width = PCM_SAMPLE_BYTES[format];
	const bytes = new ArrayBuffer(samples.length * width);
	const view = new DataView(bytes);
	samples.forEach((sample, index) => {
		writePcmSample(view, index * width, format, sample);
	});
	return bytes;
}
