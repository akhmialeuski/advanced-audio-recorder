/**
 * Unit tests for AudioEncoder module.
 * @module tests/unit/AudioEncoder.test
 */
/** @jest-environment jsdom */

import {
	encodeAudioBuffer,
	isOfflineEncodingSupported,
	getEncoderDescription,
} from '../../src/recording/AudioEncoder';
import type { EncodingOptions } from '../../src/recording/AudioEncoder';
import { EncodingError } from '../../src/errors';
import { createMockAudioBuffer } from '../helpers/createMockAudioBuffer';

// Mock WavEncoder
jest.mock('../../src/recording/WavEncoder', () => ({
	bufferToWave: jest
		.fn()
		.mockReturnValue(new Blob(['wav-data'], { type: 'audio/wav' })),
}));

// Mock mediabunny
const mockAdd = jest.fn().mockResolvedValue(undefined);
const mockStart = jest.fn().mockResolvedValue(undefined);
const mockFinalize = jest.fn().mockResolvedValue(undefined);
const mockAddAudioTrack = jest.fn();
const mockBuffer = new ArrayBuffer(100);

jest.mock('mediabunny', () => ({
	Output: jest.fn().mockImplementation(() => ({
		addAudioTrack: mockAddAudioTrack,
		start: mockStart,
		finalize: mockFinalize,
		target: { buffer: mockBuffer },
	})),
	BufferTarget: jest.fn().mockImplementation(() => ({
		buffer: mockBuffer,
	})),
	AudioBufferSource: jest.fn().mockImplementation(() => ({
		add: mockAdd,
	})),
	Mp4OutputFormat: jest.fn(),
	WebMOutputFormat: jest.fn(),
	OggOutputFormat: jest.fn(),
	FlacOutputFormat: jest.fn(),
}));

// Mock @mediabunny/flac-encoder (side-effect only import)
jest.mock('@mediabunny/flac-encoder', () => ({}));

// Mock lamejs
const mockEncodeBuffer = jest.fn().mockReturnValue(new Int8Array([1, 2, 3]));
const mockFlush = jest.fn().mockReturnValue(new Int8Array([4, 5]));

jest.mock('lamejs', () => ({
	Mp3Encoder: jest.fn().mockImplementation(() => ({
		encodeBuffer: mockEncodeBuffer,
		flush: mockFlush,
	})),
}));

