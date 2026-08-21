/**
 * Unit tests for AudioEncoder module.
 * @module tests/unit/AudioEncoder.test
 */

import {
	encodeAudioBuffer,
	isOfflineEncodingSupported,
	probeOfflineEncodingSupport,
} from 'src/audio/AudioEncoder';
import type { EncodingOptions } from 'src/audio/AudioEncoder';
import { EncodingError } from 'src/errors';
import { createMockAudioBuffer } from '../helpers/createMockAudioBuffer';
import { canEncodeAudio } from 'mediabunny';
import { registerMp3Encoder } from '@mediabunny/mp3-encoder';
import { registerFlacEncoder } from '@mediabunny/flac-encoder';

// Mock WavEncoder
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
	WavOutputFormat: jest.fn(),
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
		// Re-arm the default: the global `clearMocks` resets calls but
		// not implementations, so a test that flips this mock would
		// otherwise leak its value into the following tests
		jest.mocked(canEncodeAudio).mockResolvedValue(false);
	});

	describe('encodeAudioBuffer', () => {
		const defaultOptions: EncodingOptions = {
			format: 'webm',
			bitrate: 128000,
		};

		it('encodes WAV using Mediabunny with the pcm-s16 codec', async () => {
			const { WavOutputFormat, AudioBufferSource } =
				jest.requireMock('mediabunny');
			const buffer = createMockAudioBuffer(1, 1024, 44100);

			const result = await encodeAudioBuffer(buffer, {
				...defaultOptions,
				format: 'wav',
			});

			expect(WavOutputFormat).toHaveBeenCalledTimes(1);
			// PCM is uncompressed: no bitrate option may be passed
			expect(AudioBufferSource).toHaveBeenCalledWith({
				codec: 'pcm-s16',
			});
			expect(result).toBeInstanceOf(Blob);
			expect(result.type).toBe('audio/wav');
		});

		it('encodes MP3 using Mediabunny with the MP3 codec', async () => {
			const { Mp3OutputFormat, AudioBufferSource } =
				jest.requireMock('mediabunny');
			const buffer = createMockAudioBuffer(1, 2304, 44100);

			const result = await encodeAudioBuffer(buffer, {
				...defaultOptions,
				format: 'mp3',
				bitrate: 128000,
			});

			expect(Mp3OutputFormat).toHaveBeenCalledTimes(1);
			expect(AudioBufferSource).toHaveBeenCalledWith(
				expect.objectContaining({ codec: 'mp3', bitrate: 128000 }),
			);
			expect(result).toBeInstanceOf(Blob);
			expect(result.type).toBe('audio/mp3');
		});

		it('registers the MP3 extension encoder when not natively supported', async () => {
			jest.mocked(canEncodeAudio).mockResolvedValue(false);
			const buffer = createMockAudioBuffer(1, 2304, 44100);

			await encodeAudioBuffer(buffer, {
				...defaultOptions,
				format: 'mp3',
			});

			expect(jest.mocked(canEncodeAudio)).toHaveBeenCalledWith('mp3');
			expect(jest.mocked(registerMp3Encoder)).toHaveBeenCalledTimes(1);
		});

		it('skips MP3 encoder registration when natively supported', async () => {
			jest.mocked(canEncodeAudio).mockResolvedValue(true);
			const buffer = createMockAudioBuffer(1, 2304, 44100);

			await encodeAudioBuffer(buffer, {
				...defaultOptions,
				format: 'mp3',
			});

			expect(jest.mocked(registerMp3Encoder)).not.toHaveBeenCalled();
		});

		it('registers the FLAC extension encoder when not natively supported', async () => {
			jest.mocked(canEncodeAudio).mockResolvedValue(false);
			const buffer = createMockAudioBuffer(1, 4096, 44100);

			await encodeAudioBuffer(buffer, {
				...defaultOptions,
				format: 'flac',
			});

			expect(jest.mocked(canEncodeAudio)).toHaveBeenCalledWith('flac');
			expect(jest.mocked(registerFlacEncoder)).toHaveBeenCalledTimes(1);
		});

		it('encodes WebM using Mediabunny', async () => {
			const { Output, AudioBufferSource, WebMOutputFormat } =
				jest.requireMock('mediabunny');
			const buffer = createMockAudioBuffer(2, 4096, 48000);

			const result = await encodeAudioBuffer(buffer, {
				...defaultOptions,
				format: 'webm',
				bitrate: 128000,
			});

			expect(WebMOutputFormat).toHaveBeenCalledTimes(1);
			expect(AudioBufferSource).toHaveBeenCalledWith(
				expect.objectContaining({
					codec: 'opus',
					bitrate: 128000,
				}),
			);
			expect(Output).toHaveBeenCalledTimes(1);
			expect(mockAddAudioTrack).toHaveBeenCalledTimes(1);
			expect(mockStart).toHaveBeenCalledTimes(1);
			expect(mockAdd).toHaveBeenCalledWith(buffer);
			expect(mockFinalize).toHaveBeenCalledTimes(1);
			expect(result).toBeInstanceOf(Blob);
			expect(result.type).toBe('audio/webm');
		});

		it.each([
			{
				format: 'ogg',
				container: 'OggOutputFormat',
				codec: 'opus',
				mime: 'audio/ogg',
			},
			{
				format: 'mp4',
				container: 'Mp4OutputFormat',
				codec: 'aac',
				mime: 'audio/mp4',
			},
			{
				format: 'm4a',
				container: 'Mp4OutputFormat',
				codec: 'aac',
				mime: 'audio/m4a',
			},
			{
				format: 'aac',
				container: 'Mp4OutputFormat',
				codec: 'aac',
				mime: 'audio/aac',
			},
			{
				format: 'flac',
				container: 'FlacOutputFormat',
				codec: 'flac',
				mime: 'audio/flac',
			},
		])(
			'encodes $format into a $container as $codec',
			async ({ format, container, codec, mime }) => {
				// The container and the codec are chosen together: an mp4
				// holding opus, or an ogg holding aac, is a file the player
				// cannot open even though the encode reported success.
				const mediabunny =
					jest.requireMock<Record<string, jest.Mock>>('mediabunny');
				const buffer = createMockAudioBuffer(1, 4096, 44100);

				const result = await encodeAudioBuffer(buffer, {
					...defaultOptions,
					format,
				});

				expect(mediabunny[container]).toHaveBeenCalledTimes(1);
				expect(mediabunny['AudioBufferSource']).toHaveBeenCalledWith(
					expect.objectContaining({ codec }),
				);
				expect(result.type).toBe(mime);
			},
		);

		it('throws EncodingError for unsupported format', async () => {
			const buffer = createMockAudioBuffer(1, 1024, 44100);

			await expect(
				encodeAudioBuffer(buffer, {
					...defaultOptions,
					format: 'xyz',
				}),
			).rejects.toThrow(EncodingError);
		});

		it('calls progress callback for WAV encoding', async () => {
			const buffer = createMockAudioBuffer(1, 1024, 44100);
			const onProgress = jest.fn();

			await encodeAudioBuffer(
				buffer,
				{ ...defaultOptions, format: 'wav' },
				onProgress,
			);

			expect(onProgress).toHaveBeenCalledWith(100);
		});

		it('calls progress callback during MP3 encoding', async () => {
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

		it('calls progress callback during Mediabunny encoding', async () => {
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

		it('wraps Mediabunny errors in EncodingError', async () => {
			mockStart.mockRejectedValueOnce(new Error('Codec not supported'));
			const buffer = createMockAudioBuffer(1, 1024, 44100);

			await expect(
				encodeAudioBuffer(buffer, {
					...defaultOptions,
					format: 'webm',
				}),
			).rejects.toThrow(EncodingError);
		});

		it('wraps MP3 encoding errors in EncodingError', async () => {
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
		it('returns true for WAV', () => {
			expect(isOfflineEncodingSupported('wav')).toBe(true);
		});

		it('returns true for MP3', () => {
			expect(isOfflineEncodingSupported('mp3')).toBe(true);
		});

		it('returns true for FLAC', () => {
			expect(isOfflineEncodingSupported('flac')).toBe(true);
		});

		it('returns true for WebCodecs formats when AudioEncoder is available', () => {
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

		it('returns false for WebCodecs formats when AudioEncoder is unavailable', () => {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any -- cleaning up WebCodecs global in test
			delete (global as any).AudioEncoder;

			expect(isOfflineEncodingSupported('webm')).toBe(false);
			expect(isOfflineEncodingSupported('ogg')).toBe(false);
			expect(isOfflineEncodingSupported('mp4')).toBe(false);
			expect(isOfflineEncodingSupported('m4a')).toBe(false);
			expect(isOfflineEncodingSupported('aac')).toBe(false);
		});

		it('returns false for unknown formats', () => {
			expect(isOfflineEncodingSupported('xyz')).toBe(false);
		});
	});

	describe('probeOfflineEncodingSupport', () => {
		it('returns the real canEncodeAudio answer for a WebCodecs codec', async () => {
			jest.mocked(canEncodeAudio).mockResolvedValueOnce(true);

			await expect(probeOfflineEncodingSupport('webm')).resolves.toBe(
				true,
			);
			expect(jest.mocked(canEncodeAudio)).toHaveBeenCalledWith('opus');
		});

		it('reports false when the browser cannot encode the codec', async () => {
			// The AudioEncoder global may exist while the codec is still
			// unencodable - the probe must not be fooled by the global
			jest.mocked(canEncodeAudio).mockResolvedValue(false);

			await expect(probeOfflineEncodingSupport('m4a')).resolves.toBe(
				false,
			);
		});

		it('registers the bundled extension encoder before probing mp3', async () => {
			// Unencodable before registration, encodable after
			jest.mocked(canEncodeAudio)
				.mockResolvedValueOnce(false)
				.mockResolvedValueOnce(true);

			await expect(probeOfflineEncodingSupport('mp3')).resolves.toBe(
				true,
			);
			expect(jest.mocked(registerMp3Encoder)).toHaveBeenCalledTimes(1);
		});

		it('returns false for unknown formats without probing', async () => {
			await expect(probeOfflineEncodingSupport('xyz')).resolves.toBe(
				false,
			);
			expect(jest.mocked(canEncodeAudio)).not.toHaveBeenCalled();
		});

		it('maps a probe failure to false instead of throwing', async () => {
			jest.mocked(canEncodeAudio).mockRejectedValueOnce(
				new Error('probe exploded'),
			);

			await expect(probeOfflineEncodingSupport('ogg')).resolves.toBe(
				false,
			);
		});
	});
});
