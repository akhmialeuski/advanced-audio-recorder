/**
 * Unit tests for AudioSplitter module.
 * @module tests/unit/AudioSplitter.test
 */

import {
	parseWavLayout,
	computeWavPartBytes,
	buildWavPart,
	buildWavPartRange,
	computeCutRanges,
	wavFrameOffset,
	sliceAudioBuffer,
	computePartCount,
	computePcmPartLimitBytes,
	buildPartFileName,
	sanitizePartSuffix,
	clampSplitMinutes,
	totalByteLength,
	detachTrailingBytes,
	type WavLayout,
} from 'src/recording/AudioSplitter';
import { at, defined } from '../helpers/assertions';
import { PCM_BYTES_PER_SAMPLE } from 'src/audio/pcm';
import { createWavHeader } from 'src/audio/WavEncoder';
import { partial } from '../helpers/doubles';

/** WAV header size produced by createWavHeader. */
const WAV_HEADER_SIZE = 44;

/**
 * Builds a complete WAV file with a recognizable byte pattern.
 */
function buildTestWav(
	numChannels: number,
	sampleRate: number,
	dataBytes: number,
): ArrayBuffer {
	const header = createWavHeader(numChannels, sampleRate, dataBytes);
	const wav = new Uint8Array(WAV_HEADER_SIZE + dataBytes);
	wav.set(new Uint8Array(header), 0);
	for (let i = 0; i < dataBytes; i++) {
		wav[WAV_HEADER_SIZE + i] = i % 251;
	}
	return wav.buffer;
}

/**
 * Builds a WAV with a LIST chunk between fmt and data, producing a
 * header larger than the canonical 44 bytes.
 */
function buildTestWavWithListChunk(
	numChannels: number,
	sampleRate: number,
	dataBytes: number,
): ArrayBuffer {
	const base = new Uint8Array(
		buildTestWav(numChannels, sampleRate, dataBytes),
	);
	const extraChunk = new Uint8Array(18);
	const extraView = new DataView(extraChunk.buffer);
	extraChunk.set([0x4c, 0x49, 0x53, 0x54], 0); // 'LIST'
	extraView.setUint32(4, 10, true);
	const wav = new Uint8Array(base.length + extraChunk.length);
	wav.set(base.subarray(0, 36), 0);
	wav.set(extraChunk, 36);
	wav.set(base.subarray(36), 36 + extraChunk.length);
	// Patch RIFF size for the inserted bytes
	new DataView(wav.buffer).setUint32(4, wav.length - 8, true);
	return wav.buffer;
}

/**
 * Reconstructs a full byte-level split through the lazy per-part API,
 * mirroring how production code iterates over parts one at a time.
 */
function splitWav(
	buffer: ArrayBuffer,
	layout: WavLayout,
	partDurationSec: number,
): ArrayBuffer[] {
	const partBytes = computeWavPartBytes(layout, partDurationSec);
	const partCount = computePartCount(layout.dataLength, partBytes);
	const parts: ArrayBuffer[] = [];
	for (let i = 0; i < partCount; i++) {
		parts.push(buildWavPart(buffer, layout, partBytes, i));
	}
	return parts;
}

/**
 * Creates an ArrayBuffer filled with sequential byte values from `start`.
 */
function buildBytes(length: number, start: number): ArrayBuffer {
	const bytes = new Uint8Array(length);
	for (let i = 0; i < length; i++) {
		bytes[i] = (start + i) % 256;
	}
	return bytes.buffer;
}

/**
 * Flattens a buffer list into a single array of byte values.
 */
function concatBytes(buffers: ArrayBuffer[]): number[] {
	return buffers.flatMap((buffer) => [...new Uint8Array(buffer)]);
}

/**
 * Functional AudioBuffer stand-in for jsdom, where the real
 * constructor is unavailable.
 */
class FakeAudioBuffer {
	numberOfChannels: number;
	length: number;
	sampleRate: number;
	private channels: Float32Array[];

	constructor(options: {
		numberOfChannels: number;
		length: number;
		sampleRate: number;
	}) {
		this.numberOfChannels = options.numberOfChannels;
		this.length = options.length;
		this.sampleRate = options.sampleRate;
		this.channels = Array.from(
			{ length: options.numberOfChannels },
			() => new Float32Array(options.length),
		);
	}

	get duration(): number {
		return this.length / this.sampleRate;
	}

