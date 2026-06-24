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
	it('is zero for silence and empty input', () => {
		expect(computeRms(new Float32Array(0))).toBe(0);
		expect(computeRms(new Float32Array([0, 0, 0]))).toBe(0);
	});

	it('computes the root mean square amplitude', () => {
		// Constant 0.5 -> RMS 0.5
		expect(
			computeRms(new Float32Array([0.5, -0.5, 0.5, -0.5])),
		).toBeCloseTo(0.5);
		// Full-scale square wave -> RMS 1
		expect(computeRms(new Float32Array([1, -1, 1, -1]))).toBeCloseTo(1);
	});
});

describe('rmsToMeterFraction', () => {
	it('maps silence to 0 and full scale to 1', () => {
		expect(rmsToMeterFraction(0)).toBe(0);
		expect(rmsToMeterFraction(1)).toBeCloseTo(1);
	});

	it('maps the dB floor to 0 and is monotonic', () => {
		// -60 dBFS is the floor
		expect(rmsToMeterFraction(0.001)).toBeCloseTo(0);
		const quiet = rmsToMeterFraction(0.01); // -40 dBFS
		const loud = rmsToMeterFraction(0.1); // -20 dBFS
		expect(quiet).toBeGreaterThan(0);
		expect(loud).toBeGreaterThan(quiet);
		expect(loud).toBeLessThan(1);
	});
});
