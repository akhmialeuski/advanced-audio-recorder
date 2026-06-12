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
	Mp3OutputFormat: jest.fn(),
	canEncodeAudio: jest.fn().mockResolvedValue(false),
}));

// Mock encoder extensions (register custom encoders with mediabunny)
jest.mock('@mediabunny/flac-encoder', () => ({
	registerFlacEncoder: jest.fn(),
}));
jest.mock('@mediabunny/mp3-encoder', () => ({
	registerMp3Encoder: jest.fn(),
}));

describe('AudioEncoder', () => {
	beforeEach(() => {
		jest.clearAllMocks();
		// Re-arm the default: clearAllMocks does not reset
		// implementations, so a test that flips this mock would
		// otherwise leak its value into the following tests
		const { canEncodeAudio } = jest.requireMock('mediabunny');
		canEncodeAudio.mockResolvedValue(false);
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

		it('should encode MP3 using Mediabunny with the MP3 codec', async () => {
			const { Mp3OutputFormat, AudioBufferSource } =
				jest.requireMock('mediabunny');
			const buffer = createMockAudioBuffer(1, 2304, 44100);

			const result = await encodeAudioBuffer(buffer, {
				...defaultOptions,
				format: 'mp3',
				bitrate: 128000,
			});

			expect(Mp3OutputFormat).toHaveBeenCalled();
			expect(AudioBufferSource).toHaveBeenCalledWith(
				expect.objectContaining({ codec: 'mp3', bitrate: 128000 }),
			);
			expect(result).toBeInstanceOf(Blob);
			expect(result.type).toBe('audio/mp3');
		});

		it('should register the MP3 extension encoder when not natively supported', async () => {
			const { canEncodeAudio } = jest.requireMock('mediabunny');
			const { registerMp3Encoder } = jest.requireMock(
				'@mediabunny/mp3-encoder',
			);
			canEncodeAudio.mockResolvedValue(false);
			const buffer = createMockAudioBuffer(1, 2304, 44100);

			await encodeAudioBuffer(buffer, {
				...defaultOptions,
				format: 'mp3',
			});

			expect(canEncodeAudio).toHaveBeenCalledWith('mp3');
			expect(registerMp3Encoder).toHaveBeenCalledTimes(1);
		});

		it('should skip MP3 encoder registration when natively supported', async () => {
			const { canEncodeAudio } = jest.requireMock('mediabunny');
			const { registerMp3Encoder } = jest.requireMock(
				'@mediabunny/mp3-encoder',
			);
			canEncodeAudio.mockResolvedValue(true);
			const buffer = createMockAudioBuffer(1, 2304, 44100);

			await encodeAudioBuffer(buffer, {
				...defaultOptions,
				format: 'mp3',
			});

			expect(registerMp3Encoder).not.toHaveBeenCalled();
		});

		it('should register the FLAC extension encoder when not natively supported', async () => {
			const { canEncodeAudio } = jest.requireMock('mediabunny');
			const { registerFlacEncoder } = jest.requireMock(
				'@mediabunny/flac-encoder',
			);
			canEncodeAudio.mockResolvedValue(false);
			const buffer = createMockAudioBuffer(1, 4096, 44100);

			await encodeAudioBuffer(buffer, {
				...defaultOptions,
				format: 'flac',
			});

			expect(canEncodeAudio).toHaveBeenCalledWith('flac');
			expect(registerFlacEncoder).toHaveBeenCalledTimes(1);
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

			expect(onProgress).toHaveBeenCalledWith(10);
			expect(onProgress).toHaveBeenCalledWith(80);
			expect(onProgress).toHaveBeenCalledWith(100);
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

		it('should wrap MP3 encoding errors in EncodingError', async () => {
			mockStart.mockRejectedValueOnce(new Error('Encoding failed'));
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
			expect(getEncoderDescription('mp3')).toBe('Mediabunny MP3 Encoder');
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
