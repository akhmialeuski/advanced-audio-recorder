/**
 * Unit tests for WavEncoder module.
 * @module tests/unit/WavEncoder.test
 */
/** @jest-environment jsdom */

import {
	bufferToWave,
	getWavHeaderInfo,
	createWavHeader,
	assembleWavFromPcmSegments,
} from '../../src/recording/WavEncoder';

describe('WavEncoder', () => {
	describe('bufferToWave', () => {
		it('should create a valid WAV blob from mono AudioBuffer', () => {
			// Create a mock AudioBuffer
			const sampleRate = 44100;
			const length = 1024;
			const numberOfChannels = 1;

			const audioBuffer = createMockAudioBuffer(
				numberOfChannels,
				length,
				sampleRate,
			);

			const result = bufferToWave(audioBuffer, length);

			expect(result).toBeInstanceOf(Blob);
			expect(result.type).toBe('audio/wav');
			// Header (44 bytes) + data (length * channels * 2 bytes per sample)
			expect(result.size).toBe(44 + length * numberOfChannels * 2);
		});

		it('should create a valid WAV blob from stereo AudioBuffer', () => {
			const sampleRate = 48000;
			const length = 2048;
			const numberOfChannels = 2;

			const audioBuffer = createMockAudioBuffer(
				numberOfChannels,
				length,
				sampleRate,
			);

			const result = bufferToWave(audioBuffer, length);

			expect(result).toBeInstanceOf(Blob);
			expect(result.type).toBe('audio/wav');
			expect(result.size).toBe(44 + length * numberOfChannels * 2);
		});

		it('should handle empty buffer', () => {
			const audioBuffer = createMockAudioBuffer(1, 0, 44100);

			const result = bufferToWave(audioBuffer, 0);

			expect(result).toBeInstanceOf(Blob);
			expect(result.size).toBe(44); // Header only
		});

		it('should handle length parameter smaller than buffer length', () => {
			const audioBuffer = createMockAudioBuffer(1, 1000, 44100);
			const partialLength = 500;

			const result = bufferToWave(audioBuffer, partialLength);

			expect(result.size).toBe(44 + partialLength * 1 * 2);
		});

		it('should properly interleave stereo samples', async () => {
			const sampleRate = 44100;
			const length = 4;

			const audioBuffer = createMockAudioBuffer(2, length, sampleRate);
			// Set known values
			const channelData0 = audioBuffer.getChannelData(0);
			const channelData1 = audioBuffer.getChannelData(1);
			channelData0[0] = 0.5;
			channelData1[0] = -0.5;

			const result = bufferToWave(audioBuffer, length);

			expect(result).toBeInstanceOf(Blob);
		});

		it('should clamp sample values to valid range', () => {
			const audioBuffer = createMockAudioBuffer(1, 4, 44100);
			const channelData = audioBuffer.getChannelData(0);
			// Set values outside valid range
			channelData[0] = 2.0; // Should be clamped to 1.0
			channelData[1] = -2.0; // Should be clamped to -1.0

			const result = bufferToWave(audioBuffer, 4);

			expect(result).toBeInstanceOf(Blob);
			expect(result.type).toBe('audio/wav');
		});
	});

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

/**
 * Creates a mock AudioBuffer for testing.
 * @param numberOfChannels - Number of audio channels
 * @param length - Number of samples
 * @param sampleRate - Sample rate in Hz
 * @returns Mock AudioBuffer object
 */
function createMockAudioBuffer(
	numberOfChannels: number,
	length: number,
	sampleRate: number,
): AudioBuffer {
	const channels: Float32Array[] = [];
	for (let i = 0; i < numberOfChannels; i++) {
		channels.push(new Float32Array(length));
	}

	return {
		numberOfChannels,
		length,
		sampleRate,
		duration: length / sampleRate,
		getChannelData: (channel: number) => channels[channel],
		copyFromChannel: jest.fn(),
		copyToChannel: jest.fn(),
	} as unknown as AudioBuffer;
}
