/**
 * Unit tests for WavEncoder module.
 * @module tests/unit/WavEncoder.test
 */

import type { App } from 'obsidian';
import {
	getWavHeaderInfo,
	createWavHeader,
	createWavFileBuffer,
	assembleWavFromPcmSegments,
	assembleWavFromPcmSegmentFiles,
	wavHeaderSize,
	wavMaxPcmBytes,
	WAV_MAX_PCM_BYTES,
	WAV_SIZE_LIMIT_MESSAGE,
} from 'src/audio/WavEncoder';
import { PcmSampleFormat } from 'src/audio/pcm';
import { createMockApp } from '../helpers/createApp';

/** Reads a four-character chunk id at an offset. */
function chunkId(view: DataView, offset: number): string {
	return String.fromCharCode(
		view.getUint8(offset),
		view.getUint8(offset + 1),
		view.getUint8(offset + 2),
		view.getUint8(offset + 3),
	);
}

describe('WavEncoder', () => {
	describe('getWavHeaderInfo', () => {
		it('calculates correct header info for mono audio', () => {
			const info = getWavHeaderInfo(1, 44100, 1000);

			expect(info.headerSize).toBe(44);
			expect(info.totalSize).toBe(1044);
			expect(info.byteRate).toBe(88200); // 44100 * 2 * 1
		});

		it('calculates correct header info for stereo audio', () => {
			const info = getWavHeaderInfo(2, 48000, 5000);

			expect(info.headerSize).toBe(44);
			expect(info.totalSize).toBe(5044);
			expect(info.byteRate).toBe(192000); // 48000 * 2 * 2
		});

		it('handles different sample rates', () => {
			const rates = [8000, 16000, 22050, 44100, 48000, 96000];

			rates.forEach((rate) => {
				const info = getWavHeaderInfo(1, rate, 0);
				expect(info.byteRate).toBe(rate * 2);
			});
		});
	});
});

