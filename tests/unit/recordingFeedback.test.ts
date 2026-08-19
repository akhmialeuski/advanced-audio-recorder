/**
 * Tests for the pure recording-feedback helpers: byte formatting and the
 * input-level RMS / meter math.
 */

import { formatByteSize } from 'src/utils/formatBytes';
import {
	computeRms,
	rmsToMeterFraction,
} from 'src/recording/InputLevelMonitor';

describe('formatByteSize', () => {
	const KB = 1024;
	const MB = KB * 1024;
	const GB = MB * 1024;

	it.each([
		// One step either side of every unit boundary: the exponent comes
		// from a log, and an off-by-one there relabels the whole reading.
		{ bytes: 1, expected: '1 B' },
		{ bytes: 512, expected: '512 B' },
		{ bytes: KB - 1, expected: '1023 B' },
		{ bytes: KB, expected: '1.0 KB' },
		{ bytes: KB + 1, expected: '1.0 KB' },
		{ bytes: MB - 1, expected: '1024.0 KB' },
		{ bytes: MB, expected: '1.0 MB' },
		{ bytes: 1.5 * MB, expected: '1.5 MB' },
		{ bytes: GB - 1, expected: '1024.0 MB' },
		{ bytes: GB, expected: '1.0 GB' },
		{ bytes: 2 * GB, expected: '2.0 GB' },
		// Past the largest unit the table has a name for: the exponent is
		// clamped, so the number grows rather than the label running out.
		{ bytes: Math.pow(1024, 9), expected: '1024.0 YB' },
	])('formats $bytes as "$expected"', ({ bytes, expected }) => {
		expect(formatByteSize(bytes)).toBe(expected);
	});

	it.each([
		{ name: 'nothing recorded yet', bytes: 0 },
		{ name: 'a negative count', bytes: -5 },
		{ name: 'a count that is not a number', bytes: Number.NaN },
		{ name: 'an infinite count', bytes: Number.POSITIVE_INFINITY },
	])('renders $name as 0 B', ({ bytes }) => {
		// The status bar shows this while a recording runs, so any of these
		// reaching it would read as a broken counter rather than a fresh one.
		expect(formatByteSize(bytes)).toBe('0 B');
	});

	it.each([
		{
			name: 'more decimals than the default',
			bytes: 1.25 * MB,
			options: { decimals: 2 },
			expected: '1.25 MB',
		},
		{
			name: 'trailing zeros trimmed away',
			bytes: 1.5 * MB,
			options: { decimals: 2, trimZeros: true },
			expected: '1.5 MB',
		},
		{
			name: 'a whole number trimmed to no decimals at all',
			bytes: 2 * MB,
			options: { decimals: 2, trimZeros: true },
			expected: '2 MB',
		},
		{
			name: 'no decimals asked for',
			bytes: 1.5 * MB,
			options: { decimals: 0 },
			expected: '2 MB',
		},
		{
			name: 'a spelt-out bytes label',
			bytes: 500,
			options: { bytesLabel: 'Bytes' },
			expected: '500 Bytes',
		},
		{
			// The label applies to bytes only; above that the unit names
			// itself, or a size would read "1.0 KBytes".
			name: 'a bytes label above the bytes unit',
			bytes: KB,
			options: { bytesLabel: 'Bytes' },
			expected: '1.0 KB',
		},
	])('honours $name', ({ bytes, options, expected }) => {
		expect(formatByteSize(bytes, options)).toBe(expected);
	});
});

describe('computeRms', () => {
	it.each([
		// The edges of the input first: no samples at all, and a buffer the
		// analyser filled with digital silence.
		{ name: 'no samples at all', samples: [], expected: 0 },
		{ name: 'digital silence', samples: [0, 0, 0], expected: 0 },
		{ name: 'a single sample', samples: [1], expected: 1 },
		{
			name: 'a constant half-scale signal',
			samples: [0.5, -0.5, 0.5, -0.5],
			expected: 0.5,
		},
		{
			name: 'a full-scale square wave',
			samples: [1, -1, 1, -1],
			expected: 1,
		},
		{
			// Sign must not matter: RMS squares before it averages, so an
			// inverted signal reads exactly as loud as the original.
			name: 'a wholly negative signal',
			samples: [-0.5, -0.5, -0.5, -0.5],
			expected: 0.5,
		},
		{
			// Float32 clamping happens in the encoder, not here. A sample
			// past full scale must carry through rather than be clipped,
			// or a clipping input would read as merely loud.
			name: 'samples past full scale',
			samples: [2, -2],
			expected: 2,
		},
		{
			// One click in an otherwise silent buffer: the mean drags the
			// answer down, which is what keeps the meter from flickering.
			name: 'a lone click in silence',
			samples: [1, 0, 0, 0],
			expected: 0.5,
		},
	])('reads $name as $expected', ({ samples, expected }) => {
		expect(computeRms(Float32Array.from(samples))).toBeCloseTo(expected);
	});
});

describe('rmsToMeterFraction', () => {
	// The scale runs from the -60 dBFS floor to 0 dBFS, linear in decibels.
	it.each([
		{ name: 'silence', rms: 0, expected: 0 },
		{
			// Not reachable from computeRms, but the guard is what stops
			// log10 of a negative from putting NaN in the meter's width.
			name: 'a negative amplitude',
			rms: -1,
			expected: 0,
		},
		{ name: 'a hair below the floor', rms: 0.0001, expected: 0 },
		{ name: 'exactly the -60 dBFS floor', rms: 0.001, expected: 0 },
		{ name: 'the -30 dBFS midpoint', rms: 0.0316227766, expected: 0.5 },
		{ name: 'full scale', rms: 1, expected: 1 },
		{
			// A clipping input must peg the meter, not overflow past it.
			name: 'past full scale',
			rms: 2,
			expected: 1,
		},
	])('maps $name to $expected', ({ rms, expected }) => {
		expect(rmsToMeterFraction(rms)).toBeCloseTo(expected);
	});

	it('rises monotonically between the floor and full scale', () => {
		const readings = [0.001, 0.01, 0.1, 1].map(rmsToMeterFraction);

		expect(readings).toEqual([...readings].sort((a, b) => a - b));
		expect(new Set(readings).size).toBe(readings.length);
	});
});