	getChannelData(channel: number): Float32Array {
		return at(this.channels, channel);
	}

	copyToChannel(source: Float32Array, channel: number): void {
		at(this.channels, channel).set(source.subarray(0, this.length));
	}
}

beforeAll(() => {
	(global as Record<string, unknown>).AudioBuffer = FakeAudioBuffer;
});

describe('parseWavLayout', () => {
	it('parses a standard 44-byte-header WAV file', () => {
		const wav = buildTestWav(2, 44100, 1000);

		const layout = parseWavLayout(wav);

		expect(layout).not.toBeNull();
		expect(layout?.dataOffset).toBe(WAV_HEADER_SIZE);
		expect(layout?.dataLength).toBe(1000);
		expect(layout?.byteRate).toBe(44100 * 2 * 2);
		expect(layout?.blockAlign).toBe(4);
	});

	it('parses a WAV with an extra chunk before the data chunk', () => {
		const base = new Uint8Array(buildTestWav(1, 8000, 100));
		// Insert a 10-byte LIST chunk between fmt and data
		const extraChunk = new Uint8Array(18);
		const extraView = new DataView(extraChunk.buffer);
		extraChunk.set([0x4c, 0x49, 0x53, 0x54], 0); // 'LIST'
		extraView.setUint32(4, 10, true);
		const wav = new Uint8Array(base.length + extraChunk.length);
		wav.set(base.subarray(0, 36), 0);
		wav.set(extraChunk, 36);
		wav.set(base.subarray(36), 36 + extraChunk.length);
		// Patch RIFF size for the inserted bytes
		new DataView(wav.buffer).setUint32(4, wav.length - 8, true);

		const layout = parseWavLayout(wav.buffer);

		expect(layout).not.toBeNull();
		expect(layout?.dataOffset).toBe(WAV_HEADER_SIZE + extraChunk.length);
		expect(layout?.dataLength).toBe(100);
	});

	it.each([
		{
			name: 'the file is not RIFF at all',
			build: (): ArrayBuffer => new Uint8Array(100).fill(0x42).buffer,
		},
		{
			name: 'the RIFF is not a WAVE',
			build: (): ArrayBuffer => {
				const wav = buildTestWav(1, 8000, 100);
				new Uint8Array(wav).set([0x41, 0x56, 0x49, 0x20], 8); // 'AVI '
				return wav;
			},
		},
		{
			name: 'the file is shorter than the RIFF header',
			build: (): ArrayBuffer => new ArrayBuffer(8),
		},
		{
			name: 'the audio is compressed rather than PCM',
			build: (): ArrayBuffer => {
				const wav = buildTestWav(1, 8000, 100);
				// The fmt audioFormat field, set to 0x0055 (MP3)
				new DataView(wav).setUint16(20, 0x0055, true);
				return wav;
			},
		},
		{
			name: 'the byte rate is zero',
			build: (): ArrayBuffer => {
				const wav = buildTestWav(1, 8000, 100);
				new DataView(wav).setUint32(28, 0, true);
				return wav;
			},
		},
		{
			name: 'the block alignment is zero',
			build: (): ArrayBuffer => {
				const wav = buildTestWav(1, 8000, 100);
				new DataView(wav).setUint16(32, 0, true);
				return wav;
			},
		},
		{
			name: 'the fmt chunk is truncated',
			build: (): ArrayBuffer => {
				// 'RIFF<size>WAVE' + 'fmt <size=16>' with no fmt body
				const bytes = new Uint8Array(24);
				const view = new DataView(bytes.buffer);
				bytes.set([0x52, 0x49, 0x46, 0x46], 0); // 'RIFF'
				view.setUint32(4, 16, true);
				bytes.set([0x57, 0x41, 0x56, 0x45], 8); // 'WAVE'
				bytes.set([0x66, 0x6d, 0x74, 0x20], 12); // 'fmt '
				view.setUint32(16, 16, true);
				return bytes.buffer;
			},
		},
		{
			name: 'there is no data chunk',
			build: (): ArrayBuffer => {
				const wav = buildTestWav(1, 8000, 0);
				new Uint8Array(wav).set([0x4c, 0x49, 0x53, 0x54], 36); // 'LIST'
				return wav;
			},
		},
	])('refuses to split a file where $name', ({ build }) => {
		// Splitting by byte offsets is only safe on uncompressed PCM whose
		// header describes the layout; anything else has to fall back to the
		// decode-and-re-encode path rather than produce a corrupt part.
		expect(parseWavLayout(build())).toBeNull();
	});

	it('accepts IEEE float, which is uncompressed too', () => {
		const wav = buildTestWav(1, 8000, 100);
		new DataView(wav).setUint16(20, 0x0003, true);

		// The layout is what the splitter slices on, so a non-null one that
		// points nowhere would cut an empty part out of a real file.
		expect(parseWavLayout(wav)).toEqual(
			expect.objectContaining({
				dataOffset: WAV_HEADER_SIZE,
				dataLength: 100,
			}),
		);
	});

	it('returns null for a zero byte rate', () => {
		const wav = buildTestWav(1, 8000, 100);
		new DataView(wav).setUint32(28, 0, true);

		expect(parseWavLayout(wav)).toBeNull();
	});

	it('returns null for a zero block align', () => {
		const wav = buildTestWav(1, 8000, 100);
		new DataView(wav).setUint16(32, 0, true);

		expect(parseWavLayout(wav)).toBeNull();
	});

	it('clamps dataLength to the actual buffer size', () => {
		const wav = buildTestWav(1, 8000, 100);
		// Claim more data than the file contains
		new DataView(wav).setUint32(40, 5000, true);

		const layout = parseWavLayout(wav);

		expect(layout?.dataLength).toBe(100);
	});

	it('returns null for a truncated fmt chunk', () => {
		// "RIFF<size>WAVE" + "fmt <size=16>" but only 4 bytes of fmt data
		const bytes = new Uint8Array(24);
		const view = new DataView(bytes.buffer);
		bytes.set([0x52, 0x49, 0x46, 0x46], 0); // 'RIFF'
		view.setUint32(4, 16, true);
		bytes.set([0x57, 0x41, 0x56, 0x45], 8); // 'WAVE'
		bytes.set([0x66, 0x6d, 0x74, 0x20], 12); // 'fmt '
		view.setUint32(16, 16, true);

		expect(parseWavLayout(bytes.buffer)).toBeNull();
	});

	it('returns null when no data chunk exists', () => {
		// A valid header with the data chunk id overwritten
		const wav = buildTestWav(1, 8000, 0);
		new Uint8Array(wav).set([0x4c, 0x49, 0x53, 0x54], 36); // 'LIST'

		expect(parseWavLayout(wav)).toBeNull();
	});
});