describe('createWavHeader', () => {
	it('creates a 44-byte WAV header', () => {
		const header = createWavHeader(1, 44100, 1000);

		expect(header.byteLength).toBe(44);
	});

	it('contains valid RIFF/WAVE markers', () => {
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

	it('sets correct file size in RIFF header', () => {
		const pcmDataLength = 5000;
		const header = createWavHeader(1, 44100, pcmDataLength);
		const view = new DataView(header);

		// RIFF chunk size = file size - 8
		expect(view.getUint32(4, true)).toBe(44 - 8 + pcmDataLength);
	});

	it('sets correct audio format fields for mono', () => {
		const header = createWavHeader(1, 44100, 1000);
		const view = new DataView(header);

		expect(view.getUint16(20, true)).toBe(1); // PCM format
		expect(view.getUint16(22, true)).toBe(1); // 1 channel
		expect(view.getUint32(24, true)).toBe(44100); // sample rate
		expect(view.getUint32(28, true)).toBe(88200); // byte rate: 44100 * 1 * 2
		expect(view.getUint16(32, true)).toBe(2); // block align: 1 * 2
		expect(view.getUint16(34, true)).toBe(16); // bits per sample
	});

	it('sets correct audio format fields for stereo', () => {
		const header = createWavHeader(2, 48000, 2000);
		const view = new DataView(header);

		expect(view.getUint16(22, true)).toBe(2); // 2 channels
		expect(view.getUint32(24, true)).toBe(48000); // sample rate
		expect(view.getUint32(28, true)).toBe(192000); // byte rate: 48000 * 2 * 2
		expect(view.getUint16(32, true)).toBe(4); // block align: 2 * 2
	});

	it('sets correct data subchunk size', () => {
		const pcmDataLength = 8800;
		const header = createWavHeader(1, 44100, pcmDataLength);
		const view = new DataView(header);

		expect(view.getUint32(40, true)).toBe(pcmDataLength);
	});
});

describe('assembleWavFromPcmSegments', () => {
	it('assembles WAV from single segment', () => {
		const pcmData = new Int16Array([100, -100, 200, -200]).buffer;
		const result = assembleWavFromPcmSegments([pcmData], 1, 44100);

		expect(result.byteLength).toBe(44 + pcmData.byteLength);
	});

	it('assembles WAV from multiple segments', () => {
		const seg1 = new Int16Array([100, -100]).buffer;
		const seg2 = new Int16Array([200, -200]).buffer;
		const seg3 = new Int16Array([300, -300]).buffer;

		const result = assembleWavFromPcmSegments([seg1, seg2, seg3], 1, 44100);

		const totalPcm = seg1.byteLength + seg2.byteLength + seg3.byteLength;
		expect(result.byteLength).toBe(44 + totalPcm);
	});

	it('preserves PCM data in correct order', () => {
		const seg1 = new Int16Array([1000, 2000]).buffer;
		const seg2 = new Int16Array([3000, 4000]).buffer;

		const result = assembleWavFromPcmSegments([seg1, seg2], 1, 44100);

		const int16View = new Int16Array(result, 44);
		expect(int16View[0]).toBe(1000);
		expect(int16View[1]).toBe(2000);
		expect(int16View[2]).toBe(3000);
		expect(int16View[3]).toBe(4000);
	});

	it('writes correct WAV header for assembled data', () => {
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

	it('handles empty segments array', () => {
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
		// The shared App double always carries a `stat`, so the
		// no-stat-support path needs the key explicitly blanked out.
		adapter.stat = undefined;
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
		return createMockApp({ vault: { adapter } }).app;
	};

	it('streams segments into one preallocated buffer in capture order', async () => {
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

	it('falls back to read-all assembly without stat support', async () => {
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

	it('falls back when stat cannot report a segment size', async () => {
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

	it('shrinks the output and fix the header when a segment shrank', async () => {
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

	// The refusal has to come from the size check rather than from the
	// allocation: 4 GB is past what the engine hands out, so an unguarded run
	// fails here too, with an error naming neither the cause nor the way out.
	it('refuses segments that together outgrow the container', async () => {
		const files = new Map<string, ArrayBuffer>([
			['pcm1.tmp', new Uint8Array([1, 2]).buffer],
		]);

		await expect(
			assembleWavFromPcmSegmentFiles(
				['pcm1.tmp'],
				2,
				48000,
				buildApp(files, {
					statSizes: new Map([['pcm1.tmp', WAV_MAX_PCM_BYTES + 1]]),
				}),
			),
		).rejects.toThrow(/cannot exceed 4 GB/);
	});

	it('throws when a segment grew between stat and read', async () => {
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

// A WAV states its size twice in 32-bit fields, so the format has a ceiling
// no header can describe past. Before the check, both ways of hitting it lost
// the recording at its last step: setUint32 wrapped the number round and wrote
// a file players read as truncated, or the allocation threw after the capture
// had already stopped.
describe('the WAV container ceiling', () => {
	it('describes the largest payload the size fields can hold', () => {
		const header = createWavHeader(2, 48000, WAV_MAX_PCM_BYTES);

		const view = new DataView(header);
		expect(view.getUint32(4, true)).toBe(0xffffffff);
		expect(view.getUint32(40, true)).toBe(WAV_MAX_PCM_BYTES);
	});

	it('refuses a payload one byte past the size fields', () => {
		expect(() => createWavHeader(2, 48000, WAV_MAX_PCM_BYTES + 1)).toThrow(
			/cannot exceed 4 GB/,
		);
	});

	it('names auto-split as the way to record past the ceiling', () => {
		expect(() => createWavHeader(2, 48000, WAV_MAX_PCM_BYTES + 1)).toThrow(
			/auto-split/,
		);
	});

	// Recovery reads the very segments that survive, but it assembles through
	// this module and meets this refusal again, so offering it as the way to
	// the audio sends the user round a loop that ends where it started. What
	// survives is worth saying; what cannot rescue it is not.
	it('does not offer recovery as the way past the ceiling', () => {
		expect(WAV_SIZE_LIMIT_MESSAGE).toMatch(/kept as raw segments/);
		expect(WAV_SIZE_LIMIT_MESSAGE).not.toMatch(/recover/i);
	});

	it('refuses an over-size file buffer before allocating it', () => {
		expect(() =>
			createWavFileBuffer(2, 48000, WAV_MAX_PCM_BYTES + 1),
		).toThrow(/cannot exceed 4 GB/);
	});

	it('refuses over-size segments read whole without stat support', () => {
		const oversize = [{ byteLength: WAV_MAX_PCM_BYTES + 1 } as ArrayBuffer];

		expect(() => assembleWavFromPcmSegments(oversize, 2, 48000)).toThrow(
			/cannot exceed 4 GB/,
		);
	});
});

// The header is what tells every reader - a player, a splitter, a
// transcription engine - how wide a sample is and how to interpret it. It is
// the one place the choice of representation becomes a property of the file
// rather than of the plugin, so each is checked field by field.
describe('the header of each representation', () => {
	it.each([
		[PcmSampleFormat.Int16, 44, 16, 1, 2, 4],
		[PcmSampleFormat.Int24, 44, 24, 1, 3, 6],
		[PcmSampleFormat.Float32, 58, 32, 3, 4, 8],
	])(
		'states width, tag, rate and block align for %s',
		(format, headerBytes, bits, tag, width, blockAlign) => {
			const header = createWavHeader(2, 48000, 1200, format);
			const view = new DataView(header);

			expect(header.byteLength).toBe(headerBytes);
			expect(wavHeaderSize(format)).toBe(headerBytes);
			expect(view.getUint16(20, true)).toBe(tag);
			expect(view.getUint16(22, true)).toBe(2);
			expect(view.getUint32(24, true)).toBe(48000);
			expect(view.getUint32(28, true)).toBe(48000 * blockAlign);
			expect(view.getUint16(32, true)).toBe(blockAlign);
			expect(view.getUint16(34, true)).toBe(bits);
			expect(blockAlign).toBe(2 * width);
		},
	);

	it.each([PcmSampleFormat.Int16, PcmSampleFormat.Int24])(
		'leaves the %s header at the canonical 44 bytes with no fact chunk',
		(format) => {
			const view = new DataView(createWavHeader(1, 44100, 800, format));

			expect(view.getUint32(16, true)).toBe(16);
			expect(chunkId(view, 36)).toBe('data');
			expect(view.getUint32(40, true)).toBe(800);
		},
	);

	// The WAVE specification counts floating point samples as a non-PCM
	// representation, which has to carry the cbSize field and state its length
	// a second time in a fact chunk. A reader that takes the length from there
	// otherwise reads the file as empty.
	it('gives the floating point header its cbSize and fact chunk', () => {
		const frames = 150;
		const pcmBytes = frames * 2 * 4;
		const view = new DataView(
			createWavHeader(2, 48000, pcmBytes, PcmSampleFormat.Float32),
		);

		expect(view.getUint32(16, true)).toBe(18);
		expect(view.getUint16(36, true)).toBe(0);
		expect(chunkId(view, 38)).toBe('fact');
		expect(view.getUint32(42, true)).toBe(4);
		expect(view.getUint32(46, true)).toBe(frames);
		expect(chunkId(view, 50)).toBe('data');
		expect(view.getUint32(54, true)).toBe(pcmBytes);
	});

	it.each([
		[PcmSampleFormat.Int16, 44],
		[PcmSampleFormat.Int24, 44],
		[PcmSampleFormat.Float32, 58],
	])(
		'sizes a %s file buffer as header plus payload',
		(format, headerBytes) => {
			const buffer = createWavFileBuffer(1, 44100, 900, format);

			expect(buffer.byteLength).toBe(headerBytes + 900);
		},
	);

	it.each([
		[PcmSampleFormat.Int16, 2],
		[PcmSampleFormat.Int24, 3],
		[PcmSampleFormat.Float32, 4],
	])('assembles %s segments behind their own header', (format, width) => {
		const segment = new ArrayBuffer(12 * width);

		const wav = assembleWavFromPcmSegments(
			[segment, segment],
			1,
			44100,
			format,
		);

		expect(wav.byteLength).toBe(wavHeaderSize(format) + 24 * width);
		expect(new DataView(wav).getUint16(34, true)).toBe(
			format === PcmSampleFormat.Int16 ? 16 : width * 8,
		);
	});

	// Every caller that predates the choice of width asks without naming one,
	// and has to keep getting the canonical header it has always written.
	it('answers for the sixteen-bit representation when none is named', () => {
		expect(wavHeaderSize()).toBe(44);
		expect(wavMaxPcmBytes()).toBe(WAV_MAX_PCM_BYTES);
	});

	// mixLayout answers a set of no tracks with no channels at all, and a
	// header built from that answer has no frame size to count frames with.
	it('states a zero frame count for a header with no channels', () => {
		const view = new DataView(
			createWavHeader(0, 0, 0, PcmSampleFormat.Float32),
		);

		expect(view.getUint16(32, true)).toBe(0);
		expect(view.getUint32(46, true)).toBe(0);
	});

	// A longer header leaves correspondingly less room under the same 32-bit
	// size field, and a payload sized to the shorter one would overflow it.
	it('takes the floating point header out of the payload ceiling', () => {
		expect(wavMaxPcmBytes(PcmSampleFormat.Float32)).toBe(
			WAV_MAX_PCM_BYTES - 14,
		);
		expect(() =>
			createWavHeader(
				2,
				48000,
				wavMaxPcmBytes(PcmSampleFormat.Float32) + 1,
				PcmSampleFormat.Float32,
			),
		).toThrow(/cannot exceed 4 GB/);
	});
});
