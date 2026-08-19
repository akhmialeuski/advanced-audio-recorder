/**
 * Unit tests for AudioFormatConverter module.
 * Tests format resolution, blob conversion, offline encoding, and track merging.
 * @module tests/unit/AudioFormatConverter.test
 */

import type { RecordingTarget } from 'src/types';
import { at } from '../helpers/assertions';

// Mock AudioEncoder module
jest.mock('src/audio/AudioEncoder', () => ({
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

// Mock downmix: keep the real mode helpers, spy on the buffer downmix
jest.mock('src/audio/downmix', () => {
	const actual: object = jest.requireActual('src/audio/downmix');
	return {
		...actual,
		downmixAudioBuffer: jest.fn((buffer: AudioBuffer) => buffer),
	};
});

// Mock mediabunny Conversion pipeline
const mockConversionExecute = jest.fn().mockResolvedValue(undefined);

jest.mock('mediabunny', () => require('../mocks/modules/mediabunny'));
import {
	conversionInit,
	getPrimaryAudioTrack,
} from '../mocks/modules/mediabunny';

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

// Mock MediaRecorder.isTypeSupported - default: support webm and ogg
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
	convertBlobToWavBuffer,
	convertBlobToFormat,
	convertBlobToFormatBuffer,
	decodeAudioBlob,
	mergeAudioTracks,
} from 'src/audio/AudioFormatConverter';
import type { EncodingWorkerClient } from 'src/audio/EncodingWorkerClient';
import { partial } from '../helpers/doubles';
import {
	encodeAudioBuffer,
	ensureEncoderRegistered,
	isOfflineEncodingSupported,
} from 'src/audio/AudioEncoder';
import { BufferTarget } from 'mediabunny';

describe('AudioFormatConverter', () => {
	beforeEach(() => {
		// Reset MediaRecorder.isTypeSupported to default
		jest.mocked(MediaRecorder.isTypeSupported).mockImplementation(
			(mime: string) => mime === 'audio/webm' || mime === 'audio/ogg',
		);

		// Default: streaming conversion succeeds, fresh instance per call
		conversionInit.mockImplementation(() =>
			Promise.resolve({
				execute: mockConversionExecute,
				onProgress: undefined,
				isValid: true,
				discardedTracks: [],
			}),
		);

		// Default input track: opus audio, the typical intermediate
		// recording codec
		getPrimaryAudioTrack.mockResolvedValue({
			getCodec: jest.fn().mockResolvedValue('opus'),
			isAudioTrack: (): boolean => true,
			getNumberOfChannels: jest.fn().mockResolvedValue(2),
		});
	});

	// ---------------------------------------------------------------
	// resolveRecorderFormat
	// ---------------------------------------------------------------
	describe('resolveRecorderFormat', () => {
		it.each([
			['webm (native support)', 'webm', 'webm'],
			['ogg (native support)', 'ogg', 'ogg'],
			['wav (always via intermediate, never native)', 'wav', 'webm'],
			['WEBM (case-insensitive)', 'WEBM', 'webm'],
		])(
			'resolves %s to the %s recorder',
			(_case, recordingFormat, expected) => {
				expect(resolveRecorderFormat(recordingFormat)).toEqual({
					recorderFormat: expected,
					mimeType: `audio/${expected}`,
				});
			},
		);

		it.each([
			['WebM', 'audio/webm', 'webm'],
			['OGG when WebM is unsupported', 'audio/ogg', 'ogg'],
		])(
			'falls back to %s for an unsupported native format',
			(_case, supportedMime, expected) => {
				jest.mocked(MediaRecorder.isTypeSupported).mockImplementation(
					(mime: string) => mime === supportedMime,
				);
				expect(resolveRecorderFormat('mp4')).toEqual({
					recorderFormat: expected,
					mimeType: supportedMime,
				});
			},
		);

		it('falls back to MP4 when only audio/mp4 is recordable (iOS)', () => {
			// iOS WKWebView: MediaRecorder records audio/mp4 only
			jest.mocked(MediaRecorder.isTypeSupported).mockImplementation(
				(mime: string) => mime === 'audio/mp4',
			);
			expect(resolveRecorderFormat('wav')).toEqual({
				recorderFormat: 'mp4',
				mimeType: 'audio/mp4',
			});
		});

		it('records m4a directly through its canonical audio/mp4 MIME (iOS)', () => {
			// audio/m4a probes false on iOS, but m4a IS an mp4 container:
			// the recorder captures audio/mp4 and the file keeps the .m4a
			// extension without any re-encode
			jest.mocked(MediaRecorder.isTypeSupported).mockImplementation(
				(mime: string) => mime === 'audio/mp4',
			);
			expect(resolveRecorderFormat('m4a')).toEqual({
				recorderFormat: 'm4a',
				mimeType: 'audio/mp4',
			});
		});

		it('throws when no intermediate format is supported', () => {
			jest.mocked(MediaRecorder.isTypeSupported).mockReturnValue(false);
			expect(() => resolveRecorderFormat('mp4')).toThrow(
				/none of webm, ogg, mp4 is supported/,
			);
		});
	});

	// ---------------------------------------------------------------
	// isOfflineOnlyFormat
	// ---------------------------------------------------------------
	describe('isOfflineOnlyFormat', () => {
		it.each([
			['mp4', 'webm', true],
			['mp3', 'webm', true],
			['flac', 'ogg', true],
			['aac', 'webm', true],
			['m4a', 'webm', true],
			// Matching the recorder format needs no offline pass
			['webm', 'webm', false],
			// WAV is always handled separately
			['wav', 'webm', false],
		])(
			'isOfflineOnlyFormat(%s, %s) is %s',
			(format, recorderFormat, expected) => {
				expect(isOfflineOnlyFormat(format, recorderFormat)).toBe(
					expected,
				);
			},
		);

		it('returns false when format is not offline-encoding-supported', () => {
			jest.mocked(isOfflineEncodingSupported).mockReturnValueOnce(false);
			expect(isOfflineOnlyFormat('unknownformat', 'webm')).toBe(false);
		});
	});

	// ---------------------------------------------------------------
	// convertBlobToWav
	// ---------------------------------------------------------------
	describe('convertBlobToWav', () => {
		it('converts through the streaming pipeline to a WAV blob', async () => {
			const inputBlob = new Blob(['audio-data'], { type: 'audio/webm' });
			const result = await convertBlobToWav(inputBlob);

			expect(conversionInit).toHaveBeenCalledWith(
				expect.objectContaining({
					// PCM is uncompressed: no bitrate option may be passed
					audio: { codec: 'pcm-s16' },
				}),
			);
			expect(result).toBeInstanceOf(Blob);
			expect(result.type).toBe('audio/wav');
		});

		it('falls back to decode-and-encode when streaming fails', async () => {
			jest.spyOn(console, 'warn').mockImplementation();
			conversionInit.mockRejectedValueOnce(
				new Error('unreadable container'),
			);

			const inputBlob = new Blob(['audio-data'], { type: 'audio/webm' });
			await convertBlobToWav(inputBlob);

			expect(jest.mocked(encodeAudioBuffer)).toHaveBeenCalledWith(
				expect.objectContaining({ sampleRate: 44100 }),
				expect.objectContaining({ format: 'wav' }),
				undefined,
			);
		});

		it('downmixes on the decode fallback when a mono mode is requested', async () => {
			jest.spyOn(console, 'warn').mockImplementation();
			conversionInit.mockRejectedValueOnce(
				new Error('unreadable container'),
			);
			const { downmixAudioBuffer } =
				jest.requireMock('src/audio/downmix');

			const inputBlob = new Blob(['audio-data'], { type: 'audio/webm' });
			await convertBlobToFormat(inputBlob, 'wav', 0, undefined, {
				channelMode: 'mono-mix',
			});

			expect(downmixAudioBuffer).toHaveBeenCalledWith(
				expect.objectContaining({ sampleRate: 44100 }),
				'mono-mix',
			);
		});

		it('passes the channel mode into the streaming conversion options', async () => {
			await convertBlobToFormat(
				new Blob(['audio-data'], { type: 'audio/webm' }),
				'mp3',
				128000,
				undefined,
				{ channelMode: 'mono-mix' },
			);

			expect(conversionInit).toHaveBeenCalledWith(
				expect.objectContaining({
					audio: expect.objectContaining({
						process: expect.any(Function),
						processedNumberOfChannels: 1,
					}),
				}),
			);
		});
	});

	// ---------------------------------------------------------------
	// The buffer-returning variants, which the save path uses
	// ---------------------------------------------------------------
	describe('converting straight to bytes', () => {
		/** An encoding worker whose conversion succeeds. */
		function workingWorker(): {
			isAvailable: () => boolean;
			convertBlob: jest.Mock;
		} {
			return {
				isAvailable: () => true,
				convertBlob: jest
					.fn()
					.mockResolvedValue(
						new Blob(['worker'], { type: 'audio/mp3' }),
					),
			};
		}

		it('hands the worker result back as bytes, skipping the main thread', async () => {
			// The save path writes straight into vault.createBinary, so the
			// Blob wrap and the full read-back it costs are skipped here.
			const worker = workingWorker();
			const blob = new Blob(['test'], { type: 'audio/webm' });

			const result = await convertBlobToFormatBuffer(
				blob,
				'mp3',
				192000,
				undefined,
				{
					allowRemux: true,
					workerClient: partial<EncodingWorkerClient>(worker),
				},
			);

			expect(worker.convertBlob).toHaveBeenCalledWith(
				blob,
				'mp3',
				192000,
				true,
				'source',
				undefined,
			);
			expect(conversionInit).not.toHaveBeenCalled();
			expect(result).toBeInstanceOf(ArrayBuffer);
		});

		it('passes the channel mode to the worker', async () => {
			const worker = workingWorker();

			await convertBlobToFormatBuffer(
				new Blob(['test'], { type: 'audio/webm' }),
				'mp3',
				192000,
				undefined,
				{
					workerClient: partial<EncodingWorkerClient>(worker),
					channelMode: 'mono-left',
				},
			);

			expect(worker.convertBlob).toHaveBeenCalledWith(
				expect.anything(),
				'mp3',
				192000,
				false,
				'mono-left',
				undefined,
			);
		});

		it('ignores a worker that is not running', async () => {
			const worker = {
				isAvailable: () => false,
				convertBlob: jest.fn(),
			};

			await convertBlobToFormatBuffer(
				new Blob(['test'], { type: 'audio/webm' }),
				'mp3',
				192000,
				undefined,
				{ workerClient: partial<EncodingWorkerClient>(worker) },
			);

			expect(worker.convertBlob).not.toHaveBeenCalled();
			expect(conversionInit).toHaveBeenCalledTimes(1);
		});

		it('falls back to the main thread when the worker fails', async () => {
			jest.spyOn(console, 'warn').mockImplementation();
			const worker = {
				isAvailable: () => true,
				convertBlob: jest
					.fn()
					.mockRejectedValue(new Error('worker died')),
			};

			const result = await convertBlobToFormatBuffer(
				new Blob(['test'], { type: 'audio/webm' }),
				'mp4',
				128000,
				undefined,
				{ workerClient: partial<EncodingWorkerClient>(worker) },
			);

			expect(conversionInit).toHaveBeenCalledTimes(1);
			expect(result).toBeInstanceOf(ArrayBuffer);
		});

		it('falls back to decode and re-encode when streaming fails too', async () => {
			jest.spyOn(console, 'warn').mockImplementation();
			conversionInit.mockRejectedValueOnce(
				new Error('unreadable container'),
			);

			const result = await convertBlobToFormatBuffer(
				new Blob(['audio-data'], { type: 'audio/webm' }),
				'mp3',
				128000,
			);

			expect(jest.mocked(encodeAudioBuffer)).toHaveBeenCalledWith(
				expect.objectContaining({ sampleRate: 44100 }),
				expect.objectContaining({ format: 'mp3' }),
				undefined,
			);
			expect(result).toBeInstanceOf(ArrayBuffer);
		});

		it('downmixes on the decode fallback when a mono mode is requested', async () => {
			jest.spyOn(console, 'warn').mockImplementation();
			conversionInit.mockRejectedValueOnce(
				new Error('unreadable container'),
			);
			const { downmixAudioBuffer } =
				jest.requireMock('src/audio/downmix');

			await convertBlobToFormatBuffer(
				new Blob(['audio-data'], { type: 'audio/webm' }),
				'mp3',
				128000,
				undefined,
				{ channelMode: 'mono-mix' },
			);

			expect(downmixAudioBuffer).toHaveBeenCalledWith(
				expect.objectContaining({ sampleRate: 44100 }),
				'mono-mix',
			);
		});

		it('asks for uncompressed PCM when the target is WAV', async () => {
			const result = await convertBlobToWavBuffer(
				new Blob(['audio-data'], { type: 'audio/webm' }),
			);

			expect(conversionInit).toHaveBeenCalledWith(
				expect.objectContaining({
					// PCM is uncompressed: no bitrate option may be passed
					audio: { codec: 'pcm-s16' },
				}),
			);
			expect(result).toBeInstanceOf(ArrayBuffer);
		});

		it('carries the channel mode into a WAV conversion', async () => {
			const worker = workingWorker();

			await convertBlobToWavBuffer(
				new Blob(['audio-data'], { type: 'audio/webm' }),
				{
					workerClient: partial<EncodingWorkerClient>(worker),
					channelMode: 'mono-right',
				},
			);

			expect(worker.convertBlob).toHaveBeenCalledWith(
				expect.anything(),
				'wav',
				0,
				false,
				'mono-right',
				undefined,
			);
		});
	});

	// ---------------------------------------------------------------
	// decodeAudioBlob
	// ---------------------------------------------------------------
	describe('decodeAudioBlob', () => {
		it('decodes exactly once and close the context', async () => {
			const buffer = new ArrayBuffer(8);
			await decodeAudioBlob(buffer);

			expect(AudioContext).toHaveBeenCalledTimes(1);
			const ctx = at(jest.mocked(AudioContext).mock.results, 0).value;
			expect(ctx.decodeAudioData).toHaveBeenCalledTimes(1);
			expect(ctx.close).toHaveBeenCalledTimes(1);
			// No second decode through an OfflineAudioContext
			expect(OfflineAudioContext).not.toHaveBeenCalled();
		});

		it('closes the context when decoding fails', async () => {
			const decodeError = new Error('decode failed');
			// eslint-disable-next-line @typescript-eslint/no-explicit-any -- required for mock override
			(AudioContext as any).mockImplementationOnce(() =>
				partial<AudioContext>({
					decodeAudioData: jest.fn().mockRejectedValue(decodeError),
					close: jest.fn().mockResolvedValue(undefined),
				}),
			);

			await expect(decodeAudioBlob(new ArrayBuffer(8))).rejects.toThrow(
				'decode failed',
			);

			// The AudioContext must not leak on corrupted input
			const ctx = at(jest.mocked(AudioContext).mock.results, 0).value;
			expect(ctx.close).toHaveBeenCalledTimes(1);
		});
	});

	// ---------------------------------------------------------------
	// convertBlobToFormat
	// ---------------------------------------------------------------
	describe('convertBlobToFormat', () => {
		it('uses the encoding worker when one is available', async () => {
			const workerClient = {
				isAvailable: () => true,
				convertBlob: jest
					.fn()
					.mockResolvedValue(
						new Blob(['worker'], { type: 'audio/mp3' }),
					),
			};
			const blob = new Blob(['test'], { type: 'audio/webm' });

			const result = await convertBlobToFormat(
				blob,
				'mp3',
				192000,
				undefined,
				{
					allowRemux: true,
					workerClient: partial<EncodingWorkerClient>(workerClient),
				},
			);

			expect(workerClient.convertBlob).toHaveBeenCalledWith(
				blob,
				'mp3',
				192000,
				true,
				'source',
				undefined,
			);
			// The main-thread pipeline is never touched
			expect(conversionInit).not.toHaveBeenCalled();
			expect(result.type).toBe('audio/mp3');
		});

		it('passes the channel mode through to the encoding worker', async () => {
			const workerClient = {
				isAvailable: () => true,
				convertBlob: jest
					.fn()
					.mockResolvedValue(
						new Blob(['worker'], { type: 'audio/mp3' }),
					),
			};
			const blob = new Blob(['test'], { type: 'audio/webm' });

			await convertBlobToFormat(blob, 'mp3', 192000, undefined, {
				workerClient: partial<EncodingWorkerClient>(workerClient),
				channelMode: 'mono-left',
			});

			expect(workerClient.convertBlob).toHaveBeenCalledWith(
				blob,
				'mp3',
				192000,
				false,
				'mono-left',
				undefined,
			);
		});

		it('falls back to the main thread when the worker fails', async () => {
			jest.spyOn(console, 'warn').mockImplementation();
			const workerClient = {
				isAvailable: () => true,
				convertBlob: jest
					.fn()
					.mockRejectedValue(new Error('worker died')),
			};
			const blob = new Blob(['test'], { type: 'audio/webm' });

			const result = await convertBlobToFormat(
				blob,
				'mp4',
				128000,
				undefined,
				{
					workerClient: partial<EncodingWorkerClient>(workerClient),
				},
			);

			expect(conversionInit).toHaveBeenCalledTimes(1);
			expect(result).toBeInstanceOf(Blob);
		});

		it('converts via the streaming Conversion pipeline', async () => {
			const blob = new Blob(['test'], { type: 'audio/webm' });

			const result = await convertBlobToFormat(blob, 'mp4', 128000);

			expect(conversionInit).toHaveBeenCalledWith(
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
			expect(jest.mocked(encodeAudioBuffer)).not.toHaveBeenCalled();
		});

		it('registers the extension encoder before converting', async () => {
			const blob = new Blob(['test'], { type: 'audio/webm' });

			await convertBlobToFormat(blob, 'mp3', 192000);

			expect(jest.mocked(ensureEncoderRegistered)).toHaveBeenCalledWith(
				'mp3',
			);
		});

		it('reports whole-percent progress from the conversion', async () => {
			const progressFn = jest.fn();
			const blob = new Blob(['test'], { type: 'audio/webm' });

			await convertBlobToFormat(blob, 'mp4', 128000, progressFn);

			const instance = (await at(conversionInit.mock.results, 0)
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

		it('remuxes without bitrate when the codecs match and remux is allowed', async () => {
			const blob = new Blob(['test'], { type: 'audio/webm' });

			// Input track is opus (default mock); ogg targets opus too.
			// The recording pipeline opts in: its intermediate blob is
			// already encoded at the requested bitrate.
			await convertBlobToFormat(blob, 'ogg', 128000, undefined, {
				allowRemux: true,
			});

			expect(conversionInit).toHaveBeenCalledWith(
				expect.objectContaining({
					audio: { codec: 'opus' },
					showWarnings: false,
				}),
			);
			expect(mockConversionExecute).toHaveBeenCalledTimes(1);
		});

		it('res-encode at the requested bitrate when remux is not allowed', async () => {
			const blob = new Blob(['test'], { type: 'audio/webm' });

			// Matching codecs (opus input, ogg target), but without the
			// remux opt-in the explicitly requested bitrate must be
			// honored: manual conversions let the user pick it
			await convertBlobToFormat(blob, 'ogg', 64000);

			expect(conversionInit).toHaveBeenCalledWith(
				expect.objectContaining({
					audio: { codec: 'opus', bitrate: 64000 },
				}),
			);
			expect(mockConversionExecute).toHaveBeenCalledTimes(1);
		});

		it('falls back when the audio track is discarded', async () => {
			// Conversion.init does not throw for codec problems: the
			// track is discarded and the output would contain no audio
			conversionInit.mockImplementationOnce(() =>
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
			expect(jest.mocked(encodeAudioBuffer)).toHaveBeenCalledWith(
				expect.anything(),
				{ format: 'mp4', bitrate: 128000 },
				undefined,
			);
			expect(warnSpy).toHaveBeenCalled();
		});

		it('ignores discarded non-audio tracks', async () => {
			// A video track in the source container is legitimately
			// dropped when converting to an audio-only format
			conversionInit.mockImplementationOnce(() =>
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

		it('falls back when the conversion is invalid', async () => {
			conversionInit.mockImplementationOnce(() =>
				Promise.resolve({
					execute: mockConversionExecute,
					isValid: false,
					discardedTracks: [],
				}),
			);
			jest.spyOn(console, 'warn').mockImplementation(() => undefined);
			const blob = new Blob(['test'], { type: 'audio/webm' });

			await convertBlobToFormat(blob, 'aac', 256000);

			expect(mockConversionExecute).not.toHaveBeenCalled();
			expect(jest.mocked(encodeAudioBuffer)).toHaveBeenCalled();
		});

		it('falls back when the input has no audio track', async () => {
			getPrimaryAudioTrack.mockResolvedValueOnce(null);
			jest.spyOn(console, 'warn').mockImplementation(() => undefined);
			const blob = new Blob(['test'], { type: 'audio/webm' });

			await convertBlobToFormat(blob, 'mp4', 128000);

			expect(conversionInit).not.toHaveBeenCalled();
			expect(jest.mocked(encodeAudioBuffer)).toHaveBeenCalled();
		});

		it('falls back to decode and re-encode when conversion fails', async () => {
			conversionInit.mockRejectedValueOnce(
				new Error('unreadable container'),
			);
			const warnSpy = jest
				.spyOn(console, 'warn')
				.mockImplementation(() => undefined);
			const blob = new Blob(['test'], { type: 'audio/webm' });

			const result = await convertBlobToFormat(blob, 'mp4', 128000);

			expect(result).toBeInstanceOf(Blob);
			expect(AudioContext).toHaveBeenCalledTimes(1);
			expect(jest.mocked(encodeAudioBuffer)).toHaveBeenCalledWith(
				expect.objectContaining({ sampleRate: 44100 }),
				{ format: 'mp4', bitrate: 128000 },
				undefined,
			);
			expect(warnSpy).toHaveBeenCalled();
		});

		it('falls back when the conversion produces empty output', async () => {
			jest.mocked(BufferTarget).mockImplementationOnce(() =>
				partial<BufferTarget>({ buffer: null }),
			);
			jest.spyOn(console, 'warn').mockImplementation(() => undefined);
			const blob = new Blob(['test'], { type: 'audio/webm' });

			await convertBlobToFormat(blob, 'aac', 256000);

			expect(jest.mocked(encodeAudioBuffer)).toHaveBeenCalledWith(
				expect.anything(),
				{ format: 'aac', bitrate: 256000 },
				undefined,
			);
		});

		it('forwards onProgress to the fallback encoder', async () => {
			conversionInit.mockRejectedValueOnce(new Error('boom'));
			jest.spyOn(console, 'warn').mockImplementation(() => undefined);
			const progressFn = jest.fn();
			const blob = new Blob(['test'], { type: 'audio/webm' });

			await convertBlobToFormat(blob, 'mp4', 128000, progressFn);

			expect(jest.mocked(encodeAudioBuffer)).toHaveBeenCalledWith(
				expect.anything(),
				{ format: 'mp4', bitrate: 128000 },
				progressFn,
			);
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
			partIndex: 0,
			partPaths: [],
			partPcmBytes: 0,
		});

		it('merges multiple tracks using buildTrackBlob', async () => {
			const targets = [
				createMockTarget('track1'),
				createMockTarget('track2'),
			];
			const buildPcmTrackWavBlob = jest.fn();
			const buildTrackBlob = jest
				.fn()
				.mockResolvedValue(new Blob(['audio'], { type: 'audio/webm' }));

			const result = await mergeAudioTracks(
				targets,
				'mp4',
				128000,
				false,
				buildPcmTrackWavBlob,
				buildTrackBlob,
			);

			expect(buildTrackBlob).toHaveBeenCalledTimes(2);
			expect(buildPcmTrackWavBlob).not.toHaveBeenCalled();
			expect(result).toBeInstanceOf(Blob);
		});

		it('merges multiple tracks using buildPcmTrackWavBlob for WAV PCM recordings', async () => {
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

			await mergeAudioTracks(
				targets,
				'wav',
				128000,
				true,
				buildPcmTrackWavBlob,
				buildTrackBlob,
			);

			expect(buildPcmTrackWavBlob).toHaveBeenCalledTimes(2);
			expect(buildTrackBlob).not.toHaveBeenCalled();
		});

		it('encodes merged result for offline-encodable formats', async () => {
			const targets = [createMockTarget('track1')];
			const buildTrackBlob = jest
				.fn()
				.mockResolvedValue(new Blob(['audio'], { type: 'audio/webm' }));

			await mergeAudioTracks(
				targets,
				'mp4',
				128000,
				false,
				jest.fn(),
				buildTrackBlob,
			);

			expect(jest.mocked(encodeAudioBuffer)).toHaveBeenCalledTimes(1);
			expect(jest.mocked(encodeAudioBuffer)).toHaveBeenCalledWith(
				expect.objectContaining({ sampleRate: 44100 }),
				{ format: 'mp4', bitrate: 128000 },
				expect.any(Function),
			);
		});

		it('encodes the mix as WAV when format is wav', async () => {
			const targets = [createMockTarget('track1')];
			const buildTrackBlob = jest
				.fn()
				.mockResolvedValue(new Blob(['audio'], { type: 'audio/webm' }));

			await mergeAudioTracks(
				targets,
				'wav',
				128000,
				false,
				jest.fn(),
				buildTrackBlob,
			);

			expect(jest.mocked(encodeAudioBuffer)).toHaveBeenCalledWith(
				expect.objectContaining({ sampleRate: 44100 }),
				{ format: 'wav', bitrate: 128000 },
				expect.any(Function),
			);
		});

		it('throws when no audio data is recorded (all blobs null)', async () => {
			const targets = [createMockTarget('track1')];
			const buildTrackBlob = jest.fn().mockResolvedValue(null);

			await expect(
				mergeAudioTracks(
					targets,
					'webm',
					128000,
					false,
					jest.fn(),
					buildTrackBlob,
				),
			).rejects.toThrow('No audio data recorded');
		});

		it('closes the AudioContext when no audio data is recorded', async () => {
			const targets = [createMockTarget('track1')];
			const buildTrackBlob = jest.fn().mockResolvedValue(null);

			await expect(
				mergeAudioTracks(
					targets,
					'webm',
					128000,
					false,
					jest.fn(),
					buildTrackBlob,
				),
			).rejects.toThrow('No audio data recorded');

			const contextInstance = at(
				jest.mocked(global.AudioContext).mock.results,
				0,
			).value as { close: jest.Mock };
			expect(contextInstance.close).toHaveBeenCalled();
		});

		it('closes the AudioContext when decoding fails', async () => {
			jest.mocked(global.AudioContext).mockImplementationOnce(() =>
				partial<AudioContext>({
					decodeAudioData: jest
						.fn()
						.mockRejectedValue(new Error('corrupted track')),
					destination: {},
					close: jest.fn().mockResolvedValue(undefined),
					sampleRate: 44100,
				}),
			);
			const targets = [createMockTarget('track1')];
			const buildTrackBlob = jest
				.fn()
				.mockResolvedValue(new Blob(['audio'], { type: 'audio/webm' }));

			await expect(
				mergeAudioTracks(
					targets,
					'webm',
					128000,
					false,
					jest.fn(),
					buildTrackBlob,
				),
			).rejects.toThrow('corrupted track');

			const contextInstance = at(
				jest.mocked(global.AudioContext).mock.results,
				0,
			).value as { close: jest.Mock };
			expect(contextInstance.close).toHaveBeenCalled();
		});

		it('does not mask the merge error when closing the context fails', async () => {
			const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
			jest.mocked(global.AudioContext).mockImplementationOnce(() =>
				partial<AudioContext>({
					decodeAudioData: jest
						.fn()
						.mockResolvedValue(createMockAudioBuffer()),
					destination: {},
					close: jest
						.fn()
						.mockRejectedValue(new Error('close failed')),
					sampleRate: 44100,
				}),
			);
			const targets = [createMockTarget('track1')];
			const buildTrackBlob = jest.fn().mockResolvedValue(null);

			await expect(
				mergeAudioTracks(
					targets,
					'webm',
					128000,
					false,
					jest.fn(),
					buildTrackBlob,
				),
			).rejects.toThrow('No audio data recorded');

			expect(warnSpy).toHaveBeenCalled();
		});

		it('skips null blobs and merge remaining valid tracks', async () => {
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

			const result = await mergeAudioTracks(
				targets,
				'mp4',
				128000,
				false,
				jest.fn(),
				buildTrackBlob,
			);

			expect(result).toBeInstanceOf(Blob);
			// 2 valid buffers decoded, null one skipped
			const ctxInstance = at(
				jest.mocked(AudioContext).mock.results,
				0,
			).value;
			expect(ctxInstance.decodeAudioData).toHaveBeenCalledTimes(2);
		});

		it('mixes mono inputs into a mono OfflineAudioContext', async () => {
			const targets = [createMockTarget('track1')];
			const buildTrackBlob = jest
				.fn()
				.mockResolvedValue(new Blob(['audio'], { type: 'audio/webm' }));

			await mergeAudioTracks(
				targets,
				'mp4',
				128000,
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

		it('keeps a stereo mix when any input is stereo', async () => {
			const targets = [
				createMockTarget('track1'),
				createMockTarget('track2'),
			];
			const buildTrackBlob = jest
				.fn()
				.mockResolvedValue(new Blob(['audio'], { type: 'audio/webm' }));

			// Second decoded track is stereo; override only this instance
			jest.mocked(AudioContext).mockImplementationOnce(() =>
				partial<AudioContext>({
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

			await mergeAudioTracks(
				targets,
				'mp4',
				128000,
				false,
				jest.fn(),
				buildTrackBlob,
			);

			expect(OfflineAudioContext).toHaveBeenCalledWith(2, 44100, 44100);
		});

		it('forwards progress callback with adjusted percentage', async () => {
			// Capture the progress callback passed to encodeAudioBuffer
			let capturedProgressFn: ((percent: number) => void) | undefined;
			jest.mocked(encodeAudioBuffer).mockImplementation(
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

			await mergeAudioTracks(
				targets,
				'mp4',
				128000,
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

		it('closes AudioContext after merging', async () => {
			const targets = [createMockTarget('track1')];
			const buildTrackBlob = jest
				.fn()
				.mockResolvedValue(new Blob(['audio'], { type: 'audio/webm' }));

			await mergeAudioTracks(
				targets,
				'wav',
				128000,
				false,
				jest.fn(),
				buildTrackBlob,
			);

			const ctxInstance = at(
				jest.mocked(AudioContext).mock.results,
				0,
			).value;
			expect(ctxInstance.close).toHaveBeenCalledTimes(1);
		});
	});
});
