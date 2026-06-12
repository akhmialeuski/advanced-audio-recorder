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

		it('should roll back the merged file when cleanup fails', async () => {
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

			await expect(
				finalizer.saveRecording(targets, 'stamp', null),
			).rejects.toThrow('kept for recovery');
			warnSpy.mockRestore();
		});
	});
});