describe('computeWavPartBytes', () => {
	it('computes the part size from byteRate and duration', () => {
		// 1000 Hz mono 16-bit: byteRate = 2000 B/s; 2 s parts = 4000 B
		const wav = buildTestWav(1, 1000, 12000);
		const layout = parseWavLayout(wav);

		expect(computeWavPartBytes(defined(layout), 2)).toBe(4000);
	});

	it('aligns the part size down to blockAlign', () => {
		const layout: WavLayout = {
			dataOffset: WAV_HEADER_SIZE,
			dataLength: 16000,
			byteRate: 4000,
			blockAlign: 4,
		};

		// 1.5005 s -> raw 6002 B, aligned down to 6000
		expect(computeWavPartBytes(layout, 1.5005)).toBe(6000);
	});

	it('returns zero for a zero duration', () => {
		const layout: WavLayout = {
			dataOffset: WAV_HEADER_SIZE,
			dataLength: 1000,
			byteRate: 2000,
			blockAlign: 2,
		};

		expect(computeWavPartBytes(layout, 0)).toBe(0);
	});
});

describe('buildWavPart', () => {
	it('splits into equal parts when data is an exact multiple', () => {
		// 1000 Hz mono 16-bit: byteRate = 2000 B/s; 2 s parts = 4000 B
		const wav = buildTestWav(1, 1000, 12000);
		const layout = parseWavLayout(wav);

		const parts = splitWav(wav, defined(layout), 2);

		expect(parts).toHaveLength(3);
		for (const part of parts) {
			const partLayout = parseWavLayout(part);
			expect(partLayout?.dataLength).toBe(4000);
		}
	});

	it('puts the remainder into a shorter last part', () => {
		const wav = buildTestWav(1, 1000, 10000);
		const layout = parseWavLayout(wav);

		const parts = splitWav(wav, defined(layout), 2);

		expect(parts).toHaveLength(3);
		expect(parseWavLayout(defined(parts[0]))?.dataLength).toBe(4000);
		expect(parseWavLayout(defined(parts[1]))?.dataLength).toBe(4000);
		expect(parseWavLayout(defined(parts[2]))?.dataLength).toBe(2000);
	});

	it('cuts on blockAlign boundaries for stereo data', () => {
		// 1000 Hz stereo 16-bit: blockAlign = 4, byteRate = 4000 B/s
		const wav = buildTestWav(2, 1000, 16000);
		const layout = parseWavLayout(wav);

		// 1.5 s -> raw 6000 B, already aligned to 4
		const parts = splitWav(wav, defined(layout), 1.5);

		expect(parts).toHaveLength(3);
		for (const part of parts) {
			const partLayout = parseWavLayout(part);
			expect((partLayout?.dataLength ?? 0) % 4).toBe(0);
		}
	});

	it('preserves the sample bytes across parts', () => {
		const wav = buildTestWav(1, 1000, 6000);
		const layout = parseWavLayout(wav);

		const parts = splitWav(wav, defined(layout), 1.5);

		const reassembled: number[] = [];
		for (const part of parts) {
			const partLayout = parseWavLayout(part);
			const bytes = new Uint8Array(
				part,
				partLayout!.dataOffset,
				partLayout!.dataLength,
			);
			reassembled.push(...bytes);
		}
		const original = new Uint8Array(wav, layout!.dataOffset, 6000);
		expect(reassembled).toEqual([...original]);
	});

	it('patches the RIFF size of each part', () => {
		const wav = buildTestWav(1, 1000, 6000);
		const layout = parseWavLayout(wav);

		const parts = splitWav(wav, defined(layout), 2);

		for (const part of parts) {
			const view = new DataView(part);
			expect(view.getUint32(4, true)).toBe(part.byteLength - 8);
		}
	});

	it('patches the data chunk size of each part', () => {
		const wav = buildTestWav(1, 1000, 10000);
		const layout = parseWavLayout(wav);

		const parts = splitWav(wav, defined(layout), 2);

		const expectedSizes = [4000, 4000, 2000];
		parts.forEach((part, index) => {
			const view = new DataView(part);
			// data chunk size field immediately precedes the sample data
			expect(view.getUint32(WAV_HEADER_SIZE - 4, true)).toBe(
				expectedSizes[index],
			);
		});
	});

	it('copies a non-44-byte header into every part', () => {
		// Mono 8000 Hz 16-bit: byteRate = 16000 B/s; 0.0025 s parts = 40 B
		const wav = buildTestWavWithListChunk(1, 8000, 100);
		const layout = parseWavLayout(wav);
		expect(layout?.dataOffset).toBe(WAV_HEADER_SIZE + 18);

		const parts = splitWav(wav, defined(layout), 0.0025);

		expect(parts).toHaveLength(3);
		const reassembled: number[] = [];
		for (const part of parts) {
			const partLayout = parseWavLayout(part);
			expect(partLayout?.dataOffset).toBe(layout!.dataOffset);
			reassembled.push(
				...new Uint8Array(
					part,
					partLayout!.dataOffset,
					partLayout!.dataLength,
				),
			);
		}
		const original = new Uint8Array(wav, layout!.dataOffset, 100);
		expect(reassembled).toEqual([...original]);
	});

	it('produces no parts for a non-positive part size', () => {
		const wav = buildTestWav(1, 1000, 6000);
		const layout = parseWavLayout(wav);

		expect(splitWav(wav, defined(layout), 0)).toEqual([]);
	});

	it('builds a header-only part when the index starts at the data end', () => {
		const wav = buildTestWav(1, 1000, 6000);
		const layout = parseWavLayout(wav);

		// start = 2 * 3000 = dataLength, so the part holds zero sample bytes
		const part = buildWavPart(wav, defined(layout), 3000, 2);

		expect(part.byteLength).toBe(WAV_HEADER_SIZE);
		const view = new DataView(part);
		expect(view.getUint32(4, true)).toBe(WAV_HEADER_SIZE - 8);
		expect(view.getUint32(WAV_HEADER_SIZE - 4, true)).toBe(0);
	});
});

