/**
 * Unit tests for RecordingFinalizer module.
 * Tests finalization paths, cleanup error handling, and progress
 * deduplication.
 * @module tests/unit/RecordingFinalizer.test
 */

import { RecordingFinalizer } from 'src/recording/RecordingFinalizer';
import { TrackWriteQueue } from 'src/recording/TrackWriteQueue';
import { DebugLogger } from 'src/utils/DebugLogger';
import type { RecordingSessionConfig } from 'src/types';
import {
	DEFAULT_SETTINGS,
	type AudioRecorderSettings,
} from 'src/settings/settingsSchema';
import type { App } from 'obsidian';
import { at, defined } from '../helpers/assertions';
import { Notice } from 'obsidian';
import { WAV_HEADER_BYTES } from '../mocks/modules/wavEncoder';
import { createMockApp } from '../helpers/createApp';
import {
	convertBlobToFormatBuffer,
	convertBlobToWavBuffer,
	mergeAudioTracks,
} from 'src/audio/AudioFormatConverter';
import {
	assembleWavFromPcmSegmentFiles,
	WavSizeLimitError,
} from 'src/audio/WavEncoder';
import { insertFileLinks } from 'src/recording/NoteInserter';
import { canStreamMix, mixPcmTracksToWav } from 'src/recording/StreamingMixer';
import { createSession, createTarget } from '../helpers/recordingFixtures';

jest.mock('src/audio/WavEncoder', () => require('../mocks/modules/wavEncoder'));

jest.mock('src/audio/AudioEncoder', () => ({
	isOfflineEncodingSupported: jest.fn((format: string) =>
		['mp3', 'flac', 'webm', 'ogg', 'mp4', 'm4a', 'aac'].includes(format),
	),
}));

jest.mock('src/audio/AudioFormatConverter', () => ({
	mergeAudioTracks: jest
		.fn()
		.mockResolvedValue(new Blob(['merged'], { type: 'audio/wav' })),
	convertBlobToWavBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(8)),
	convertBlobToFormatBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(8)),
	getRecorderMediaType: jest.fn((format: string) => `audio/${format}`),
	isOfflineOnlyFormat: jest.fn(
		(format: string, recorderFormat: string) =>
			format !== 'wav' && format !== recorderFormat,
	),
}));

jest.mock('src/recording/NoteInserter', () => ({
	insertFileLinks: jest.fn(),
}));

jest.mock('src/recording/StreamingMixer', () => ({
	canStreamMix: jest.fn().mockReturnValue(true),
	mixPcmTracksToWav: jest.fn().mockResolvedValue(new ArrayBuffer(50)),
}));

