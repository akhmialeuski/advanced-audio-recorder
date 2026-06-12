/**
 * Unit tests for AudioFormatConverter module.
 * Tests format resolution, blob conversion, offline encoding, and track merging.
 * @module tests/unit/AudioFormatConverter.test
 */
/** @jest-environment jsdom */

import type { AudioRecorderSettings } from '../../src/settings/Settings';
import { DEFAULT_SETTINGS } from '../../src/settings/Settings';
import type { RecordingTarget } from '../../src/types';

// Mock obsidian module
jest.mock('obsidian', () => ({
	normalizePath: (path: string) => path.replace(/\\/g, '/'),
}));

// Mock AudioEncoder module
jest.mock('../../src/recording/AudioEncoder', () => ({
	encodeAudioBuffer: jest
		.fn()
		.mockResolvedValue(new Blob(['encoded'], { type: 'audio/mp4' })),
	isOfflineEncodingSupported: jest.fn((format: string) => {
		return [
			'wav',
			'webm',
			'ogg',
			'mp4',
			'm4a',
			'aac',
			'flac',
			'mp3',
		].includes(format);
	}),
	ensureEncoderRegistered: jest.fn().mockResolvedValue(undefined),
	createOutputFormat: jest.fn().mockReturnValue({}),
	FORMAT_CODEC_MAP: {
		webm: 'opus',
		ogg: 'opus',
		mp4: 'aac',
		m4a: 'aac',
		aac: 'aac',
		flac: 'flac',
		mp3: 'mp3',
		wav: 'pcm-s16',
	},
}));

// Mock mediabunny Conversion pipeline
const mockConversionExecute = jest.fn().mockResolvedValue(undefined);
const mockConversionInit = jest.fn();
const mockGetPrimaryAudioTrack = jest.fn();
const mockConvertedBuffer = new ArrayBuffer(64);

jest.mock('mediabunny', () => ({
	Input: jest.fn().mockImplementation(() => ({
		getPrimaryAudioTrack: (): unknown => mockGetPrimaryAudioTrack(),
	})),
	Output: jest.fn().mockImplementation(() => ({})),
	BlobSource: jest.fn(),
	BufferTarget: jest.fn().mockImplementation(() => ({
		buffer: mockConvertedBuffer,
	})),
	ALL_FORMATS: [],
	Conversion: {
		init: (...args: unknown[]): unknown => mockConversionInit(...args),
	},
}));

// Mock AudioBuffer shape used across tests
const createMockAudioBuffer = (
	overrides?: Partial<{
		duration: number;
		length: number;
		sampleRate: number;
		numberOfChannels: number;
	}>,
) => ({
	duration: overrides?.duration ?? 1,
	length: overrides?.length ?? 44100,
	sampleRate: overrides?.sampleRate ?? 44100,
	numberOfChannels: overrides?.numberOfChannels ?? 1,
	getChannelData: jest.fn().mockReturnValue(new Float32Array(44100)),
});

// Mock AudioContext
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- required for global mock
(global as any).AudioContext = jest.fn().mockImplementation(() => ({
	decodeAudioData: jest.fn().mockResolvedValue(createMockAudioBuffer()),
	createBufferSource: jest.fn().mockImplementation(() => ({
		connect: jest.fn(),
		start: jest.fn(),
		buffer: null,
	})),
	destination: {},
	close: jest.fn().mockResolvedValue(undefined),
	sampleRate: 44100,
}));

// Mock OfflineAudioContext
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- required for global mock
(global as any).OfflineAudioContext = jest.fn().mockImplementation(() => ({
	decodeAudioData: jest.fn().mockResolvedValue(createMockAudioBuffer()),
	createBufferSource: jest.fn().mockImplementation(() => ({
		connect: jest.fn(),
		start: jest.fn(),
		buffer: null,
	})),
	startRendering: jest.fn().mockResolvedValue(createMockAudioBuffer()),
	destination: {},
}));

// Polyfill Blob.prototype.arrayBuffer for jsdom
if (!Blob.prototype.arrayBuffer) {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test polyfill for jsdom
	(Blob.prototype as any).arrayBuffer = function (): Promise<ArrayBuffer> {
		return Promise.resolve(new ArrayBuffer(0));
	};
}

// Mock MediaRecorder.isTypeSupported — default: support webm and ogg
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- required for global mock
(global as any).MediaRecorder = {
	isTypeSupported: jest.fn((mime: string) => {
		return mime === 'audio/webm' || mime === 'audio/ogg';
	}),
};

import {
	resolveRecorderFormat,
	isOfflineOnlyFormat,
	convertBlobToWav,
	convertBlobToFormat,
	decodeAudioBlob,
	buildOutputBlob,
	mergeAudioTracks,
} from '../../src/recording/AudioFormatConverter';

