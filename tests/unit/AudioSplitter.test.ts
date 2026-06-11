/**
 * Unit tests for AudioSplitter module.
 * @module tests/unit/AudioSplitter.test
 */

import {
	parseWavLayout,
	splitWavBuffer,
	sliceAudioBuffer,
	computePartCount,
	computePcmPartLimitBytes,
	buildPartFileName,
	sanitizePartSuffix,
	PCM_BYTES_PER_SAMPLE,
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

describe('splitWavBuffer', () => {
	it('should split into equal parts when data is an exact multiple', () => {
		// 1000 Hz mono 16-bit: byteRate = 2000 B/s; 2 s parts = 4000 B
		const wav = buildTestWav(1, 1000, 12000);
		const layout = parseWavLayout(wav);

		const parts = splitWavBuffer(wav, layout!, 2);

		expect(parts).toHaveLength(3);
		for (const part of parts) {
			const partLayout = parseWavLayout(part);
			expect(partLayout?.dataLength).toBe(4000);
		}
	});

	it('should put the remainder into a shorter last part', () => {
		const wav = buildTestWav(1, 1000, 10000);
		const layout = parseWavLayout(wav);

		const parts = splitWavBuffer(wav, layout!, 2);

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
		const parts = splitWavBuffer(wav, layout!, 1.5);

		expect(parts).toHaveLength(3);
		for (const part of parts) {
			const partLayout = parseWavLayout(part);
			expect((partLayout?.dataLength ?? 0) % 4).toBe(0);
		}
	});

	it('should preserve the sample bytes across parts', () => {
		const wav = buildTestWav(1, 1000, 6000);
		const layout = parseWavLayout(wav);

		const parts = splitWavBuffer(wav, layout!, 1.5);

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

		const parts = splitWavBuffer(wav, layout!, 2);

		for (const part of parts) {
			const view = new DataView(part);
			expect(view.getUint32(4, true)).toBe(part.byteLength - 8);
		}
	});

	it('should return an empty array for a non-positive part size', () => {
		const wav = buildTestWav(1, 1000, 6000);
		const layout = parseWavLayout(wav);

		expect(splitWavBuffer(wav, layout!, 0)).toEqual([]);
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