describe('RecordingFinalizer', () => {
	let finalizer: RecordingFinalizer;
	let queue: TrackWriteQueue;
	let mockApp: App;
	let mockSettings: AudioRecorderSettings;
	let onProgress: jest.Mock;
	let consoleErrorSpy: jest.SpyInstance;

	const getNotices = (): string[] => {
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
		consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();

		mockApp = createMockApp({
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
		}).app;
		mockSettings = { ...DEFAULT_SETTINGS };
		onProgress = jest.fn();
		buildFinalizer(createSession({ outputMode: 'single' }));
	});

	describe('reportProgress', () => {
		it('deduplicates identical whole-percent updates', () => {
			finalizer.reportProgress(50.2, 'Encoding...');
			finalizer.reportProgress(50.4, 'Encoding...');

			expect(onProgress).toHaveBeenCalledTimes(1);
			expect(onProgress).toHaveBeenCalledWith({
				percent: 50,
				description: 'Encoding...',
			});
		});

		it('passes through changed descriptions', () => {
			finalizer.reportProgress(50, 'Encoding...');
			finalizer.reportProgress(50, 'Writing...');

			expect(onProgress).toHaveBeenCalledTimes(2);
		});

		it('resets deduplication on beginSession', () => {
			finalizer.reportProgress(50, 'Encoding...');
			finalizer.beginSession(createSession({ outputMode: 'single' }));
			finalizer.reportProgress(50, 'Encoding...');

			expect(onProgress).toHaveBeenCalledTimes(2);
		});
	});

	describe('finalizeSegmentsToFile', () => {
		it('returns null for an empty segment list', async () => {
			const result = await finalizer.finalizeSegmentsToFile(
				[],
				'final.webm',
			);

			expect(result).toBeNull();
			expect(mockApp.vault.createBinary).not.toHaveBeenCalled();
		});

		it('passes segments through unchanged for the recorder format', async () => {
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

		it('converts to WAV when the output format is wav', async () => {
			buildFinalizer(createSession({ outputFormat: 'wav' }));

			await finalizer.finalizeSegmentsToFile(['seg1.tmp'], 'final.wav');

			expect(jest.mocked(convertBlobToWavBuffer)).toHaveBeenCalled();
		});

		it('res-encode offline-only formats with remux allowed and mapped progress', async () => {
			buildFinalizer(createSession({ outputFormat: 'mp3' }));

			await finalizer.finalizeSegmentsToFile(
				['seg1.tmp'],
				'final.mp3',
				true,
			);

			expect(jest.mocked(convertBlobToFormatBuffer)).toHaveBeenCalledWith(
				expect.any(Blob),
				'mp3',
				128000,
				expect.any(Function),
				{ allowRemux: true, workerClient: null },
			);
			// The encoder progress callback maps into the 40-60% band
			const progressCallback = (convertBlobToFormatBuffer as jest.Mock)
				.mock.calls[0][3] as (percent: number) => void;
			progressCallback(50);
			expect(onProgress).toHaveBeenCalledWith({
				percent: 50,
				description: 'Encoding audio...',
			});
		});

		it('keeps the final file and notify when segment cleanup fails', async () => {
			(mockApp.vault.adapter.remove as jest.Mock).mockRejectedValue(
				new Error('locked'),
			);
			jest.spyOn(console, 'warn').mockImplementation();

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
		});
	});

	describe('assembleWavFile', () => {
		it('delegates assembly to the shared single-allocation helper', async () => {
			const target = createTarget({
				segmentPaths: ['pcm1.tmp', 'pcm2.tmp'],
				pcmChannels: 2,
				pcmSampleRate: 48000,
			});

			await finalizer.assembleWavFile(target, '/final.wav');

			// The streaming behavior itself is covered by the WavEncoder
			// suite; the finalizer must hand over the capture-order
			// segment list and the track's PCM layout
			expect(
				jest.mocked(assembleWavFromPcmSegmentFiles),
			).toHaveBeenCalledWith(['pcm1.tmp', 'pcm2.tmp'], 2, 48000, mockApp);
			// What the assembler returned is what gets written, unchanged.
			const written = at(
				at(jest.mocked(mockApp.vault.createBinary).mock.calls, 0),
				1,
			);
			expect((written as ArrayBuffer).byteLength).toBe(WAV_HEADER_BYTES);
		});

		it('assembles segments and remove them', async () => {
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

		// Until the file is written the audio exists only in those segments, so
		// a refused assembly - a recording past the container ceiling - has to
		// leave them where the recovery journal can still find them.
		it('keeps the segments when the assembly refuses the recording', async () => {
			jest.mocked(assembleWavFromPcmSegmentFiles).mockRejectedValueOnce(
				new Error('This recording is too long for a WAV file'),
			);
			const target = createTarget({ segmentPaths: ['pcm1.tmp'] });

			await expect(
				finalizer.assembleWavFile(target, '/final.wav'),
			).rejects.toThrow(/too long for a WAV file/);

			expect(mockApp.vault.createBinary).not.toHaveBeenCalled();
			expect(mockApp.vault.adapter.remove).not.toHaveBeenCalled();
		});

		it('keeps the file and notify when segment removal fails', async () => {
			(mockApp.vault.adapter.remove as jest.Mock).mockRejectedValue(
				new Error('locked'),
			);
			jest.spyOn(console, 'warn').mockImplementation();
			const target = createTarget({ segmentPaths: ['pcm1.tmp'] });

			await finalizer.assembleWavFile(target, '/final.wav');

			// The assembled recording is the point: a segment that would not
			// delete must not cost the user the file it was assembled into.
			expect(mockApp.vault.createBinary).toHaveBeenCalledWith(
				'/final.wav',
				expect.any(ArrayBuffer),
			);
			expect(
				getNotices().some((message) =>
					message.includes('temporary files could not be removed'),
				),
			).toBe(true);
		});
	});

	describe('saveRecording', () => {
		it('finalizes each track and insert links in multiple mode', async () => {
			buildFinalizer(createSession({ outputMode: 'multiple' }));
			const targets = [
				createTarget({ segmentPaths: ['a-part1.webm.tmp'] }),
				createTarget({
					fileBaseName: 'recording-Track2-stamp',
					segmentPaths: ['b-part1.webm.tmp'],
				}),
			];

			await finalizer.saveRecording(targets, 'stamp', null);

			expect(jest.mocked(insertFileLinks)).toHaveBeenCalledWith(
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

		it('reports when no audio data was recorded', async () => {
			buildFinalizer(createSession({ outputMode: 'multiple' }));

			await finalizer.saveRecording([createTarget()], 'stamp', null);

			expect(getNotices()).toContain('No audio data recorded');
		});

		it('returns the audio paths and the note the links landed in', async () => {
			// The post-save hook (transcribe-on-save) targets this note, so the
			// path inserted into must be threaded back out of saveRecording.
			buildFinalizer(createSession({ outputMode: 'multiple' }));
			(insertFileLinks as jest.Mock).mockReturnValue('notes/daily.md');
			const targets = [
				createTarget({ segmentPaths: ['a-part1.webm.tmp'] }),
			];

			const result = await finalizer.saveRecording(
				targets,
				'stamp',
				null,
			);

			expect(result.audioPaths.length).toBeGreaterThan(0);
			expect(result.notePath).toBe('notes/daily.md');
		});

		it('returns an empty result with no note when nothing was recorded', async () => {
			buildFinalizer(createSession({ outputMode: 'multiple' }));

			const result = await finalizer.saveRecording(
				[createTarget()],
				'stamp',
				null,
			);

			expect(result.audioPaths).toEqual([]);
			expect(result.notePath).toBeNull();
		});

		// The recording-marker feature resolves each marker to a file via
		// these per-track groups, so the grouping must always flatten back
		// to audioPaths in order across every output topology.
		const flattenTrackFiles = (files?: { files: string[] }[]): string[] =>
			(files ?? []).flatMap((group) => group.files);

		it('groups files per track in multiple mode', async () => {
			buildFinalizer(createSession({ outputMode: 'multiple' }));
			const targets = [
				createTarget({ segmentPaths: ['a-part1.webm.tmp'] }),
				createTarget({
					fileBaseName: 'recording-Track2-stamp',
					segmentPaths: ['b-part1.webm.tmp'],
				}),
			];

			const result = await finalizer.saveRecording(
				targets,
				'stamp',
				null,
			);

			expect(result.trackFiles).toHaveLength(2);
			expect(result.trackFiles?.map((group) => group.trackIndex)).toEqual(
				[0, 1],
			);
			expect(flattenTrackFiles(result.trackFiles)).toEqual(
				result.audioPaths,
			);
		});

		it('groups a split track as its parts followed by the residual', async () => {
			buildFinalizer(
				createSession({ outputMode: 'single', splitEnabled: true }),
			);
			const target = createTarget({
				partPaths: ['rec-part1.webm'],
				partIndex: 1,
				segmentPaths: ['rec-part2.webm.tmp'],
			});

			const result = await finalizer.saveRecording(
				[target],
				'stamp',
				null,
			);

			expect(result.trackFiles).toHaveLength(1);
			expect(at(defined(result.trackFiles), 0).trackIndex).toBe(0);
			expect(at(at(defined(result.trackFiles), 0).files, 0)).toBe(
				'rec-part1.webm',
			);
			expect(flattenTrackFiles(result.trackFiles)).toEqual(
				result.audioPaths,
			);
		});

		it('groups a merged multi-track recording as a single file', async () => {
			buildFinalizer(createSession({ outputMode: 'single' }));
			const targets = [
				createTarget({ segmentPaths: ['a.tmp'] }),
				createTarget({
					fileBaseName: 'recording-Track2-stamp',
					segmentPaths: ['b.tmp'],
				}),
			];

			const result = await finalizer.saveRecording(
				targets,
				'stamp',
				null,
			);

			expect(result.trackFiles).toHaveLength(1);
			expect(at(defined(result.trackFiles), 0).trackIndex).toBe(0);
			expect(result.audioPaths).toHaveLength(1);
			expect(flattenTrackFiles(result.trackFiles)).toEqual(
				result.audioPaths,
			);
		});

		it('keeps the grouping empty when nothing was recorded', async () => {
			buildFinalizer(createSession({ outputMode: 'multiple' }));

			const result = await finalizer.saveRecording(
				[createTarget()],
				'stamp',
				null,
			);

			expect(flattenTrackFiles(result.trackFiles)).toEqual([]);
			expect(result.audioPaths).toEqual([]);
		});

		it('follows the session outputMode snapshot over live settings', async () => {
			// The live settings switched to 'single' mid-recording; the
			// session snapshot taken at start must keep the per-track
			// finalization, or the parts already saved by auto-split
			// would silently vanish from the inserted links
			buildFinalizer(createSession({ outputMode: 'multiple' }), {
				...DEFAULT_SETTINGS,
				outputMode: 'single',
			});
			const targets = [
				createTarget({
					segmentPaths: ['a-part2.webm.tmp'],
					partPaths: ['a-part1.webm'],
					partIndex: 1,
				}),
				createTarget({
					fileBaseName: 'recording-Track2-stamp',
					segmentPaths: ['b-part1.webm.tmp'],
				}),
			];

			await finalizer.saveRecording(targets, 'stamp', null);

			expect(jest.mocked(mergeAudioTracks)).not.toHaveBeenCalled();
			expect(jest.mocked(insertFileLinks)).toHaveBeenCalledWith(
				expect.arrayContaining(['a-part1.webm']),
				null,
				mockApp,
			);
		});

		it('falls back to WAV with a Notice for unsupported merged formats', async () => {
			buildFinalizer(
				createSession({
					outputMode: 'single',
					outputFormat: 'unsupported-format',
				}),
			);
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

		it('streams-mix PCM sessions with WAV output', async () => {
			buildFinalizer(
				createSession({
					isWavPcm: true,
					outputMode: 'single',
					outputFormat: 'wav',
				}),
			);
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

			expect(jest.mocked(canStreamMix)).toHaveBeenCalled();
			expect(jest.mocked(mixPcmTracksToWav)).toHaveBeenCalledWith(
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
			expect(jest.mocked(mergeAudioTracks)).not.toHaveBeenCalled();
			expect(mockApp.vault.createBinary).toHaveBeenCalledWith(
				expect.stringMatching(/multitrack-stamp\.wav$/),
				expect.any(ArrayBuffer),
			);
		});

		it('falls back to the Web Audio mix when streaming is not possible', async () => {
			(canStreamMix as jest.Mock).mockReturnValueOnce(false);
			buildFinalizer(
				createSession({
					isWavPcm: true,
					outputMode: 'single',
					outputFormat: 'wav',
				}),
			);
			const targets = [
				createTarget({ segmentPaths: ['a-pcm.tmp'] }),
				createTarget({ segmentPaths: ['b-pcm.tmp'] }),
			];

			await finalizer.saveRecording(targets, 'stamp', null);

			expect(jest.mocked(mixPcmTracksToWav)).not.toHaveBeenCalled();
			// The resolved target format and the session bitrate are
			// passed in; the mix never re-reads live settings
			expect(jest.mocked(mergeAudioTracks)).toHaveBeenCalledWith(
				targets,
				'wav',
				128000,
				true,
				expect.any(Function),
				expect.any(Function),
				expect.any(Function),
			);
		});

		// Every other streaming-mix failure is a reason to mix another way, so
		// the fallback answers them all. The container ceiling is the one that
		// belongs to the audio rather than to the route: the Web Audio mix
		// builds the same oversized WAV through mediabunny, where nothing
		// checks the ceiling at all, and the message naming auto-split - the
		// one thing that makes a session this long saveable - is lost on the
		// way to a mix that cannot succeed either.
		it('refuses a mix past the container ceiling instead of falling back', async () => {
			jest.mocked(mixPcmTracksToWav).mockRejectedValueOnce(
				new WavSizeLimitError(),
			);
			buildFinalizer(
				createSession({
					isWavPcm: true,
					outputMode: 'single',
					outputFormat: 'wav',
				}),
			);
			const targets = [
				createTarget({ segmentPaths: ['a-pcm.tmp'] }),
				createTarget({ segmentPaths: ['b-pcm.tmp'] }),
			];

			await expect(
				finalizer.saveRecording(targets, 'stamp', null),
			).rejects.toThrow(/cannot exceed 4 GB/);

			expect(jest.mocked(mergeAudioTracks)).not.toHaveBeenCalled();
			expect(mockApp.vault.createBinary).not.toHaveBeenCalled();
		});

		it('keeps compressed merged outputs on the Web Audio mix', async () => {
			buildFinalizer(
				createSession({
					isWavPcm: true,
					outputMode: 'single',
					outputFormat: 'mp3',
				}),
			);
			const targets = [
				createTarget({ segmentPaths: ['a-pcm.tmp'] }),
				createTarget({ segmentPaths: ['b-pcm.tmp'] }),
			];

			await finalizer.saveRecording(targets, 'stamp', null);

			expect(jest.mocked(mixPcmTracksToWav)).not.toHaveBeenCalled();
			expect(jest.mocked(mergeAudioTracks)).toHaveBeenCalled();
		});

		it('keeps the merged file when cleanup fails', async () => {
			(mockApp.vault.adapter.remove as jest.Mock).mockRejectedValue(
				new Error('locked'),
			);
			jest.spyOn(console, 'warn').mockImplementation();
			buildFinalizer(createSession({ outputMode: 'single' }));
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
		});
	});
});