describe('sliceAudioBuffer', () => {
	function buildRampBuffer(
		channels: number,
		length: number,
		sampleRate: number,
	): AudioBuffer {
		const buffer = partial<AudioBuffer>(
			new FakeAudioBuffer({
				numberOfChannels: channels,
				length,
				sampleRate,
			}),
		);
		for (let ch = 0; ch < channels; ch++) {
			const data = buffer.getChannelData(ch);
			for (let i = 0; i < length; i++) {
				data[i] = (ch + 1) * i;
			}
		}
		return buffer;
	}

	it('copies the requested sample range for all channels', () => {
		const source = buildRampBuffer(2, 100, 8000);

		const slice = sliceAudioBuffer(source, 10, 20);

		expect(slice).toHaveLength(10);
		expect(slice.numberOfChannels).toBe(2);
		expect(slice.sampleRate).toBe(8000);
		expect(slice.getChannelData(0)[0]).toBe(10);
		expect(slice.getChannelData(0)[9]).toBe(19);
		expect(slice.getChannelData(1)[0]).toBe(20);
		expect(slice.getChannelData(1)[9]).toBe(38);
	});

	it('clamps the end sample to the buffer length', () => {
		const source = buildRampBuffer(1, 50, 8000);

		const slice = sliceAudioBuffer(source, 40, 100);

		expect(slice).toHaveLength(10);
		expect(slice.getChannelData(0)[9]).toBe(49);
	});

	it('clamps a negative start sample to zero', () => {
		const source = buildRampBuffer(1, 50, 8000);

		const slice = sliceAudioBuffer(source, -10, 5);

		expect(slice).toHaveLength(5);
		expect(slice.getChannelData(0)[0]).toBe(0);
	});
});

