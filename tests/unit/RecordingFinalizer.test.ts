/**
 * Unit tests for RecordingFinalizer module.
 * Tests finalization paths, cleanup error handling, and progress
 * deduplication.
 * @module tests/unit/RecordingFinalizer.test
 */
/** @jest-environment jsdom */

import { RecordingFinalizer } from '../../src/recording/RecordingFinalizer';
import { TrackWriteQueue } from '../../src/recording/TrackWriteQueue';
import { DebugLogger } from '../../src/utils/DebugLogger';
import type { RecordingSessionConfig, RecordingTarget } from '../../src/types';
import {
	DEFAULT_SETTINGS,
	AudioRecorderSettings,
} from '../../src/settings/Settings';
import type { App } from 'obsidian';

jest.mock('obsidian', () => ({
	Notice: jest.fn(),
	normalizePath: (path: string) => path.replace(/\\/g, '/'),
}));

jest.mock('../../src/recording/WavEncoder', () => ({
	assembleWavFromPcmSegments: jest.fn().mockReturnValue(new ArrayBuffer(44)),
	createWavHeader: jest.fn().mockReturnValue(new ArrayBuffer(44)),
	WAV_HEADER_SIZE: 44,
}));

jest.mock('../../src/recording/AudioEncoder', () => ({
	isOfflineEncodingSupported: jest.fn((format: string) =>
		['mp3', 'flac', 'webm', 'ogg', 'mp4', 'm4a', 'aac'].includes(format),
	),
}));

jest.mock('../../src/recording/AudioFormatConverter', () => ({
	mergeAudioTracks: jest
		.fn()
		.mockResolvedValue(new Blob(['merged'], { type: 'audio/wav' })),
	convertBlobToWav: jest
		.fn()
		.mockResolvedValue(new Blob(['wav'], { type: 'audio/wav' })),
	convertBlobToFormat: jest
		.fn()
		.mockResolvedValue(new Blob(['encoded'], { type: 'audio/mp3' })),
	getRecorderMediaType: jest.fn((format: string) => `audio/${format}`),
	isOfflineOnlyFormat: jest.fn(
		(format: string, recorderFormat: string) =>
			format !== 'wav' && format !== recorderFormat,
	),
	buildOutputBlob: jest
		.fn()
		.mockResolvedValue(new Blob(['output'], { type: 'audio/webm' })),
}));

jest.mock('../../src/recording/NoteInserter', () => ({
	insertFileLinks: jest.fn(),
}));

jest.mock('../../src/recording/StreamingMixer', () => ({
	canStreamMix: jest.fn().mockReturnValue(true),
	mixPcmTracksToWav: jest.fn().mockResolvedValue(new ArrayBuffer(50)),
}));

if (!Blob.prototype.arrayBuffer) {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test polyfill for jsdom
	(Blob.prototype as any).arrayBuffer = function (): Promise<ArrayBuffer> {
		return Promise.resolve(new ArrayBuffer(0));
	};
}

const createTarget = (
	overrides: Partial<RecordingTarget> = {},
): RecordingTarget => ({
	fileBaseName: 'recording-Track1-stamp',
	sourceName: 'Track1',
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
	...overrides,
});

const createSession = (
	overrides: Partial<RecordingSessionConfig> = {},
): RecordingSessionConfig => ({
	isMobile: false,
	isWavPcm: false,
	recorderFormat: 'webm',
	outputFormat: 'webm',
	bitrate: 128000,
	splitEnabled: false,
	partMinutes: 15,
	partSuffix: 'part',
	...overrides,
});

