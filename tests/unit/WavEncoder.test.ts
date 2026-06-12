/**
 * Unit tests for WavEncoder module.
 * @module tests/unit/WavEncoder.test
 */
/** @jest-environment jsdom */

import type { App } from 'obsidian';
import {
	getWavHeaderInfo,
	createWavHeader,
	assembleWavFromPcmSegments,
	assembleWavFromPcmSegmentFiles,
} from '../../src/recording/WavEncoder';

describe('WavEncoder', () => {
	describe('getWavHeaderInfo', () => {
		it('should calculate correct header info for mono audio', () => {
			const info = getWavHeaderInfo(1, 44100, 1000);

			expect(info.headerSize).toBe(44);
			expect(info.totalSize).toBe(1044);
			expect(info.byteRate).toBe(88200); // 44100 * 2 * 1
		});

		it('should calculate correct header info for stereo audio', () => {
			const info = getWavHeaderInfo(2, 48000, 5000);

			expect(info.headerSize).toBe(44);
			expect(info.totalSize).toBe(5044);
			expect(info.byteRate).toBe(192000); // 48000 * 2 * 2
		});

		it('should handle different sample rates', () => {
			const rates = [8000, 16000, 22050, 44100, 48000, 96000];

			rates.forEach((rate) => {
				const info = getWavHeaderInfo(1, rate, 0);
				expect(info.byteRate).toBe(rate * 2);
			});
		});
	});
});

describe('createWavHeader', () => {
	it('should create a 44-byte WAV header', () => {
		const header = createWavHeader(1, 44100, 1000);

		expect(header.byteLength).toBe(44);
	});

	it('should contain valid RIFF/WAVE markers', () => {
		const header = createWavHeader(1, 44100, 1000);
		const view = new DataView(header);

		// RIFF
		expect(
			String.fromCharCode(
				view.getUint8(0),
				view.getUint8(1),
				view.getUint8(2),
				view.getUint8(3),
			),
		).toBe('RIFF');
		// WAVE
		expect(
			String.fromCharCode(
				view.getUint8(8),
				view.getUint8(9),
				view.getUint8(10),
				view.getUint8(11),
			),
		).toBe('WAVE');
		// fmt
		expect(
			String.fromCharCode(
				view.getUint8(12),
				view.getUint8(13),
				view.getUint8(14),
				view.getUint8(15),
			),
		).toBe('fmt ');
		// data
		expect(
			String.fromCharCode(
				view.getUint8(36),
				view.getUint8(37),
				view.getUint8(38),
				view.getUint8(39),
			),
		).toBe('data');
	});

	it('should set correct file size in RIFF header', () => {
		const pcmDataLength = 5000;
		const header = createWavHeader(1, 44100, pcmDataLength);
		const view = new DataView(header);

		// RIFF chunk size = file size - 8
		expect(view.getUint32(4, true)).toBe(44 - 8 + pcmDataLength);
	});

	it('should set correct audio format fields for mono', () => {
		const header = createWavHeader(1, 44100, 1000);
		const view = new DataView(header);

		expect(view.getUint16(20, true)).toBe(1); // PCM format
		expect(view.getUint16(22, true)).toBe(1); // 1 channel
		expect(view.getUint32(24, true)).toBe(44100); // sample rate
		expect(view.getUint32(28, true)).toBe(88200); // byte rate: 44100 * 1 * 2
		expect(view.getUint16(32, true)).toBe(2); // block align: 1 * 2
		expect(view.getUint16(34, true)).toBe(16); // bits per sample
	});

	it('should set correct audio format fields for stereo', () => {
		const header = createWavHeader(2, 48000, 2000);
		const view = new DataView(header);

		expect(view.getUint16(22, true)).toBe(2); // 2 channels
		expect(view.getUint32(24, true)).toBe(48000); // sample rate
		expect(view.getUint32(28, true)).toBe(192000); // byte rate: 48000 * 2 * 2
		expect(view.getUint16(32, true)).toBe(4); // block align: 2 * 2
	});

	it('should set correct data subchunk size', () => {
		const pcmDataLength = 8800;
		const header = createWavHeader(1, 44100, pcmDataLength);
		const view = new DataView(header);

		expect(view.getUint32(40, true)).toBe(pcmDataLength);
	});
});

describe('assembleWavFromPcmSegments', () => {
	it('should assemble WAV from single segment', () => {
		const pcmData = new Int16Array([100, -100, 200, -200]).buffer;
		const result = assembleWavFromPcmSegments([pcmData], 1, 44100);

		expect(result.byteLength).toBe(44 + pcmData.byteLength);
	});

	it('should assemble WAV from multiple segments', () => {
		const seg1 = new Int16Array([100, -100]).buffer;
		const seg2 = new Int16Array([200, -200]).buffer;
		const seg3 = new Int16Array([300, -300]).buffer;

		const result = assembleWavFromPcmSegments([seg1, seg2, seg3], 1, 44100);

		const totalPcm = seg1.byteLength + seg2.byteLength + seg3.byteLength;
		expect(result.byteLength).toBe(44 + totalPcm);
	});

	it('should preserve PCM data in correct order', () => {
		const seg1 = new Int16Array([1000, 2000]).buffer;
		const seg2 = new Int16Array([3000, 4000]).buffer;

		const result = assembleWavFromPcmSegments([seg1, seg2], 1, 44100);

		const int16View = new Int16Array(result, 44);
		expect(int16View[0]).toBe(1000);
		expect(int16View[1]).toBe(2000);
		expect(int16View[2]).toBe(3000);
		expect(int16View[3]).toBe(4000);
	});

	it('should write correct WAV header for assembled data', () => {
		const pcmData = new Int16Array(100).buffer;
		const result = assembleWavFromPcmSegments([pcmData], 2, 48000);

		const view = new DataView(result);
		// Verify RIFF marker
		expect(
			String.fromCharCode(
				view.getUint8(0),
				view.getUint8(1),
				view.getUint8(2),
				view.getUint8(3),
			),
		).toBe('RIFF');
		// Verify channels
		expect(view.getUint16(22, true)).toBe(2);
		// Verify sample rate
		expect(view.getUint32(24, true)).toBe(48000);
		// Verify data size
		expect(view.getUint32(40, true)).toBe(pcmData.byteLength);
	});

	it('should handle empty segments array', () => {
		const result = assembleWavFromPcmSegments([], 1, 44100);

		// Header only, no data
		expect(result.byteLength).toBe(44);
		const view = new DataView(result);
		expect(view.getUint32(40, true)).toBe(0);
	});
});