describe('computePartCount', () => {
	it('rounds up to include the remainder part', () => {
		expect(computePartCount(10, 4)).toBe(3);
	});

	it('returns the exact count for multiples', () => {
		expect(computePartCount(12, 4)).toBe(3);
	});

	it('returns zero for empty input', () => {
		expect(computePartCount(0, 4)).toBe(0);
	});

	it('returns zero for a non-positive part size', () => {
		expect(computePartCount(10, 0)).toBe(0);
	});
});

describe('computePcmPartLimitBytes', () => {
	it('computes the limit from minutes, rate, and channels', () => {
		expect(computePcmPartLimitBytes(1, 44100, 1)).toBe(
			60 * 44100 * PCM_BYTES_PER_SAMPLE,
		);
	});

	it('scales with channel count', () => {
		expect(computePcmPartLimitBytes(2, 48000, 2)).toBe(
			2 * 60 * 48000 * 2 * PCM_BYTES_PER_SAMPLE,
		);
	});
});

describe('buildPartFileName', () => {
	it('composes base, suffix, number, and extension', () => {
		expect(buildPartFileName('recording-2026', 'part', 3, 'webm')).toBe(
			'recording-2026-part3.webm',
		);
	});
});

describe('sanitizePartSuffix', () => {
	it('keeps a valid suffix', () => {
		expect(sanitizePartSuffix('chunk_1-a')).toBe('chunk_1-a');
	});

	it('falls back to the default for an empty suffix', () => {
		expect(sanitizePartSuffix('')).toBe('part');
	});

	it('falls back to the default for illegal characters', () => {
		expect(sanitizePartSuffix('pa/rt')).toBe('part');
		expect(sanitizePartSuffix('pa.rt')).toBe('part');
		expect(sanitizePartSuffix('pa rt')).toBe('part');
	});
});

describe('clampSplitMinutes', () => {
	it('clamps values below the minimum', () => {
		expect(clampSplitMinutes(0)).toBe(1);
		expect(clampSplitMinutes(-10)).toBe(1);
	});

	it('clamps values above the maximum', () => {
		expect(clampSplitMinutes(181)).toBe(180);
		expect(clampSplitMinutes(10000)).toBe(180);
	});

	it('floors fractional values', () => {
		expect(clampSplitMinutes(2.9)).toBe(2);
		expect(clampSplitMinutes(15.5)).toBe(15);
	});

	it('returns the default for NaN', () => {
		expect(clampSplitMinutes(Number.NaN)).toBe(15);
	});

	it('returns the default for Infinity', () => {
		expect(clampSplitMinutes(Number.POSITIVE_INFINITY)).toBe(15);
		expect(clampSplitMinutes(Number.NEGATIVE_INFINITY)).toBe(15);
	});

	it('passes through valid whole minutes', () => {
		expect(clampSplitMinutes(1)).toBe(1);
		expect(clampSplitMinutes(15)).toBe(15);
		expect(clampSplitMinutes(180)).toBe(180);
	});
});

