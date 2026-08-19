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
	it('formats bytes, KB, MB, and GB', () => {
		expect(formatByteSize(512)).toBe('512 B');
		expect(formatByteSize(1024)).toBe('1.0 KB');
		expect(formatByteSize(1.5 * 1024 * 1024)).toBe('1.5 MB');
		expect(formatByteSize(2 * 1024 * 1024 * 1024)).toBe('2.0 GB');
	});

	it('renders non-positive or invalid input as 0 B', () => {
		expect(formatByteSize(0)).toBe('0 B');
		expect(formatByteSize(-5)).toBe('0 B');
		expect(formatByteSize(Number.NaN)).toBe('0 B');
	});

	it('honors presentation options (decimals, trimZeros, bytesLabel)', () => {
		expect(formatByteSize(1.25 * 1024 * 1024, { decimals: 2 })).toBe(
			'1.25 MB',
		);
		expect(
			formatByteSize(1.5 * 1024 * 1024, { decimals: 2, trimZeros: true }),
		).toBe('1.5 MB');
		expect(formatByteSize(500, { bytesLabel: 'Bytes' })).toBe('500 Bytes');
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