describe('AudioEncoder', () => {
	beforeEach(() => {
		jest.clearAllMocks();
	});

	describe('encodeAudioBuffer', () => {
		const defaultOptions: EncodingOptions = {
			format: 'webm',
			bitrate: 128000,
		};

		it('should delegate WAV encoding to bufferToWave', async () => {
			const { bufferToWave } = jest.requireMock(
				'../../src/recording/WavEncoder',
			);
			const buffer = createMockAudioBuffer(1, 1024, 44100);

			const result = await encodeAudioBuffer(buffer, {
				...defaultOptions,
				format: 'wav',
			});

			expect(bufferToWave).toHaveBeenCalledWith(buffer, buffer.length);
			expect(result).toBeInstanceOf(Blob);
			expect(result.type).toBe('audio/wav');
		});

		it('should encode MP3 using lamejs', async () => {
			const { Mp3Encoder } = jest.requireMock('lamejs');
			const buffer = createMockAudioBuffer(1, 2304, 44100);

			const result = await encodeAudioBuffer(buffer, {
				...defaultOptions,
				format: 'mp3',
				bitrate: 128000,
			});

			expect(Mp3Encoder).toHaveBeenCalledWith(1, 44100, 128);
			expect(mockEncodeBuffer).toHaveBeenCalled();
			expect(mockFlush).toHaveBeenCalled();
			expect(result).toBeInstanceOf(Blob);
			expect(result.type).toBe('audio/mp3');
		});

		it('should encode stereo MP3 with both channels', async () => {
			const buffer = createMockAudioBuffer(2, 2304, 44100);

			await encodeAudioBuffer(buffer, {
				...defaultOptions,
				format: 'mp3',
			});

			// Should pass right channel to encodeBuffer
			expect(mockEncodeBuffer).toHaveBeenCalledWith(
				expect.any(Int16Array),
				expect.any(Int16Array),
			);
		});

		it('should encode WebM using Mediabunny', async () => {
			const { Output, AudioBufferSource, WebMOutputFormat } =
				jest.requireMock('mediabunny');
			const buffer = createMockAudioBuffer(2, 4096, 48000);

			const result = await encodeAudioBuffer(buffer, {
				...defaultOptions,
				format: 'webm',
				bitrate: 128000,
			});

			expect(WebMOutputFormat).toHaveBeenCalled();
			expect(AudioBufferSource).toHaveBeenCalledWith(
				expect.objectContaining({
					codec: 'opus',
					bitrate: 128000,
				}),
			);
			expect(Output).toHaveBeenCalled();
			expect(mockAddAudioTrack).toHaveBeenCalled();
			expect(mockStart).toHaveBeenCalled();
			expect(mockAdd).toHaveBeenCalledWith(buffer);
			expect(mockFinalize).toHaveBeenCalled();
			expect(result).toBeInstanceOf(Blob);
			expect(result.type).toBe('audio/webm');
		});

		it('should encode OGG using Mediabunny with Opus codec', async () => {
			const { OggOutputFormat, AudioBufferSource } =
				jest.requireMock('mediabunny');
			const buffer = createMockAudioBuffer(1, 4096, 44100);

			const result = await encodeAudioBuffer(buffer, {
				...defaultOptions,
				format: 'ogg',
			});

			expect(OggOutputFormat).toHaveBeenCalled();
			expect(AudioBufferSource).toHaveBeenCalledWith(
				expect.objectContaining({ codec: 'opus' }),
			);
			expect(result.type).toBe('audio/ogg');
		});

		it('should encode MP4 using Mediabunny with AAC codec', async () => {
			const { Mp4OutputFormat, AudioBufferSource } =
				jest.requireMock('mediabunny');
			const buffer = createMockAudioBuffer(2, 4096, 44100);

			const result = await encodeAudioBuffer(buffer, {
				...defaultOptions,
				format: 'mp4',
			});

			expect(Mp4OutputFormat).toHaveBeenCalled();
			expect(AudioBufferSource).toHaveBeenCalledWith(
				expect.objectContaining({ codec: 'aac' }),
			);
			expect(result.type).toBe('audio/mp4');
		});

		it('should encode M4A using Mp4OutputFormat with AAC codec', async () => {
			const { Mp4OutputFormat, AudioBufferSource } =
				jest.requireMock('mediabunny');
			const buffer = createMockAudioBuffer(1, 4096, 44100);

			const result = await encodeAudioBuffer(buffer, {
				...defaultOptions,
				format: 'm4a',
			});

			expect(Mp4OutputFormat).toHaveBeenCalled();
			expect(AudioBufferSource).toHaveBeenCalledWith(
				expect.objectContaining({ codec: 'aac' }),
			);
			expect(result.type).toBe('audio/m4a');
		});

		it('should encode AAC using Mp4OutputFormat', async () => {
			const { Mp4OutputFormat } = jest.requireMock('mediabunny');
			const buffer = createMockAudioBuffer(1, 4096, 44100);

			const result = await encodeAudioBuffer(buffer, {
				...defaultOptions,
				format: 'aac',
			});

			expect(Mp4OutputFormat).toHaveBeenCalled();
			expect(result.type).toBe('audio/aac');
		});

		it('should encode FLAC using FlacOutputFormat', async () => {
			const { FlacOutputFormat, AudioBufferSource } =
				jest.requireMock('mediabunny');
			const buffer = createMockAudioBuffer(1, 4096, 44100);

			const result = await encodeAudioBuffer(buffer, {
				...defaultOptions,
				format: 'flac',
			});

			expect(FlacOutputFormat).toHaveBeenCalled();
			expect(AudioBufferSource).toHaveBeenCalledWith(
				expect.objectContaining({ codec: 'flac' }),
			);
			expect(result.type).toBe('audio/flac');
		});

		it('should throw EncodingError for unsupported format', async () => {
			const buffer = createMockAudioBuffer(1, 1024, 44100);

			await expect(
				encodeAudioBuffer(buffer, {
					...defaultOptions,
					format: 'xyz',
				}),
			).rejects.toThrow(EncodingError);
		});

		it('should call progress callback for WAV encoding', async () => {
			const buffer = createMockAudioBuffer(1, 1024, 44100);
			const onProgress = jest.fn();

			await encodeAudioBuffer(
				buffer,
				{ ...defaultOptions, format: 'wav' },
				onProgress,
			);

			expect(onProgress).toHaveBeenCalledWith(100);
		});

		it('should call progress callback during MP3 encoding', async () => {
			const buffer = createMockAudioBuffer(1, 2304, 44100);
			const onProgress = jest.fn();

			await encodeAudioBuffer(
				buffer,
				{ ...defaultOptions, format: 'mp3' },
				onProgress,
			);

			expect(onProgress).toHaveBeenCalled();
			const lastCall =
				onProgress.mock.calls[onProgress.mock.calls.length - 1];
			expect(lastCall[0]).toBe(100);
		});

		it('should call progress callback during Mediabunny encoding', async () => {
			const buffer = createMockAudioBuffer(1, 4096, 44100);
			const onProgress = jest.fn();

			await encodeAudioBuffer(
				buffer,
				{ ...defaultOptions, format: 'webm' },
				onProgress,
			);

			expect(onProgress).toHaveBeenCalledWith(10);
			expect(onProgress).toHaveBeenCalledWith(80);
			expect(onProgress).toHaveBeenCalledWith(100);
		});

		it('should wrap Mediabunny errors in EncodingError', async () => {
			mockStart.mockRejectedValueOnce(new Error('Codec not supported'));
			const buffer = createMockAudioBuffer(1, 1024, 44100);

			await expect(
				encodeAudioBuffer(buffer, {
					...defaultOptions,
					format: 'webm',
				}),
			).rejects.toThrow(EncodingError);
		});

		it('should wrap lamejs errors in EncodingError', async () => {
			mockEncodeBuffer.mockImplementationOnce(() => {
				throw new Error('Encoding failed');
			});
			const buffer = createMockAudioBuffer(1, 2304, 44100);

			await expect(
				encodeAudioBuffer(buffer, {
					...defaultOptions,
					format: 'mp3',
				}),
			).rejects.toThrow(EncodingError);
		});
	});

	describe('isOfflineEncodingSupported', () => {
		it('should return true for WAV', () => {
			expect(isOfflineEncodingSupported('wav')).toBe(true);
		});

		it('should return true for MP3', () => {
			expect(isOfflineEncodingSupported('mp3')).toBe(true);
		});

		it('should return true for FLAC', () => {
			expect(isOfflineEncodingSupported('flac')).toBe(true);
		});

		it('should return true for WebCodecs formats when AudioEncoder is available', () => {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any -- simulating WebCodecs global in test
			(global as any).AudioEncoder = jest.fn();

			expect(isOfflineEncodingSupported('webm')).toBe(true);
			expect(isOfflineEncodingSupported('ogg')).toBe(true);
			expect(isOfflineEncodingSupported('mp4')).toBe(true);
			expect(isOfflineEncodingSupported('m4a')).toBe(true);
			expect(isOfflineEncodingSupported('aac')).toBe(true);

			// eslint-disable-next-line @typescript-eslint/no-explicit-any -- cleaning up WebCodecs global in test
			delete (global as any).AudioEncoder;
		});

		it('should return false for WebCodecs formats when AudioEncoder is unavailable', () => {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any -- cleaning up WebCodecs global in test
			delete (global as any).AudioEncoder;

			expect(isOfflineEncodingSupported('webm')).toBe(false);
			expect(isOfflineEncodingSupported('ogg')).toBe(false);
			expect(isOfflineEncodingSupported('mp4')).toBe(false);
			expect(isOfflineEncodingSupported('m4a')).toBe(false);
			expect(isOfflineEncodingSupported('aac')).toBe(false);
		});

		it('should return false for unknown formats', () => {
			expect(isOfflineEncodingSupported('xyz')).toBe(false);
		});
	});

	describe('getEncoderDescription', () => {
		it('should return correct description for WAV', () => {
			expect(getEncoderDescription('wav')).toBe('PCM (built-in)');
		});

		it('should return correct description for WebM', () => {
			expect(getEncoderDescription('webm')).toBe(
				'AudioEncoder (Opus) + Mediabunny',
			);
		});

		it('should return correct description for OGG', () => {
			expect(getEncoderDescription('ogg')).toBe(
				'AudioEncoder (Opus) + Mediabunny',
			);
		});

		it('should return correct description for MP4/M4A/AAC', () => {
			expect(getEncoderDescription('mp4')).toBe(
				'AudioEncoder (AAC) + Mediabunny',
			);
			expect(getEncoderDescription('m4a')).toBe(
				'AudioEncoder (AAC) + Mediabunny',
			);
			expect(getEncoderDescription('aac')).toBe(
				'AudioEncoder (AAC) + Mediabunny',
			);
		});

		it('should return correct description for MP3', () => {
			expect(getEncoderDescription('mp3')).toBe('lamejs (MP3)');
		});

		it('should return correct description for FLAC', () => {
			expect(getEncoderDescription('flac')).toBe(
				'Mediabunny FLAC Encoder',
			);
		});

		it('should return Unknown for unsupported formats', () => {
			expect(getEncoderDescription('xyz')).toBe('Unknown');
		});
	});
});