describe('totalByteLength', () => {
	it('returns zero for an empty list', () => {
		expect(totalByteLength([])).toBe(0);
	});

	it('sums the byte lengths of all buffers', () => {
		const buffers = [
			new ArrayBuffer(3),
			new ArrayBuffer(5),
			new ArrayBuffer(0),
		];

		expect(totalByteLength(buffers)).toBe(8);
	});
});

describe('detachTrailingBytes', () => {
	it('is a no-op for zero trailing bytes', () => {
		const buffers = [buildBytes(4, 0)];

		const carry = detachTrailingBytes(buffers, 0);

		expect(carry).toEqual([]);
		expect(buffers).toHaveLength(1);
		expect(at(buffers, 0).byteLength).toBe(4);
	});

	it('returns an empty carry for an empty list', () => {
		const buffers: ArrayBuffer[] = [];

		expect(detachTrailingBytes(buffers, 5)).toEqual([]);
		expect(buffers).toEqual([]);
	});

	it('splits inside the last buffer', () => {
		const buffers = [buildBytes(10, 0)];

		const carry = detachTrailingBytes(buffers, 4);

		expect(buffers).toHaveLength(1);
		expect([...new Uint8Array(at(buffers, 0))]).toEqual([0, 1, 2, 3, 4, 5]);
		expect(carry).toHaveLength(1);
		expect([...new Uint8Array(at(carry, 0))]).toEqual([6, 7, 8, 9]);
	});

	it('detaches whole buffers plus a partial one across a boundary', () => {
		const buffers = [buildBytes(4, 0), buildBytes(4, 4), buildBytes(4, 8)];

		const carry = detachTrailingBytes(buffers, 6);

		expect(buffers).toHaveLength(2);
		expect([...new Uint8Array(at(buffers, 0))]).toEqual([0, 1, 2, 3]);
		expect([...new Uint8Array(at(buffers, 1))]).toEqual([4, 5]);
		// Carry preserves the original byte order: partial tail, then whole buffer
		expect(carry).toHaveLength(2);
		expect([...new Uint8Array(at(carry, 0))]).toEqual([6, 7]);
		expect([...new Uint8Array(at(carry, 1))]).toEqual([8, 9, 10, 11]);
	});

	it('detaches everything when trailing bytes equal the total', () => {
		const first = buildBytes(3, 0);
		const second = buildBytes(5, 3);
		const buffers = [first, second];

		const carry = detachTrailingBytes(buffers, 8);

		expect(buffers).toEqual([]);
		// Whole buffers are moved by reference in their original order
		expect(carry).toEqual([first, second]);
	});

	it('reproduces the original sequence from remainder plus carry', () => {
		const buffers = [buildBytes(7, 0), buildBytes(5, 7), buildBytes(9, 12)];
		const original = concatBytes(buffers);

		const carry = detachTrailingBytes(buffers, 11);

		expect(concatBytes(carry)).toHaveLength(11);
		expect(concatBytes([...buffers, ...carry])).toEqual(original);
	});
});