describe('assembleWavFromPcmSegmentFiles', () => {
	/**
	 * Builds a mock App over an in-memory file map. With stat support
	 * the reported size comes from the stored buffer (overridable per
	 * path to simulate files changing between stat and read).
	 */
	const buildApp = (
		files: Map<string, ArrayBuffer>,
		options: {
			withStat?: boolean;
			statSizes?: Map<string, number | null>;
		} = {},
	): App => {
		const adapter: Record<string, unknown> = {
			readBinary: jest.fn((path: string) => {
				const data = files.get(path);
				return data
					? Promise.resolve(data)
					: Promise.reject(new Error(`Missing file: ${path}`));
			}),
		};
		if (options.withStat ?? true) {
			adapter.stat = jest.fn((path: string) => {
				if (options.statSizes?.has(path)) {
					const size = options.statSizes.get(path);
					return Promise.resolve(size === null ? null : { size });
				}
				const data = files.get(path);
				return Promise.resolve(data ? { size: data.byteLength } : null);
			});
		}
		return { vault: { adapter } } as unknown as App;
	};

	it('should stream segments into one preallocated buffer in capture order', async () => {
		const files = new Map<string, ArrayBuffer>([
			['pcm1.tmp', new Uint8Array([1, 2, 3]).buffer],
			['pcm2.tmp', new Uint8Array([4, 5, 6]).buffer],
		]);

		const result = await assembleWavFromPcmSegmentFiles(
			['pcm1.tmp', 'pcm2.tmp'],
			1,
			44100,
			buildApp(files),
		);

		expect(result.byteLength).toBe(50);
		expect(Array.from(new Uint8Array(result).slice(44))).toEqual([
			1, 2, 3, 4, 5, 6,
		]);
		const view = new DataView(result);
		expect(
			String.fromCharCode(
				view.getUint8(0),
				view.getUint8(1),
				view.getUint8(2),
				view.getUint8(3),
			),
		).toBe('RIFF');
		expect(view.getUint32(40, true)).toBe(6);
	});

	it('should fall back to read-all assembly without stat support', async () => {
		const files = new Map<string, ArrayBuffer>([
			['pcm1.tmp', new Uint8Array([1, 2]).buffer],
			['pcm2.tmp', new Uint8Array([3, 4]).buffer],
		]);

		const result = await assembleWavFromPcmSegmentFiles(
			['pcm1.tmp', 'pcm2.tmp'],
			1,
			44100,
			buildApp(files, { withStat: false }),
		);

		expect(result.byteLength).toBe(48);
		expect(Array.from(new Uint8Array(result).slice(44))).toEqual([
			1, 2, 3, 4,
		]);
	});

	it('should fall back when stat cannot report a segment size', async () => {
		const files = new Map<string, ArrayBuffer>([
			['pcm1.tmp', new Uint8Array([1, 2]).buffer],
		]);

		const result = await assembleWavFromPcmSegmentFiles(
			['pcm1.tmp'],
			1,
			44100,
			buildApp(files, {
				statSizes: new Map([['pcm1.tmp', null]]),
			}),
		);

		expect(result.byteLength).toBe(46);
	});

	it('should shrink the output and fix the header when a segment shrank', async () => {
		const files = new Map<string, ArrayBuffer>([
			['pcm1.tmp', new Uint8Array([1, 2, 3, 4]).buffer],
			['pcm2.tmp', new Uint8Array([5, 6]).buffer],
		]);

		const result = await assembleWavFromPcmSegmentFiles(
			['pcm1.tmp', 'pcm2.tmp'],
			1,
			44100,
			buildApp(files, {
				// stat believed the second segment held 4 bytes
				statSizes: new Map([['pcm2.tmp', 4]]),
			}),
		);

		expect(result.byteLength).toBe(50);
		const view = new DataView(result);
		expect(view.getUint32(40, true)).toBe(6);
	});

	it('should throw when a segment grew between stat and read', async () => {
		const files = new Map<string, ArrayBuffer>([
			['pcm1.tmp', new Uint8Array([1, 2, 3, 4]).buffer],
		]);

		await expect(
			assembleWavFromPcmSegmentFiles(
				['pcm1.tmp'],
				1,
				44100,
				buildApp(files, {
					statSizes: new Map([['pcm1.tmp', 2]]),
				}),
			),
		).rejects.toThrow('PCM segment changed during WAV assembly');
	});
});