describe('RecordingFinalizer', () => {
	let finalizer: RecordingFinalizer;
	let queue: TrackWriteQueue;
	let mockApp: App;
	let mockSettings: AudioRecorderSettings;
	let onProgress: jest.Mock;
	let consoleErrorSpy: jest.SpyInstance;

	const getNotices = (): string[] => {
		const { Notice } = jest.requireMock('obsidian');
		return (Notice as jest.Mock).mock.calls.map((call) => String(call[0]));
	};

	const buildFinalizer = (
		session: RecordingSessionConfig,
		settings: AudioRecorderSettings = mockSettings,
	): void => {
		queue = new TrackWriteQueue(mockApp, settings);
		finalizer = new RecordingFinalizer(
			mockApp,
			settings,
			queue,
			new DebugLogger(settings),
			onProgress,
		);
		queue.beginSession(session);
		finalizer.beginSession(session);
	};

	beforeEach(() => {
		jest.clearAllMocks();
		consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();

		mockApp = {
			vault: {
				adapter: {
					exists: jest.fn().mockResolvedValue(false),
					readBinary: jest
						.fn()
						.mockResolvedValue(new Uint8Array([1, 2, 3]).buffer),
					writeBinary: jest.fn().mockResolvedValue(undefined),
					remove: jest.fn().mockResolvedValue(undefined),
				},
				createBinary: jest.fn().mockResolvedValue(undefined),
				createFolder: jest.fn().mockResolvedValue(undefined),
			},
			workspace: {
				getActiveFile: jest.fn().mockReturnValue(null),
			},
		} as unknown as App;
		mockSettings = { ...DEFAULT_SETTINGS };
		onProgress = jest.fn();
		buildFinalizer(createSession());
	});

	afterEach(() => {
		consoleErrorSpy.mockRestore();
	});

	describe('reportProgress', () => {
		it('should deduplicate identical whole-percent updates', () => {
			finalizer.reportProgress(50.2, 'Encoding...');
			finalizer.reportProgress(50.4, 'Encoding...');

			expect(onProgress).toHaveBeenCalledTimes(1);
			expect(onProgress).toHaveBeenCalledWith({
				percent: 50,
				description: 'Encoding...',
			});
		});

		it('should pass through changed descriptions', () => {
			finalizer.reportProgress(50, 'Encoding...');
			finalizer.reportProgress(50, 'Writing...');

			expect(onProgress).toHaveBeenCalledTimes(2);
		});

		it('should reset deduplication on beginSession', () => {
			finalizer.reportProgress(50, 'Encoding...');
			finalizer.beginSession(createSession());
			finalizer.reportProgress(50, 'Encoding...');

			expect(onProgress).toHaveBeenCalledTimes(2);
		});
	});

	describe('finalizeSegmentsToFile', () => {
		it('should return null for an empty segment list', async () => {
			const result = await finalizer.finalizeSegmentsToFile(
				[],
				'final.webm',
			);

			expect(result).toBeNull();
			expect(mockApp.vault.createBinary).not.toHaveBeenCalled();
		});

		it('should pass segments through unchanged for the recorder format', async () => {
			const result = await finalizer.finalizeSegmentsToFile(
				['seg1.tmp', 'seg2.tmp'],
				'final.webm',
			);

			expect(result).toBe('/final.webm');
			expect(mockApp.vault.createBinary).toHaveBeenCalledWith(
				'/final.webm',
				expect.any(ArrayBuffer),
			);
			expect(mockApp.vault.adapter.remove).toHaveBeenCalledTimes(2);
		});

		it('should convert to WAV when the output format is wav', async () => {
			buildFinalizer(createSession({ outputFormat: 'wav' }));
			const { convertBlobToWav } = jest.requireMock(
				'../../src/recording/AudioFormatConverter',
			);

			await finalizer.finalizeSegmentsToFile(['seg1.tmp'], 'final.wav');

			expect(convertBlobToWav).toHaveBeenCalled();
		});

		it('should re-encode offline-only formats with remux allowed and mapped progress', async () => {
			buildFinalizer(createSession({ outputFormat: 'mp3' }));
			const { convertBlobToFormat } = jest.requireMock(
				'../../src/recording/AudioFormatConverter',
			);

			await finalizer.finalizeSegmentsToFile(
				['seg1.tmp'],
				'final.mp3',
				true,
			);

			expect(convertBlobToFormat).toHaveBeenCalledWith(
				expect.any(Blob),
				'mp3',
				128000,
				expect.any(Function),
				{ allowRemux: true },
			);
			// The encoder progress callback maps into the 40-60% band
			const progressCallback = (convertBlobToFormat as jest.Mock).mock
				.calls[0][3] as (percent: number) => void;
			progressCallback(50);
			expect(onProgress).toHaveBeenCalledWith({
				percent: 50,
				description: 'Encoding audio...',
			});
		});

		it('should keep the final file and notify when segment cleanup fails', async () => {
			(mockApp.vault.adapter.remove as jest.Mock).mockRejectedValue(
				new Error('locked'),
			);
			const warnSpy = jest.spyOn(console, 'warn').mockImplementation();

			const result = await finalizer.finalizeSegmentsToFile(
				['seg1.tmp'],
				'final.webm',
			);

			expect(result).toBe('/final.webm');
			expect(
				getNotices().some((message) =>
					message.includes('temporary files could not be removed'),
				),
			).toBe(true);
			warnSpy.mockRestore();
		});
	});

	describe('assembleWavFile', () => {
		it('should stream segments into one preallocated buffer when stat is available', async () => {
			const adapter = mockApp.vault.adapter as unknown as Record<
				string,
				jest.Mock
			>;
			adapter.stat = jest.fn().mockResolvedValue({ size: 3 });
			adapter.readBinary
				.mockResolvedValueOnce(new Uint8Array([1, 2, 3]).buffer)
				.mockResolvedValueOnce(new Uint8Array([4, 5, 6]).buffer);
			const target = createTarget({
				segmentPaths: ['pcm1.tmp', 'pcm2.tmp'],
			});

			await finalizer.assembleWavFile(target, '/final.wav');

			const written = (mockApp.vault.createBinary as jest.Mock).mock
				.calls[0][1] as ArrayBuffer;
			// 44-byte header + 6 PCM bytes in capture order
			expect(written.byteLength).toBe(50);
			expect(Array.from(new Uint8Array(written).slice(44))).toEqual([
				1, 2, 3, 4, 5, 6,
			]);
			const { createWavHeader } = jest.requireMock(
				'../../src/recording/WavEncoder',
			);
			expect(createWavHeader).toHaveBeenCalledWith(1, 44100, 6);
			// The single-allocation path never calls the assembling helper
			const { assembleWavFromPcmSegments } = jest.requireMock(
				'../../src/recording/WavEncoder',
			);
			expect(assembleWavFromPcmSegments).not.toHaveBeenCalled();
		});

		it('should assemble segments and remove them', async () => {
			const target = createTarget({
				segmentPaths: ['pcm1.tmp', 'pcm2.tmp'],
			});

			await finalizer.assembleWavFile(target, '/final.wav');

			expect(mockApp.vault.createBinary).toHaveBeenCalledWith(
				'/final.wav',
				expect.any(ArrayBuffer),
			);
			expect(mockApp.vault.adapter.remove).toHaveBeenCalledTimes(2);
		});

		it('should keep the file and notify when segment removal fails', async () => {
			(mockApp.vault.adapter.remove as jest.Mock).mockRejectedValue(
				new Error('locked'),
			);
			const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
			const target = createTarget({ segmentPaths: ['pcm1.tmp'] });

			await finalizer.assembleWavFile(target, '/final.wav');

			expect(mockApp.vault.createBinary).toHaveBeenCalled();
			expect(
				getNotices().some((message) =>
					message.includes('temporary files could not be removed'),
				),
			).toBe(true);
			warnSpy.mockRestore();
		});
	});

	describe('saveRecording', () => {
		it('should finalize each track and insert links in multiple mode', async () => {
			buildFinalizer(createSession(), {
				...DEFAULT_SETTINGS,
				outputMode: 'multiple',
			});
			const targets = [
				createTarget({ segmentPaths: ['a-part1.webm.tmp'] }),
				createTarget({
					fileBaseName: 'recording-Track2-stamp',
					segmentPaths: ['b-part1.webm.tmp'],
				}),
			];

			await finalizer.saveRecording(targets, 'stamp', null);

			const { insertFileLinks } = jest.requireMock(
				'../../src/recording/NoteInserter',
			);
			expect(insertFileLinks).toHaveBeenCalledWith(
				[expect.any(String), expect.any(String)],
				null,
				mockApp,
			);
			expect(
				getNotices().some((message) =>
					message.includes('Saved 2 audio file(s)'),
				),
			).toBe(true);
		});

		it('should report when no audio data was recorded', async () => {
			buildFinalizer(createSession(), {
				...DEFAULT_SETTINGS,
				outputMode: 'multiple',
			});

			await finalizer.saveRecording([createTarget()], 'stamp', null);

			expect(getNotices()).toContain('No audio data recorded');
		});

		it('should fall back to WAV with a Notice for unsupported merged formats', async () => {
			buildFinalizer(createSession(), {
				...DEFAULT_SETTINGS,
				outputMode: 'single',
				recordingFormat: 'unsupported-format',
			});
			const targets = [
				createTarget({ segmentPaths: ['a.tmp'] }),
				createTarget({ segmentPaths: ['b.tmp'] }),
			];

			await finalizer.saveRecording(targets, 'stamp', null);

			expect(
				getNotices().some((message) =>
					message.includes('saved as .wav'),
				),
			).toBe(true);
			expect(mockApp.vault.createBinary).toHaveBeenCalledWith(
				expect.stringMatching(/multitrack-stamp\.wav$/),
				expect.any(ArrayBuffer),
			);
		});

		it('should stream-mix PCM sessions with WAV output', async () => {
			const { canStreamMix, mixPcmTracksToWav } = jest.requireMock(
				'../../src/recording/StreamingMixer',
			);
			const { mergeAudioTracks } = jest.requireMock(
				'../../src/recording/AudioFormatConverter',
			);
			buildFinalizer(createSession({ isWavPcm: true }), {
				...DEFAULT_SETTINGS,
				outputMode: 'single',
				recordingFormat: 'wav',
			});
			const targets = [
				createTarget({
					segmentPaths: ['a-pcm.tmp'],
					pcmSampleRate: 48000,
				}),
				createTarget({
					segmentPaths: ['b-pcm.tmp'],
					pcmSampleRate: 48000,
				}),
			];

			await finalizer.saveRecording(targets, 'stamp', null);

			expect(canStreamMix).toHaveBeenCalled();
			expect(mixPcmTracksToWav).toHaveBeenCalledWith(
				[
					expect.objectContaining({
						segmentPaths: ['a-pcm.tmp'],
						sampleRate: 48000,
					}),
					expect.objectContaining({
						segmentPaths: ['b-pcm.tmp'],
						sampleRate: 48000,
					}),
				],
				mockApp,
				expect.any(Function),
			);
			expect(mergeAudioTracks).not.toHaveBeenCalled();
			expect(mockApp.vault.createBinary).toHaveBeenCalledWith(
				expect.stringMatching(/multitrack-stamp\.wav$/),
				expect.any(ArrayBuffer),
			);
		});

		it('should fall back to the Web Audio mix when streaming is not possible', async () => {
			const { canStreamMix, mixPcmTracksToWav } = jest.requireMock(
				'../../src/recording/StreamingMixer',
			);
			const { mergeAudioTracks } = jest.requireMock(
				'../../src/recording/AudioFormatConverter',
			);
			(canStreamMix as jest.Mock).mockReturnValueOnce(false);
			buildFinalizer(createSession({ isWavPcm: true }), {
				...DEFAULT_SETTINGS,
				outputMode: 'single',
				recordingFormat: 'wav',
			});
			const targets = [
				createTarget({ segmentPaths: ['a-pcm.tmp'] }),
				createTarget({ segmentPaths: ['b-pcm.tmp'] }),
			];

			await finalizer.saveRecording(targets, 'stamp', null);

			expect(mixPcmTracksToWav).not.toHaveBeenCalled();
			expect(mergeAudioTracks).toHaveBeenCalled();
		});

		it('should keep compressed merged outputs on the Web Audio mix', async () => {
			const { mixPcmTracksToWav } = jest.requireMock(
				'../../src/recording/StreamingMixer',
			);
			const { mergeAudioTracks } = jest.requireMock(
				'../../src/recording/AudioFormatConverter',
			);
			buildFinalizer(createSession({ isWavPcm: true }), {
				...DEFAULT_SETTINGS,
				outputMode: 'single',
				recordingFormat: 'mp3',
			});
			const targets = [
				createTarget({ segmentPaths: ['a-pcm.tmp'] }),
				createTarget({ segmentPaths: ['b-pcm.tmp'] }),
			];

			await finalizer.saveRecording(targets, 'stamp', null);

			expect(mixPcmTracksToWav).not.toHaveBeenCalled();
			expect(mergeAudioTracks).toHaveBeenCalled();
		});

		it('should keep the merged file when cleanup fails', async () => {
			(mockApp.vault.adapter.remove as jest.Mock).mockRejectedValue(
				new Error('locked'),
			);
			const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
			buildFinalizer(createSession(), {
				...DEFAULT_SETTINGS,
				outputMode: 'single',
			});
			const targets = [
				createTarget({ segmentPaths: ['a.tmp'] }),
				createTarget({ segmentPaths: ['b.tmp'] }),
			];

			await finalizer.saveRecording(targets, 'stamp', null);

			// The merged file is the only complete copy of the audio of
			// segments removed by a partial cleanup: it must never be
			// rolled back
			expect(mockApp.vault.adapter.remove).not.toHaveBeenCalledWith(
				expect.stringMatching(/multitrack/),
			);
			expect(
				getNotices().some((notice) =>
					notice.startsWith(
						'Recording saved, but temporary files could not be removed:',
					),
				),
			).toBe(true);
			expect(getNotices()).toContain('Saved 1 audio file(s)');
			expect(consoleErrorSpy).toHaveBeenCalledWith(
				expect.stringContaining(
					'Temporary segment files could not be removed',
				),
				['a.tmp', 'b.tmp'],
			);
			warnSpy.mockRestore();
		});
	});
});