// Chapter boundaries divide a recording into parts of different lengths, so
// the even split is the special case and the range split is the general one.
describe('cutting a WAV at arbitrary points', () => {
	/** A one-second-per-1000-bytes WAV, so a cut in seconds is easy to read. */
	function wav(): { bytes: ArrayBuffer; layout: WavLayout } {
		const bytes = buildTestWav(1, 500, 4000);
		return { bytes, layout: defined(parseWavLayout(bytes)) };
	}

	describe('the ranges a list of cut points makes', () => {
		/** Divides the test WAV at the given cuts, in seconds. */
		function ranges(
			layout: WavLayout,
			cuts: { startSeconds: number; title: string }[],
		): { start: number; end: number; title: string | null }[] {
			return computeCutRanges(
				cuts,
				wavFrameOffset(layout),
				layout.dataLength,
			).map((range) => ({
				start: range.start,
				end: range.end,
				title: range.cut?.title ?? null,
			}));
		}

		it('always starts at the beginning, whatever it was given', () => {
			const { layout } = wav();

			expect(ranges(layout, [])).toEqual([
				{ start: 0, end: 4000, title: null },
			]);
		});

		it('divides the data at each cut, carrying its title along', () => {
			const { layout } = wav();

			// 1000 bytes per second at 500 Hz, 16-bit mono
			expect(
				ranges(layout, [
					{ startSeconds: 0, title: 'Intro' },
					{ startSeconds: 1, title: 'Middle' },
					{ startSeconds: 2, title: 'End' },
				]),
			).toEqual([
				{ start: 0, end: 1000, title: 'Intro' },
				{ start: 1000, end: 2000, title: 'Middle' },
				{ start: 2000, end: 4000, title: 'End' },
			]);
		});

		it('names no chapter for the audio before the first one', () => {
			// Naming that part after the first chapter would label it with
			// somebody else's title
			const { layout } = wav();

			expect(
				ranges(layout, [{ startSeconds: 2, title: 'Late' }]),
			).toEqual([
				{ start: 0, end: 2000, title: null },
				{ start: 2000, end: 4000, title: 'Late' },
			]);
		});

		it('sorts the cuts, so the parts come out in order', () => {
			const { layout } = wav();

			expect(
				ranges(layout, [
					{ startSeconds: 2, title: 'Second' },
					{ startSeconds: 1, title: 'First' },
				]).map((r) => r.title),
			).toEqual([null, 'First', 'Second']);
		});

		it('aligns a cut down to a whole frame', () => {
			// A part starting mid-frame plays as noise, with the channels
			// swapped for its whole length
			const bytes = buildTestWav(2, 500, 4000);
			const layout = defined(parseWavLayout(bytes));

			// blockAlign is 4 here, so 1001 bytes rounds down to 1000
			expect(
				ranges(layout, [{ startSeconds: 0.5005, title: 'Half' }]).map(
					(r) => r.start,
				),
			).toEqual([0, 1000]);
		});

		it.each([
			{ case: 'a cut at the end', seconds: 4 },
			{ case: 'a cut past the end', seconds: 99 },
		])('ignores $case, which divides nothing', ({ seconds }) => {
			const { layout } = wav();

			expect(
				ranges(layout, [{ startSeconds: seconds, title: 'Nowhere' }]),
			).toEqual([{ start: 0, end: 4000, title: null }]);
		});

		it('treats a cut before the start as one at the start', () => {
			// Clamped rather than dropped, so a chapter at a negative offset
			// still names the part it plainly opens
			const { layout } = wav();

			expect(
				ranges(layout, [{ startSeconds: -5, title: 'Intro' }]),
			).toEqual([{ start: 0, end: 4000, title: 'Intro' }]);
		});

		it('keeps the first of two cuts that land on the same frame', () => {
			const { layout } = wav();

			expect(
				ranges(layout, [
					{ startSeconds: 1, title: 'First' },
					{ startSeconds: 1, title: 'Second' },
				]),
			).toEqual([
				{ start: 0, end: 1000, title: null },
				{ start: 1000, end: 4000, title: 'First' },
			]);
		});
	});

	describe('the part a byte range builds', () => {
		it('carries the samples of its own range', () => {
			const { bytes, layout } = wav();

			const part = buildWavPartRange(bytes, layout, 1000, 2000);

			expect(part.byteLength).toBe(layout.dataOffset + 1000);
			expect(new Uint8Array(part, layout.dataOffset, 4)).toEqual(
				new Uint8Array(bytes, layout.dataOffset + 1000, 4),
			);
		});

		it('stamps its own length into the header, not the original one', () => {
			const { bytes, layout } = wav();

			const view = new DataView(
				buildWavPartRange(bytes, layout, 0, 1000),
			);

			expect(view.getUint32(layout.dataOffset - 4, true)).toBe(1000);
			expect(view.getUint32(4, true)).toBe(layout.dataOffset + 1000 - 8);
		});

		it('yields the tail for a range that runs past the end', () => {
			const { bytes, layout } = wav();

			expect(
				buildWavPartRange(bytes, layout, 3000, 99999).byteLength,
			).toBe(layout.dataOffset + 1000);
		});

		it('yields a header alone for a range that is not a range', () => {
			const { bytes, layout } = wav();

			expect(
				buildWavPartRange(bytes, layout, 2000, 1000).byteLength,
			).toBe(layout.dataOffset);
		});

		it('builds the same part the even split builds, which is one range', () => {
			const { bytes, layout } = wav();

			expect(
				new Uint8Array(buildWavPart(bytes, layout, 1000, 2)),
			).toEqual(
				new Uint8Array(buildWavPartRange(bytes, layout, 2000, 3000)),
			);
		});
	});
});
