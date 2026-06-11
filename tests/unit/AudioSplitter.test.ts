/**
 * Unit tests for AudioSplitter module.
 * @module tests/unit/AudioSplitter.test
 */

import {
	parseWavLayout,
	computeWavPartBytes,
	buildWavPart,
	sliceAudioBuffer,
	computePartCount,
	computePcmPartLimitBytes,
	buildPartFileName,
	sanitizePartSuffix,
	clampSplitMinutes,
	totalByteLength,
	detachTrailingBytes,
	PCM_BYTES_PER_SAMPLE,
	type WavLayout,
} from '../../src/recording/AudioSplitter';
import { createWavHeader } from '../../src/recording/WavEncoder';

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
		return this.channels[channel];
	}

	copyToChannel(source: Float32Array, channel: number): void {
		this.channels[channel].set(source.subarray(0, this.length));
	}
}

beforeAll(() => {
	(global as Record<string, unknown>).AudioBuffer = FakeAudioBuffer;
});

describe('parseWavLayout', () => {
	it('should parse a standard 44-byte-header WAV file', () => {
		const wav = buildTestWav(2, 44100, 1000);

		const layout = parseWavLayout(wav);

		expect(layout).not.toBeNull();
		expect(layout?.dataOffset).toBe(WAV_HEADER_SIZE);
		expect(layout?.dataLength).toBe(1000);
		expect(layout?.byteRate).toBe(44100 * 2 * 2);
		expect(layout?.blockAlign).toBe(4);
	});

	it('should parse a WAV with an extra chunk before the data chunk', () => {
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

	it('should return null for non-RIFF data', () => {
		const bytes = new Uint8Array(100).fill(0x42);

		expect(parseWavLayout(bytes.buffer)).toBeNull();
	});

	it('should return null for RIFF data that is not WAVE', () => {
		const wav = buildTestWav(1, 8000, 100);
		new Uint8Array(wav).set([0x41, 0x56, 0x49, 0x20], 8); // 'AVI '

		expect(parseWavLayout(wav)).toBeNull();
	});

	it('should return null for a buffer shorter than the RIFF header', () => {
		expect(parseWavLayout(new ArrayBuffer(8))).toBeNull();
	});

	it('should return null for compressed WAV format codes', () => {
		const wav = buildTestWav(1, 8000, 100);
		// Overwrite the fmt audioFormat field with 0x0055 (MP3)
		new DataView(wav).setUint16(20, 0x0055, true);

		expect(parseWavLayout(wav)).toBeNull();
	});

	it('should accept IEEE float format code', () => {
		const wav = buildTestWav(1, 8000, 100);
		new DataView(wav).setUint16(20, 0x0003, true);

		expect(parseWavLayout(wav)).not.toBeNull();
	});

	it('should return null for a zero byte rate', () => {
		const wav = buildTestWav(1, 8000, 100);
		new DataView(wav).setUint32(28, 0, true);

		expect(parseWavLayout(wav)).toBeNull();
	});

	it('should return null for a zero block align', () => {
		const wav = buildTestWav(1, 8000, 100);
		new DataView(wav).setUint16(32, 0, true);

		expect(parseWavLayout(wav)).toBeNull();
	});

	it('should clamp dataLength to the actual buffer size', () => {
		const wav = buildTestWav(1, 8000, 100);
		// Claim more data than the file contains
		new DataView(wav).setUint32(40, 5000, true);

		const layout = parseWavLayout(wav);

		expect(layout?.dataLength).toBe(100);
	});

	it('should return null for a truncated fmt chunk', () => {
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

	it('should return null when no data chunk exists', () => {
		// A valid header with the data chunk id overwritten
		const wav = buildTestWav(1, 8000, 0);
		new Uint8Array(wav).set([0x4c, 0x49, 0x53, 0x54], 36); // 'LIST'

		expect(parseWavLayout(wav)).toBeNull();
	});
});

describe('computeWavPartBytes', () => {
	it('should compute the part size from byteRate and duration', () => {
		// 1000 Hz mono 16-bit: byteRate = 2000 B/s; 2 s parts = 4000 B
		const wav = buildTestWav(1, 1000, 12000);
		const layout = parseWavLayout(wav);

		expect(computeWavPartBytes(layout!, 2)).toBe(4000);
	});

	it('should align the part size down to blockAlign', () => {
		const layout: WavLayout = {
			dataOffset: WAV_HEADER_SIZE,
			dataLength: 16000,
			byteRate: 4000,
			blockAlign: 4,
		};

		// 1.5005 s -> raw 6002 B, aligned down to 6000
		expect(computeWavPartBytes(layout, 1.5005)).toBe(6000);
	});

	it('should return zero for a zero duration', () => {
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
	it('should split into equal parts when data is an exact multiple', () => {
		// 1000 Hz mono 16-bit: byteRate = 2000 B/s; 2 s parts = 4000 B
		const wav = buildTestWav(1, 1000, 12000);
		const layout = parseWavLayout(wav);

		const parts = splitWav(wav, layout!, 2);

		expect(parts).toHaveLength(3);
		for (const part of parts) {
			const partLayout = parseWavLayout(part);
			expect(partLayout?.dataLength).toBe(4000);
		}
	});

	it('should put the remainder into a shorter last part', () => {
		const wav = buildTestWav(1, 1000, 10000);
		const layout = parseWavLayout(wav);

		const parts = splitWav(wav, layout!, 2);

		expect(parts).toHaveLength(3);
		expect(parseWavLayout(parts[0])?.dataLength).toBe(4000);
		expect(parseWavLayout(parts[1])?.dataLength).toBe(4000);
		expect(parseWavLayout(parts[2])?.dataLength).toBe(2000);
	});

	it('should cut on blockAlign boundaries for stereo data', () => {
		// 1000 Hz stereo 16-bit: blockAlign = 4, byteRate = 4000 B/s
		const wav = buildTestWav(2, 1000, 16000);
		const layout = parseWavLayout(wav);

		// 1.5 s -> raw 6000 B, already aligned to 4
		const parts = splitWav(wav, layout!, 1.5);

		expect(parts).toHaveLength(3);
		for (const part of parts) {
			const partLayout = parseWavLayout(part);
			expect((partLayout?.dataLength ?? 0) % 4).toBe(0);
		}
	});

	it('should preserve the sample bytes across parts', () => {
		const wav = buildTestWav(1, 1000, 6000);
		const layout = parseWavLayout(wav);

		const parts = splitWav(wav, layout!, 1.5);

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

	it('should patch the RIFF size of each part', () => {
		const wav = buildTestWav(1, 1000, 6000);
		const layout = parseWavLayout(wav);

		const parts = splitWav(wav, layout!, 2);

		for (const part of parts) {
			const view = new DataView(part);
			expect(view.getUint32(4, true)).toBe(part.byteLength - 8);
		}
	});

	it('should patch the data chunk size of each part', () => {
		const wav = buildTestWav(1, 1000, 10000);
		const layout = parseWavLayout(wav);

		const parts = splitWav(wav, layout!, 2);

		const expectedSizes = [4000, 4000, 2000];
		parts.forEach((part, index) => {
			const view = new DataView(part);
			// data chunk size field immediately precedes the sample data
			expect(view.getUint32(WAV_HEADER_SIZE - 4, true)).toBe(
				expectedSizes[index],
			);
		});
	});

	it('should copy a non-44-byte header into every part', () => {
		// Mono 8000 Hz 16-bit: byteRate = 16000 B/s; 0.0025 s parts = 40 B
		const wav = buildTestWavWithListChunk(1, 8000, 100);
		const layout = parseWavLayout(wav);
		expect(layout?.dataOffset).toBe(WAV_HEADER_SIZE + 18);

		const parts = splitWav(wav, layout!, 0.0025);

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

	it('should produce no parts for a non-positive part size', () => {
		const wav = buildTestWav(1, 1000, 6000);
		const layout = parseWavLayout(wav);

		expect(splitWav(wav, layout!, 0)).toEqual([]);
	});

	it('should build a header-only part when the index starts at the data end', () => {
		const wav = buildTestWav(1, 1000, 6000);
		const layout = parseWavLayout(wav);

		// start = 2 * 3000 = dataLength, so the part holds zero sample bytes
		const part = buildWavPart(wav, layout!, 3000, 2);

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
		const buffer = new FakeAudioBuffer({
			numberOfChannels: channels,
			length,
			sampleRate,
		}) as unknown as AudioBuffer;
		for (let ch = 0; ch < channels; ch++) {
			const data = buffer.getChannelData(ch);
			for (let i = 0; i < length; i++) {
				data[i] = (ch + 1) * i;
			}
		}
		return buffer;
	}

	it('should copy the requested sample range for all channels', () => {
		const source = buildRampBuffer(2, 100, 8000);

		const slice = sliceAudioBuffer(source, 10, 20);

		expect(slice.length).toBe(10);
		expect(slice.numberOfChannels).toBe(2);
		expect(slice.sampleRate).toBe(8000);
		expect(slice.getChannelData(0)[0]).toBe(10);
		expect(slice.getChannelData(0)[9]).toBe(19);
		expect(slice.getChannelData(1)[0]).toBe(20);
		expect(slice.getChannelData(1)[9]).toBe(38);
	});

	it('should clamp the end sample to the buffer length', () => {
		const source = buildRampBuffer(1, 50, 8000);

		const slice = sliceAudioBuffer(source, 40, 100);

		expect(slice.length).toBe(10);
		expect(slice.getChannelData(0)[9]).toBe(49);
	});

	it('should clamp a negative start sample to zero', () => {
		const source = buildRampBuffer(1, 50, 8000);

		const slice = sliceAudioBuffer(source, -10, 5);

		expect(slice.length).toBe(5);
		expect(slice.getChannelData(0)[0]).toBe(0);
	});
});

describe('computePartCount', () => {
	it('should round up to include the remainder part', () => {
		expect(computePartCount(10, 4)).toBe(3);
	});

	it('should return the exact count for multiples', () => {
		expect(computePartCount(12, 4)).toBe(3);
	});

	it('should return zero for empty input', () => {
		expect(computePartCount(0, 4)).toBe(0);
	});

	it('should return zero for a non-positive part size', () => {
		expect(computePartCount(10, 0)).toBe(0);
	});
});

describe('computePcmPartLimitBytes', () => {
	it('should compute the limit from minutes, rate, and channels', () => {
		expect(computePcmPartLimitBytes(1, 44100, 1)).toBe(
			60 * 44100 * PCM_BYTES_PER_SAMPLE,
		);
	});

	it('should scale with channel count', () => {
		expect(computePcmPartLimitBytes(2, 48000, 2)).toBe(
			2 * 60 * 48000 * 2 * PCM_BYTES_PER_SAMPLE,
		);
	});
});

describe('buildPartFileName', () => {
	it('should compose base, suffix, number, and extension', () => {
		expect(buildPartFileName('recording-2026', 'part', 3, 'webm')).toBe(
			'recording-2026-part3.webm',
		);
	});
});

describe('sanitizePartSuffix', () => {
	it('should keep a valid suffix', () => {
		expect(sanitizePartSuffix('chunk_1-a')).toBe('chunk_1-a');
	});

	it('should fall back to the default for an empty suffix', () => {
		expect(sanitizePartSuffix('')).toBe('part');
	});

	it('should fall back to the default for illegal characters', () => {
		expect(sanitizePartSuffix('pa/rt')).toBe('part');
		expect(sanitizePartSuffix('pa.rt')).toBe('part');
		expect(sanitizePartSuffix('pa rt')).toBe('part');
	});
});

describe('clampSplitMinutes', () => {
	it('should clamp values below the minimum', () => {
		expect(clampSplitMinutes(0)).toBe(1);
		expect(clampSplitMinutes(-10)).toBe(1);
	});

	it('should clamp values above the maximum', () => {
		expect(clampSplitMinutes(181)).toBe(180);
		expect(clampSplitMinutes(10000)).toBe(180);
	});

	it('should floor fractional values', () => {
		expect(clampSplitMinutes(2.9)).toBe(2);
		expect(clampSplitMinutes(15.5)).toBe(15);
	});

	it('should return the default for NaN', () => {
		expect(clampSplitMinutes(Number.NaN)).toBe(15);
	});

	it('should return the default for Infinity', () => {
		expect(clampSplitMinutes(Number.POSITIVE_INFINITY)).toBe(15);
		expect(clampSplitMinutes(Number.NEGATIVE_INFINITY)).toBe(15);
	});

	it('should pass through valid whole minutes', () => {
		expect(clampSplitMinutes(1)).toBe(1);
		expect(clampSplitMinutes(15)).toBe(15);
		expect(clampSplitMinutes(180)).toBe(180);
	});
});

describe('totalByteLength', () => {
	it('should return zero for an empty list', () => {
		expect(totalByteLength([])).toBe(0);
	});

	it('should sum the byte lengths of all buffers', () => {
		const buffers = [
			new ArrayBuffer(3),
			new ArrayBuffer(5),
			new ArrayBuffer(0),
		];

		expect(totalByteLength(buffers)).toBe(8);
	});
});

describe('detachTrailingBytes', () => {
	it('should be a no-op for zero trailing bytes', () => {
		const buffers = [buildBytes(4, 0)];

		const carry = detachTrailingBytes(buffers, 0);

		expect(carry).toEqual([]);
		expect(buffers).toHaveLength(1);
		expect(buffers[0].byteLength).toBe(4);
	});

	it('should return an empty carry for an empty list', () => {
		const buffers: ArrayBuffer[] = [];

		expect(detachTrailingBytes(buffers, 5)).toEqual([]);
		expect(buffers).toEqual([]);
	});

	it('should split inside the last buffer', () => {
		const buffers = [buildBytes(10, 0)];

		const carry = detachTrailingBytes(buffers, 4);

		expect(buffers).toHaveLength(1);
		expect([...new Uint8Array(buffers[0])]).toEqual([0, 1, 2, 3, 4, 5]);
		expect(carry).toHaveLength(1);
		expect([...new Uint8Array(carry[0])]).toEqual([6, 7, 8, 9]);
	});

	it('should detach whole buffers plus a partial one across a boundary', () => {
		const buffers = [buildBytes(4, 0), buildBytes(4, 4), buildBytes(4, 8)];

		const carry = detachTrailingBytes(buffers, 6);

		expect(buffers).toHaveLength(2);
		expect([...new Uint8Array(buffers[0])]).toEqual([0, 1, 2, 3]);
		expect([...new Uint8Array(buffers[1])]).toEqual([4, 5]);
		// Carry preserves the original byte order: partial tail, then whole buffer
		expect(carry).toHaveLength(2);
		expect([...new Uint8Array(carry[0])]).toEqual([6, 7]);
		expect([...new Uint8Array(carry[1])]).toEqual([8, 9, 10, 11]);
	});

	it('should detach everything when trailing bytes equal the total', () => {
		const first = buildBytes(3, 0);
		const second = buildBytes(5, 3);
		const buffers = [first, second];

		const carry = detachTrailingBytes(buffers, 8);

		expect(buffers).toEqual([]);
		// Whole buffers are moved by reference in their original order
		expect(carry).toEqual([first, second]);
	});

	it('should reproduce the original sequence from remainder plus carry', () => {
		const buffers = [buildBytes(7, 0), buildBytes(5, 7), buildBytes(9, 12)];
		const original = concatBytes(buffers);

		const carry = detachTrailingBytes(buffers, 11);

		expect(concatBytes(carry)).toHaveLength(11);
		expect(concatBytes([...buffers, ...carry])).toEqual(original);
	});
});
