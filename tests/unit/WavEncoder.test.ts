/**
 * Unit tests for WavEncoder module.
 * @module tests/unit/WavEncoder.test
 */
/** @jest-environment jsdom */

import { bufferToWave, getWavHeaderInfo } from '../../src/recording/WavEncoder';

describe('WavEncoder', () => {
    describe('bufferToWave', () => {
        it('should create a valid WAV blob from mono AudioBuffer', () => {
            // Create a mock AudioBuffer
            const sampleRate = 44100;
            const length = 1024;
            const numberOfChannels = 1;

            const audioBuffer = createMockAudioBuffer(numberOfChannels, length, sampleRate);

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

            const audioBuffer = createMockAudioBuffer(numberOfChannels, length, sampleRate);

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
            channelData[0] = 2.0;  // Should be clamped to 1.0
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
    sampleRate: number
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
