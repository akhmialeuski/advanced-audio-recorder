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

/**
 * A mono A-law WAV, one byte per frame.
 *
 * The one compressed file jsdom can decode: the WAV byte copy cannot take it,
 * since A-law is not linear PCM, and mediabunny decodes it itself, without
 * WebCodecs. A split of it therefore runs the streamed split for real.
 * @param sampleRate - Frames per second
 * @param seconds - Length of the recording
 * @returns The file's bytes
 */
export function alawWav(sampleRate: number, seconds: number): ArrayBuffer {
	const frames = Math.round(sampleRate * seconds);
	const bytes = new Uint8Array(44 + frames);
	const view = new DataView(bytes.buffer);
	const ascii = (offset: number, text: string): void => {
		[...text].forEach((char, index) => {
			view.setUint8(offset + index, char.charCodeAt(0));
		});
	};
	ascii(0, 'RIFF');
	view.setUint32(4, 36 + frames, true);
	ascii(8, 'WAVE');
	ascii(12, 'fmt ');
	view.setUint32(16, 16, true);
	view.setUint16(20, 0x0006, true);
	view.setUint16(22, 1, true);
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate, true);
	view.setUint16(32, 1, true);
	view.setUint16(34, 8, true);
	ascii(36, 'data');
	view.setUint32(40, frames, true);
	for (let frame = 0; frame < frames; frame++) {
		bytes[44 + frame] = frame % 251;
	}
	return bytes.buffer;
}