describe('AudioFormatConverter', () => {
	beforeEach(() => {
		jest.clearAllMocks();

		// Reset MediaRecorder.isTypeSupported to default
		(MediaRecorder.isTypeSupported as jest.Mock).mockImplementation(
			(mime: string) => mime === 'audio/webm' || mime === 'audio/ogg',
		);

		// Default: streaming conversion succeeds, fresh instance per call
		mockConversionInit.mockImplementation(() =>
			Promise.resolve({
				execute: mockConversionExecute,
				onProgress: undefined,
				isValid: true,
				discardedTracks: [],
			}),
		);

		// Default input track: opus audio, the typical intermediate
		// recording codec
		mockGetPrimaryAudioTrack.mockResolvedValue({
			getCodec: jest.fn().mockResolvedValue('opus'),
			isAudioTrack: (): boolean => true,
		});
	});

	// ---------------------------------------------------------------
	// resolveRecorderFormat
	// ---------------------------------------------------------------
	describe('resolveRecorderFormat', () => {
		it('should return native format when MediaRecorder supports it', () => {
			const settings: AudioRecorderSettings = {
				...DEFAULT_SETTINGS,
				recordingFormat: 'webm',
			};
			const result = resolveRecorderFormat(settings);
			expect(result).toEqual({
				recorderFormat: 'webm',
				mimeType: 'audio/webm',
			});
		});

		it('should return native format for OGG when supported', () => {
			const settings: AudioRecorderSettings = {
				...DEFAULT_SETTINGS,
				recordingFormat: 'ogg',
			};
			const result = resolveRecorderFormat(settings);
			expect(result).toEqual({
				recorderFormat: 'ogg',
				mimeType: 'audio/ogg',
			});
		});

		it('should fall back to WebM when native format is not supported', () => {
			const settings: AudioRecorderSettings = {
				...DEFAULT_SETTINGS,
				recordingFormat: 'mp4',
			};
			// mp4 not supported natively, but webm is
			(MediaRecorder.isTypeSupported as jest.Mock).mockImplementation(
				(mime: string) => mime === 'audio/webm',
			);
			const result = resolveRecorderFormat(settings);
			expect(result).toEqual({
				recorderFormat: 'webm',
				mimeType: 'audio/webm',
			});
		});

		it('should fall back to OGG when WebM is not supported', () => {
			const settings: AudioRecorderSettings = {
				...DEFAULT_SETTINGS,
				recordingFormat: 'mp4',
			};
			(MediaRecorder.isTypeSupported as jest.Mock).mockImplementation(
				(mime: string) => mime === 'audio/ogg',
			);
			const result = resolveRecorderFormat(settings);
			expect(result).toEqual({
				recorderFormat: 'ogg',
				mimeType: 'audio/ogg',
			});
		});

		it('should always use intermediate format for WAV (never native)', () => {
			const settings: AudioRecorderSettings = {
				...DEFAULT_SETTINGS,
				recordingFormat: 'wav',
			};
			const result = resolveRecorderFormat(settings);
			// WAV always falls through to intermediate compressed format
			expect(result.recorderFormat).toBe('webm');
			expect(result.mimeType).toBe('audio/webm');
		});

		it('should throw when neither WebM nor OGG is supported', () => {
			const settings: AudioRecorderSettings = {
				...DEFAULT_SETTINGS,
				recordingFormat: 'mp4',
			};
			(MediaRecorder.isTypeSupported as jest.Mock).mockReturnValue(false);
			expect(() => resolveRecorderFormat(settings)).toThrow(
				/neither WebM nor OGG is supported/,
			);
		});

		it('should treat format case-insensitively', () => {
			const settings: AudioRecorderSettings = {
				...DEFAULT_SETTINGS,
				recordingFormat: 'WEBM',
			};
			const result = resolveRecorderFormat(settings);
			expect(result).toEqual({
				recorderFormat: 'webm',
				mimeType: 'audio/webm',
			});
		});
	});

	// ---------------------------------------------------------------
	// isOfflineOnlyFormat
	// ---------------------------------------------------------------
	describe('isOfflineOnlyFormat', () => {
		it('should return true when format differs from recorder format and supports offline encoding', () => {
			// mp4 is offline-encodable and recorder uses webm
			expect(isOfflineOnlyFormat('mp4', 'webm')).toBe(true);
		});

		it('should return true for mp3 with webm recorder', () => {
			expect(isOfflineOnlyFormat('mp3', 'webm')).toBe(true);
		});

		it('should return true for flac with ogg recorder', () => {
			expect(isOfflineOnlyFormat('flac', 'ogg')).toBe(true);
		});

		it('should return true for aac with webm recorder', () => {
			expect(isOfflineOnlyFormat('aac', 'webm')).toBe(true);
		});

		it('should return true for m4a with webm recorder', () => {
			expect(isOfflineOnlyFormat('m4a', 'webm')).toBe(true);
		});

		it('should return false when format matches recorder format', () => {
			expect(isOfflineOnlyFormat('webm', 'webm')).toBe(false);
		});

		it('should return false for wav (always handled separately)', () => {
			expect(isOfflineOnlyFormat('wav', 'webm')).toBe(false);
		});

		it('should return false when format is not offline-encoding-supported', () => {
			const { isOfflineEncodingSupported } = jest.requireMock(
				'../../src/recording/AudioEncoder',
			);
			isOfflineEncodingSupported.mockReturnValueOnce(false);
			expect(isOfflineOnlyFormat('unknownformat', 'webm')).toBe(false);
		});
	});

	// ---------------------------------------------------------------
	// convertBlobToWav
	// ---------------------------------------------------------------
	describe('convertBlobToWav', () => {
		it('should convert through the streaming pipeline to a WAV blob', async () => {
			const inputBlob = new Blob(['audio-data'], { type: 'audio/webm' });
			const result = await convertBlobToWav(inputBlob);

			expect(mockConversionInit).toHaveBeenCalledWith(
				expect.objectContaining({
					// PCM is uncompressed: no bitrate option may be passed
					audio: { codec: 'pcm-s16' },
				}),
			);
			expect(result).toBeInstanceOf(Blob);
			expect(result.type).toBe('audio/wav');
		});

		it('should fall back to decode-and-encode when streaming fails', async () => {
			const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
			mockConversionInit.mockRejectedValueOnce(
				new Error('unreadable container'),
			);
			const { encodeAudioBuffer } = jest.requireMock(
				'../../src/recording/AudioEncoder',
			);

			const inputBlob = new Blob(['audio-data'], { type: 'audio/webm' });
			await convertBlobToWav(inputBlob);

			expect(encodeAudioBuffer).toHaveBeenCalledWith(
				expect.objectContaining({ sampleRate: 44100 }),
				expect.objectContaining({ format: 'wav' }),
				undefined,
			);
			warnSpy.mockRestore();
		});
	});

	// ---------------------------------------------------------------
	// decodeAudioBlob
	// ---------------------------------------------------------------
	describe('decodeAudioBlob', () => {
		it('should decode exactly once and close the context', async () => {
			const buffer = new ArrayBuffer(8);
			await decodeAudioBlob(buffer);

			expect(AudioContext).toHaveBeenCalledTimes(1);
			const ctx = (AudioContext as unknown as jest.Mock).mock.results[0]
				.value;
			expect(ctx.decodeAudioData).toHaveBeenCalledTimes(1);
			expect(ctx.close).toHaveBeenCalledTimes(1);
			// No second decode through an OfflineAudioContext
			expect(OfflineAudioContext).not.toHaveBeenCalled();
		});

		it('should close the context when decoding fails', async () => {
			const decodeError = new Error('decode failed');
			// eslint-disable-next-line @typescript-eslint/no-explicit-any -- required for mock override
			(AudioContext as any).mockImplementationOnce(() => ({
				decodeAudioData: jest.fn().mockRejectedValue(decodeError),
				close: jest.fn().mockResolvedValue(undefined),
			}));

			await expect(decodeAudioBlob(new ArrayBuffer(8))).rejects.toThrow(
				'decode failed',
			);

			// The AudioContext must not leak on corrupted input
			const ctx = (AudioContext as unknown as jest.Mock).mock.results[0]
				.value;
			expect(ctx.close).toHaveBeenCalledTimes(1);
		});
	});

	// ---------------------------------------------------------------
	// convertBlobToFormat
	// ---------------------------------------------------------------
	describe('convertBlobToFormat', () => {
		it('should convert via the streaming Conversion pipeline', async () => {
			const { encodeAudioBuffer } = jest.requireMock(
				'../../src/recording/AudioEncoder',
			);
			const blob = new Blob(['test'], { type: 'audio/webm' });

			const result = await convertBlobToFormat(blob, 'mp4', 128000);

			expect(mockConversionInit).toHaveBeenCalledWith(
				expect.objectContaining({
					audio: { codec: 'aac', bitrate: 128000 },
					// Discarded tracks are handled by the plugin, so
					// mediabunny's own console warnings are disabled
					showWarnings: false,
				}),
			);
			expect(mockConversionExecute).toHaveBeenCalledTimes(1);
			expect(result).toBeInstanceOf(Blob);
			expect(result.type).toBe('audio/mp4');
			// The streaming path never materializes the full PCM
			expect(AudioContext).not.toHaveBeenCalled();
			expect(encodeAudioBuffer).not.toHaveBeenCalled();
		});

		it('should register the extension encoder before converting', async () => {
			const { ensureEncoderRegistered } = jest.requireMock(
				'../../src/recording/AudioEncoder',
			);
			const blob = new Blob(['test'], { type: 'audio/webm' });

			await convertBlobToFormat(blob, 'mp3', 192000);

			expect(ensureEncoderRegistered).toHaveBeenCalledWith('mp3');
		});

		it('should report whole-percent progress from the conversion', async () => {
			const progressFn = jest.fn();
			const blob = new Blob(['test'], { type: 'audio/webm' });

			await convertBlobToFormat(blob, 'mp4', 128000, progressFn);

			const instance = (await mockConversionInit.mock.results[0]
				.value) as {
				onProgress?: (progress: number) => void;
			};
			expect(instance.onProgress).toBeDefined();

			instance.onProgress!(0.5);
			expect(progressFn).toHaveBeenCalledWith(50);

			// Same whole percent is deduplicated
			instance.onProgress!(0.504);
			expect(progressFn).toHaveBeenCalledTimes(1);

			instance.onProgress!(1);
			expect(progressFn).toHaveBeenCalledWith(100);
		});

		it('should remux without bitrate when the codecs match and remux is allowed', async () => {
			const blob = new Blob(['test'], { type: 'audio/webm' });

			// Input track is opus (default mock); ogg targets opus too.
			// The recording pipeline opts in: its intermediate blob is
			// already encoded at the requested bitrate.
			await convertBlobToFormat(blob, 'ogg', 128000, undefined, {
				allowRemux: true,
			});

			expect(mockConversionInit).toHaveBeenCalledWith(
				expect.objectContaining({
					audio: { codec: 'opus' },
					showWarnings: false,
				}),
			);
			expect(mockConversionExecute).toHaveBeenCalledTimes(1);
		});

		it('should re-encode at the requested bitrate when remux is not allowed', async () => {
			const blob = new Blob(['test'], { type: 'audio/webm' });

			// Matching codecs (opus input, ogg target), but without the
			// remux opt-in the explicitly requested bitrate must be
			// honored: manual conversions let the user pick it
			await convertBlobToFormat(blob, 'ogg', 64000);

			expect(mockConversionInit).toHaveBeenCalledWith(
				expect.objectContaining({
					audio: { codec: 'opus', bitrate: 64000 },
				}),
			);
			expect(mockConversionExecute).toHaveBeenCalledTimes(1);
		});

		it('should fall back when the audio track is discarded', async () => {
			const { encodeAudioBuffer } = jest.requireMock(
				'../../src/recording/AudioEncoder',
			);
			// Conversion.init does not throw for codec problems: the
			// track is discarded and the output would contain no audio
			mockConversionInit.mockImplementationOnce(() =>
				Promise.resolve({
					execute: mockConversionExecute,
					isValid: true,
					discardedTracks: [
						{
							track: { isAudioTrack: (): boolean => true },
							reason: 'no_encodable_target_codec',
						},
					],
				}),
			);
			const warnSpy = jest
				.spyOn(console, 'warn')
				.mockImplementation(() => undefined);
			const blob = new Blob(['test'], { type: 'audio/webm' });

			await convertBlobToFormat(blob, 'mp4', 128000);

			expect(mockConversionExecute).not.toHaveBeenCalled();
			expect(encodeAudioBuffer).toHaveBeenCalledWith(
				expect.anything(),
				{ format: 'mp4', bitrate: 128000 },
				undefined,
			);
			expect(warnSpy).toHaveBeenCalled();
			warnSpy.mockRestore();
		});

		it('should ignore discarded non-audio tracks', async () => {
			// A video track in the source container is legitimately
			// dropped when converting to an audio-only format
			mockConversionInit.mockImplementationOnce(() =>
				Promise.resolve({
					execute: mockConversionExecute,
					isValid: true,
					discardedTracks: [
						{
							track: { isAudioTrack: (): boolean => false },
							reason: 'max_track_count_of_type_reached',
						},
					],
				}),
			);
			const blob = new Blob(['test'], { type: 'audio/mp4' });

			const result = await convertBlobToFormat(blob, 'mp3', 192000);

			expect(mockConversionExecute).toHaveBeenCalledTimes(1);
			expect(result.type).toBe('audio/mp3');
		});

		it('should fall back when the conversion is invalid', async () => {
			const { encodeAudioBuffer } = jest.requireMock(
				'../../src/recording/AudioEncoder',
			);
			mockConversionInit.mockImplementationOnce(() =>
				Promise.resolve({
					execute: mockConversionExecute,
					isValid: false,
					discardedTracks: [],
				}),
			);
			const warnSpy = jest
				.spyOn(console, 'warn')
				.mockImplementation(() => undefined);
			const blob = new Blob(['test'], { type: 'audio/webm' });

			await convertBlobToFormat(blob, 'aac', 256000);

			expect(mockConversionExecute).not.toHaveBeenCalled();
			expect(encodeAudioBuffer).toHaveBeenCalled();
			warnSpy.mockRestore();
		});

		it('should fall back when the input has no audio track', async () => {
			const { encodeAudioBuffer } = jest.requireMock(
				'../../src/recording/AudioEncoder',
			);
			mockGetPrimaryAudioTrack.mockResolvedValueOnce(null);
			const warnSpy = jest
				.spyOn(console, 'warn')
				.mockImplementation(() => undefined);
			const blob = new Blob(['test'], { type: 'audio/webm' });

			await convertBlobToFormat(blob, 'mp4', 128000);

			expect(mockConversionInit).not.toHaveBeenCalled();
			expect(encodeAudioBuffer).toHaveBeenCalled();
			warnSpy.mockRestore();
		});

		it('should fall back to decode and re-encode when conversion fails', async () => {
			const { encodeAudioBuffer } = jest.requireMock(
				'../../src/recording/AudioEncoder',
			);
			mockConversionInit.mockRejectedValueOnce(
				new Error('unreadable container'),
			);
			const warnSpy = jest
				.spyOn(console, 'warn')
				.mockImplementation(() => undefined);
			const blob = new Blob(['test'], { type: 'audio/webm' });

			const result = await convertBlobToFormat(blob, 'mp4', 128000);

			expect(result).toBeInstanceOf(Blob);
			expect(AudioContext).toHaveBeenCalledTimes(1);
			expect(encodeAudioBuffer).toHaveBeenCalledWith(
				expect.objectContaining({ sampleRate: 44100 }),
				{ format: 'mp4', bitrate: 128000 },
				undefined,
			);
			expect(warnSpy).toHaveBeenCalled();
			warnSpy.mockRestore();
		});

		it('should fall back when the conversion produces empty output', async () => {
			const { encodeAudioBuffer } = jest.requireMock(
				'../../src/recording/AudioEncoder',
			);
			const { BufferTarget } = jest.requireMock('mediabunny');
			BufferTarget.mockImplementationOnce(() => ({ buffer: null }));
			const warnSpy = jest
				.spyOn(console, 'warn')
				.mockImplementation(() => undefined);
			const blob = new Blob(['test'], { type: 'audio/webm' });

			await convertBlobToFormat(blob, 'aac', 256000);

			expect(encodeAudioBuffer).toHaveBeenCalledWith(
				expect.anything(),
				{ format: 'aac', bitrate: 256000 },
				undefined,
			);
			warnSpy.mockRestore();
		});

		it('should forward onProgress to the fallback encoder', async () => {
			mockConversionInit.mockRejectedValueOnce(new Error('boom'));
			const warnSpy = jest
				.spyOn(console, 'warn')
				.mockImplementation(() => undefined);
			const progressFn = jest.fn();
			const blob = new Blob(['test'], { type: 'audio/webm' });

			await convertBlobToFormat(blob, 'mp4', 128000, progressFn);

			const { encodeAudioBuffer } = jest.requireMock(
				'../../src/recording/AudioEncoder',
			);
			expect(encodeAudioBuffer).toHaveBeenCalledWith(
				expect.anything(),
				{ format: 'mp4', bitrate: 128000 },
				progressFn,
			);
			warnSpy.mockRestore();
		});
	});

	// ---------------------------------------------------------------
	// buildOutputBlob
	// ---------------------------------------------------------------
	describe('buildOutputBlob', () => {
		it('should return raw blob for non-WAV format', async () => {
			const chunks = [
				new Blob(['chunk1'], { type: 'audio/webm' }),
				new Blob(['chunk2'], { type: 'audio/webm' }),
			];
			const result = await buildOutputBlob(chunks, 'audio/webm', 'webm');
			expect(result.type).toBe('audio/webm');
		});

		it('should combine multiple chunks into a single blob', async () => {
			const chunks = [
				new Blob(['chunk1'], { type: 'audio/ogg' }),
				new Blob(['chunk2'], { type: 'audio/ogg' }),
			];
			const result = await buildOutputBlob(chunks, 'audio/ogg', 'ogg');
			// Blob should have the combined size
			expect(result.size).toBe(chunks[0].size + chunks[1].size);
		});

		it('should convert to WAV when recording format is wav', async () => {
			const chunks = [new Blob(['audio-data'], { type: 'audio/webm' })];
			const result = await buildOutputBlob(chunks, 'audio/webm', 'wav');

			expect(mockConversionInit).toHaveBeenCalledTimes(1);
			expect(result.type).toBe('audio/wav');
		});

		it('should not convert to WAV for mp4 format', async () => {
			const chunks = [new Blob(['data'], { type: 'audio/mp4' })];
			await buildOutputBlob(chunks, 'audio/mp4', 'mp4');
			expect(mockConversionInit).not.toHaveBeenCalled();
		});

		it('should handle empty chunks array for non-WAV', async () => {
			const result = await buildOutputBlob([], 'audio/webm', 'webm');
			expect(result.size).toBe(0);
			expect(result.type).toBe('audio/webm');
		});
	});

	// ---------------------------------------------------------------
	// mergeAudioTracks
	// ---------------------------------------------------------------
	describe('mergeAudioTracks', () => {
		const createMockTarget = (name: string): RecordingTarget => ({
			fileBaseName: name,
			sourceName: name,
			bufferedChunks: [],
			bufferedBytes: 0,
			segmentIndex: 0,
			segmentPaths: [],
			pendingWrite: Promise.resolve(),
			pcmBuffers: [],
			pcmBufferedBytes: 0,
			pcmChannels: 1,
			pcmSampleRate: 44100,
		});

		it('should merge multiple tracks using buildTrackBlob', async () => {
			const targets = [
				createMockTarget('track1'),
				createMockTarget('track2'),
			];
			const buildPcmTrackWavBlob = jest.fn();
			const buildTrackBlob = jest
				.fn()
				.mockResolvedValue(new Blob(['audio'], { type: 'audio/webm' }));

			const settings: AudioRecorderSettings = {
				...DEFAULT_SETTINGS,
				recordingFormat: 'mp4',
				bitrate: 128000,
			};

			const result = await mergeAudioTracks(
				targets,
				settings,
				false,
				buildPcmTrackWavBlob,
				buildTrackBlob,
			);

			expect(buildTrackBlob).toHaveBeenCalledTimes(2);
			expect(buildPcmTrackWavBlob).not.toHaveBeenCalled();
			expect(result).toBeInstanceOf(Blob);
		});

		it('should merge multiple tracks using buildPcmTrackWavBlob for WAV PCM recordings', async () => {
			const targets = [
				createMockTarget('track1'),
				createMockTarget('track2'),
			];
			const buildPcmTrackWavBlob = jest
				.fn()
				.mockResolvedValue(
					new Blob(['pcm-wav'], { type: 'audio/wav' }),
				);
			const buildTrackBlob = jest.fn();

			const settings: AudioRecorderSettings = {
				...DEFAULT_SETTINGS,
				recordingFormat: 'wav',
				bitrate: 128000,
			};

			await mergeAudioTracks(
				targets,
				settings,
				true,
				buildPcmTrackWavBlob,
				buildTrackBlob,
			);

			expect(buildPcmTrackWavBlob).toHaveBeenCalledTimes(2);
			expect(buildTrackBlob).not.toHaveBeenCalled();
		});

		it('should encode merged result for offline-encodable formats', async () => {
			const { encodeAudioBuffer } = jest.requireMock(
				'../../src/recording/AudioEncoder',
			);
			const targets = [createMockTarget('track1')];
			const buildTrackBlob = jest
				.fn()
				.mockResolvedValue(new Blob(['audio'], { type: 'audio/webm' }));

			const settings: AudioRecorderSettings = {
				...DEFAULT_SETTINGS,
				recordingFormat: 'mp4',
				bitrate: 128000,
			};

			await mergeAudioTracks(
				targets,
				settings,
				false,
				jest.fn(),
				buildTrackBlob,
			);

			expect(encodeAudioBuffer).toHaveBeenCalledTimes(1);
			expect(encodeAudioBuffer).toHaveBeenCalledWith(
				expect.objectContaining({ sampleRate: 44100 }),
				{ format: 'mp4', bitrate: 128000 },
				expect.any(Function),
			);
		});

		it('should encode the mix as WAV when format is wav', async () => {
			const { encodeAudioBuffer } = jest.requireMock(
				'../../src/recording/AudioEncoder',
			);
			const targets = [createMockTarget('track1')];
			const buildTrackBlob = jest
				.fn()
				.mockResolvedValue(new Blob(['audio'], { type: 'audio/webm' }));

			const settings: AudioRecorderSettings = {
				...DEFAULT_SETTINGS,
				recordingFormat: 'wav',
				bitrate: 128000,
			};

			await mergeAudioTracks(
				targets,
				settings,
				false,
				jest.fn(),
				buildTrackBlob,
			);

			expect(encodeAudioBuffer).toHaveBeenCalledWith(
				expect.objectContaining({ sampleRate: 44100 }),
				{ format: 'wav', bitrate: 128000 },
				expect.any(Function),
			);
		});

		it('should throw when no audio data is recorded (all blobs null)', async () => {
			const targets = [createMockTarget('track1')];
			const buildTrackBlob = jest.fn().mockResolvedValue(null);

			const settings: AudioRecorderSettings = {
				...DEFAULT_SETTINGS,
				recordingFormat: 'webm',
			};

			await expect(
				mergeAudioTracks(
					targets,
					settings,
					false,
					jest.fn(),
					buildTrackBlob,
				),
			).rejects.toThrow('No audio data recorded');
		});

		it('should close the AudioContext when no audio data is recorded', async () => {
			const targets = [createMockTarget('track1')];
			const buildTrackBlob = jest.fn().mockResolvedValue(null);

			await expect(
				mergeAudioTracks(
					targets,
					{ ...DEFAULT_SETTINGS, recordingFormat: 'webm' },
					false,
					jest.fn(),
					buildTrackBlob,
				),
			).rejects.toThrow('No audio data recorded');

			const contextInstance = (
				global.AudioContext as unknown as jest.Mock
			).mock.results[0].value as { close: jest.Mock };
			expect(contextInstance.close).toHaveBeenCalled();
		});

		it('should close the AudioContext when decoding fails', async () => {
			(
				global.AudioContext as unknown as jest.Mock
			).mockImplementationOnce(() => ({
				decodeAudioData: jest
					.fn()
					.mockRejectedValue(new Error('corrupted track')),
				destination: {},
				close: jest.fn().mockResolvedValue(undefined),
				sampleRate: 44100,
			}));
			const targets = [createMockTarget('track1')];
			const buildTrackBlob = jest
				.fn()
				.mockResolvedValue(new Blob(['audio'], { type: 'audio/webm' }));

			await expect(
				mergeAudioTracks(
					targets,
					{ ...DEFAULT_SETTINGS, recordingFormat: 'webm' },
					false,
					jest.fn(),
					buildTrackBlob,
				),
			).rejects.toThrow('corrupted track');

			const contextInstance = (
				global.AudioContext as unknown as jest.Mock
			).mock.results[0].value as { close: jest.Mock };
			expect(contextInstance.close).toHaveBeenCalled();
		});

		it('should not mask the merge error when closing the context fails', async () => {
			const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
			(
				global.AudioContext as unknown as jest.Mock
			).mockImplementationOnce(() => ({
				decodeAudioData: jest
					.fn()
					.mockResolvedValue(createMockAudioBuffer()),
				destination: {},
				close: jest.fn().mockRejectedValue(new Error('close failed')),
				sampleRate: 44100,
			}));
			const targets = [createMockTarget('track1')];
			const buildTrackBlob = jest.fn().mockResolvedValue(null);

			await expect(
				mergeAudioTracks(
					targets,
					{ ...DEFAULT_SETTINGS, recordingFormat: 'webm' },
					false,
					jest.fn(),
					buildTrackBlob,
				),
			).rejects.toThrow('No audio data recorded');

			expect(warnSpy).toHaveBeenCalled();
			warnSpy.mockRestore();
		});

		it('should skip null blobs and merge remaining valid tracks', async () => {
			const targets = [
				createMockTarget('track1'),
				createMockTarget('track2'),
				createMockTarget('track3'),
			];
			// First and third return blobs, second returns null
			const buildTrackBlob = jest
				.fn()
				.mockResolvedValueOnce(
					new Blob(['audio1'], { type: 'audio/webm' }),
				)
				.mockResolvedValueOnce(null)
				.mockResolvedValueOnce(
					new Blob(['audio3'], { type: 'audio/webm' }),
				);

			const settings: AudioRecorderSettings = {
				...DEFAULT_SETTINGS,
				recordingFormat: 'mp4',
				bitrate: 128000,
			};

			const result = await mergeAudioTracks(
				targets,
				settings,
				false,
				jest.fn(),
				buildTrackBlob,
			);

			expect(result).toBeInstanceOf(Blob);
			// 2 valid buffers decoded, null one skipped
			const ctxInstance = (AudioContext as unknown as jest.Mock).mock
				.results[0].value;
			expect(ctxInstance.decodeAudioData).toHaveBeenCalledTimes(2);
		});

		it('should mix mono inputs into a mono OfflineAudioContext', async () => {
			const targets = [createMockTarget('track1')];
			const buildTrackBlob = jest
				.fn()
				.mockResolvedValue(new Blob(['audio'], { type: 'audio/webm' }));

			const settings: AudioRecorderSettings = {
				...DEFAULT_SETTINGS,
				recordingFormat: 'mp4',
				bitrate: 128000,
			};

			await mergeAudioTracks(
				targets,
				settings,
				false,
				jest.fn(),
				buildTrackBlob,
			);

			// All decoded inputs are mono (numberOfChannels: 1), so the mix
			// renders in mono instead of duplicating into stereo
			expect(OfflineAudioContext).toHaveBeenCalledWith(
				1,
				44100 * 1, // sampleRate * duration(1)
				44100,
			);
		});

		it('should keep a stereo mix when any input is stereo', async () => {
			const targets = [
				createMockTarget('track1'),
				createMockTarget('track2'),
			];
			const buildTrackBlob = jest
				.fn()
				.mockResolvedValue(new Blob(['audio'], { type: 'audio/webm' }));

			// Second decoded track is stereo; override only this instance
			(AudioContext as unknown as jest.Mock).mockImplementationOnce(
				() => ({
					decodeAudioData: jest
						.fn()
						.mockResolvedValueOnce(createMockAudioBuffer())
						.mockResolvedValueOnce(
							createMockAudioBuffer({ numberOfChannels: 2 }),
						),
					createBufferSource: jest.fn().mockImplementation(() => ({
						connect: jest.fn(),
						start: jest.fn(),
						buffer: null,
					})),
					destination: {},
					close: jest.fn().mockResolvedValue(undefined),
					sampleRate: 44100,
				}),
			);

			const settings: AudioRecorderSettings = {
				...DEFAULT_SETTINGS,
				recordingFormat: 'mp4',
				bitrate: 128000,
			};

			await mergeAudioTracks(
				targets,
				settings,
				false,
				jest.fn(),
				buildTrackBlob,
			);

			expect(OfflineAudioContext).toHaveBeenCalledWith(2, 44100, 44100);
		});

		it('should forward progress callback with adjusted percentage', async () => {
			const { encodeAudioBuffer } = jest.requireMock(
				'../../src/recording/AudioEncoder',
			);

			// Capture the progress callback passed to encodeAudioBuffer
			let capturedProgressFn: ((percent: number) => void) | undefined;
			encodeAudioBuffer.mockImplementation(
				(
					_buffer: unknown,
					_options: unknown,
					onProgress?: (percent: number) => void,
				) => {
					capturedProgressFn = onProgress;
					return Promise.resolve(
						new Blob(['encoded'], { type: 'audio/mp4' }),
					);
				},
			);

			const targets = [createMockTarget('track1')];
			const buildTrackBlob = jest
				.fn()
				.mockResolvedValue(new Blob(['audio'], { type: 'audio/webm' }));
			const onProgress = jest.fn();

			const settings: AudioRecorderSettings = {
				...DEFAULT_SETTINGS,
				recordingFormat: 'mp4',
				bitrate: 128000,
			};

			await mergeAudioTracks(
				targets,
				settings,
				false,
				jest.fn(),
				buildTrackBlob,
				onProgress,
			);

			// Simulate encoding progress
			expect(capturedProgressFn).toBeDefined();
			capturedProgressFn!(50);
			// 40 + Math.round(50 * 0.2) = 40 + 10 = 50
			expect(onProgress).toHaveBeenCalledWith(50, 'Encoding audio...');

			capturedProgressFn!(100);
			// 40 + Math.round(100 * 0.2) = 40 + 20 = 60
			expect(onProgress).toHaveBeenCalledWith(60, 'Encoding audio...');
		});

		it('should close AudioContext after merging', async () => {
			const targets = [createMockTarget('track1')];
			const buildTrackBlob = jest
				.fn()
				.mockResolvedValue(new Blob(['audio'], { type: 'audio/webm' }));

			const settings: AudioRecorderSettings = {
				...DEFAULT_SETTINGS,
				recordingFormat: 'wav',
			};

			await mergeAudioTracks(
				targets,
				settings,
				false,
				jest.fn(),
				buildTrackBlob,
			);

			const ctxInstance = (AudioContext as unknown as jest.Mock).mock
				.results[0].value;
			expect(ctxInstance.close).toHaveBeenCalledTimes(1);
		});

		it('should encode as WAV when the format is not offline-encodable', async () => {
			const { isOfflineEncodingSupported, encodeAudioBuffer } =
				jest.requireMock('../../src/recording/AudioEncoder');

			// Make the target format NOT offline-encodable
			isOfflineEncodingSupported.mockReturnValue(false);

			const targets = [createMockTarget('track1')];
			const buildTrackBlob = jest
				.fn()
				.mockResolvedValue(new Blob(['audio'], { type: 'audio/webm' }));

			const settings: AudioRecorderSettings = {
				...DEFAULT_SETTINGS,
				recordingFormat: 'someformat',
				bitrate: 128000,
			};

			await mergeAudioTracks(
				targets,
				settings,
				false,
				jest.fn(),
				buildTrackBlob,
			);

			// Falls back to WAV (mediabunny encodes pcm-s16 everywhere)
			expect(encodeAudioBuffer).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({ format: 'wav' }),
				expect.any(Function),
			);
		});
	});
});
