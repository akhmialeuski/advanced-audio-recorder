/**
 * Tests for the raw-PCM primitives every representation of a sample goes
 * through: how wide it is, how it is written, and how it is read back.
 * @module tests/unit/pcm.test
 */

import {
	decodePcmSamples,
	floatToInt16,
	INT16_MAX,
	INT16_MIN,
	INT24_MAX,
	INT24_MIN,
	normalizePcmSampleFormat,
	PCM_FULL_SCALE,
	PCM_SAMPLE_BITS,
	PCM_SAMPLE_BYTES,
	PcmSampleFormat,
	readPcmSample,
	writePcmSample,
} from 'src/audio/pcm';
import { encodePcmSamples } from '../helpers/pcmFixtures';

/** Writes one sample and reads it straight back out of the same bytes. */
function roundTrip(format: PcmSampleFormat, value: number): number {
	const view = new DataView(new ArrayBuffer(PCM_SAMPLE_BYTES[format]));
	writePcmSample(view, 0, format, value);
	return readPcmSample(view, 0, format);
}

describe('what a representation is', () => {
	it.each([
		[PcmSampleFormat.Int16, 2, 16, INT16_MAX],
		[PcmSampleFormat.Int24, 3, 24, INT24_MAX],
		[PcmSampleFormat.Float32, 4, 32, 1],
	])('%s is %s bytes of %s bits', (format, bytes, bits, fullScale) => {
		expect(PCM_SAMPLE_BYTES[format]).toBe(bytes);
		expect(PCM_SAMPLE_BITS[format]).toBe(bits);
		expect(PCM_FULL_SCALE[format]).toBe(fullScale);
	});

	it.each(['int16', 'int24', 'float32'])(
		'keeps %s, which is a representation it knows',
		(stored) => {
			expect(normalizePcmSampleFormat(stored)).toBe(stored);
		},
	);

	// A width nothing can honour would have the worklet writing one thing and
	// the header declaring another, so anything unrecognised - a hand-edited
	// data.json, a journal from a version that had no choice - reads as the
	// representation every earlier recording used.
	it.each([undefined, null, '', 'int32', 24, {}])(
		'reads %p as the sixteen-bit representation',
		(stored) => {
			expect(normalizePcmSampleFormat(stored)).toBe(
				PcmSampleFormat.Int16,
			);
		},
	);
});

describe('writing and reading one sample', () => {
	it.each([
		[PcmSampleFormat.Int16, 12345],
		[PcmSampleFormat.Int16, -12345],
		[PcmSampleFormat.Int24, 1234567],
		[PcmSampleFormat.Int24, -1234567],
		[PcmSampleFormat.Float32, 0.25],
		[PcmSampleFormat.Float32, -0.75],
	])('carries %s value %p through unchanged', (format, value) => {
		expect(roundTrip(format, value)).toBe(value);
	});

	it.each([
		[PcmSampleFormat.Int16, INT16_MAX, INT16_MIN],
		[PcmSampleFormat.Int24, INT24_MAX, INT24_MIN],
	])('reaches both rails of %s', (format, max, min) => {
		expect(roundTrip(format, max)).toBe(max);
		expect(roundTrip(format, min)).toBe(min);
	});

	// A sample past the rails wraps into the opposite sign if it is written
	// as it stands, which is a click at full volume in the middle of a track.
	it.each([
		[PcmSampleFormat.Int16, INT16_MAX, INT16_MIN],
		[PcmSampleFormat.Int24, INT24_MAX, INT24_MIN],
	])('holds an out-of-range %s sample to its rails', (format, max, min) => {
		expect(roundTrip(format, max * 3)).toBe(max);
		expect(roundTrip(format, min * 3)).toBe(min);
	});

	it.each([
		[PcmSampleFormat.Int16, 100.4, 100],
		[PcmSampleFormat.Int16, 100.6, 101],
		[PcmSampleFormat.Int24, -100.6, -101],
	])('rounds %s value %p to %p', (format, value, expected) => {
		expect(roundTrip(format, value)).toBe(expected);
	});

	// The whole point of the floating point representation: an overloaded
	// take survives and is brought back by normalizing the file afterwards.
	it.each([1.5, -2.25])('keeps the out-of-scale float %p', (value) => {
		expect(roundTrip(PcmSampleFormat.Float32, value)).toBe(value);
	});

	it('writes twenty-four bit samples little-endian, sign in the top byte', () => {
		const view = new DataView(new ArrayBuffer(3));

		writePcmSample(view, 0, PcmSampleFormat.Int24, -2);

		expect([view.getUint8(0), view.getUint8(1), view.getUint8(2)]).toEqual([
			0xfe, 0xff, 0xff,
		]);
	});

	it('writes at the offset it was given', () => {
		const view = new DataView(new ArrayBuffer(9));

		writePcmSample(view, 3, PcmSampleFormat.Int24, INT24_MAX);

		expect(readPcmSample(view, 0, PcmSampleFormat.Int24)).toBe(0);
		expect(readPcmSample(view, 3, PcmSampleFormat.Int24)).toBe(INT24_MAX);
		expect(readPcmSample(view, 6, PcmSampleFormat.Int24)).toBe(0);
	});
});

describe('reading a whole buffer of samples', () => {
	it.each([
		[PcmSampleFormat.Int16, [0, 1000, -1000, INT16_MAX]],
		[PcmSampleFormat.Int24, [0, 1000000, -1000000, INT24_MAX]],
		[PcmSampleFormat.Float32, [0, 0.5, -0.5, 1]],
	])('reads back every %s sample it was given', (format, samples) => {
		expect(
			Array.from(
				decodePcmSamples(encodePcmSamples(format, samples), format),
			),
		).toEqual(samples);
	});

	// A segment flushed while a frame was half written ends mid-sample, and
	// reading those spare bytes as a sample would put a loud fragment at the
	// end of the part.
	it.each([
		[PcmSampleFormat.Int16, 1],
		[PcmSampleFormat.Int24, 2],
		[PcmSampleFormat.Float32, 3],
	])('drops a torn trailing %s sample', (format, spareBytes) => {
		const whole = encodePcmSamples(format, [1, 1]);
		const torn = new Uint8Array(whole.byteLength + spareBytes);
		torn.set(new Uint8Array(whole), 0);

		expect(decodePcmSamples(torn.buffer, format)).toHaveLength(2);
	});
});

describe('the shared float to int16 mapping', () => {
	it('uses the full negative rail and the positive one below it', () => {
		expect(floatToInt16(-1)).toBe(INT16_MIN);
		expect(floatToInt16(1)).toBe(INT16_MAX);
	});

	it('clamps a sample that ran past full scale', () => {
		expect(floatToInt16(-4)).toBe(INT16_MIN);
		expect(floatToInt16(4)).toBe(INT16_MAX);
	});
});
