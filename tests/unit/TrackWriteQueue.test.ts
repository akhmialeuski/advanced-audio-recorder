/**
 * Unit tests for TrackWriteQueue module.
 * Tests chain serialization, failure containment, and buffer flushes.
 * @module tests/unit/TrackWriteQueue.test
 */

import { TrackWriteQueue } from 'src/recording/TrackWriteQueue';
import type { RecordingSessionConfig, RecordingTarget } from 'src/types';
import {
	DEFAULT_SETTINGS,
	type AudioRecorderSettings,
} from 'src/settings/settingsSchema';
import type { App } from 'obsidian';
import { Notice } from 'obsidian';

const createTarget = (): RecordingTarget => ({
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
});

const createSession = (
	overrides: Partial<RecordingSessionConfig> = {},
): RecordingSessionConfig => ({
	chunkRotationBytes: null,
	isWavPcm: false,
	recorderFormat: 'webm',
	outputFormat: 'webm',
	outputMode: 'multiple',
	bitrate: 128000,
	splitEnabled: false,
	partMinutes: 15,
	partSuffix: 'part',
	...overrides,
});

describe('TrackWriteQueue', () => {
	let queue: TrackWriteQueue;
	let mockApp: App;
	let mockSettings: AudioRecorderSettings;
	let consoleErrorSpy: jest.SpyInstance;

	const getNoticeCalls = (): unknown[][] => {
		return jest.mocked(Notice).mock.calls;
	};

	beforeEach(() => {
		consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();

		mockApp = {
			vault: {
				adapter: {
					exists: jest.fn().mockResolvedValue(false),
					writeBinary: jest.fn().mockResolvedValue(undefined),
				},
				createBinary: jest.fn().mockResolvedValue(undefined),
				createFolder: jest.fn().mockResolvedValue(undefined),
			},
			workspace: {
				getActiveFile: jest.fn().mockReturnValue(null),
			},
		} as unknown as App;
		mockSettings = { ...DEFAULT_SETTINGS };
		queue = new TrackWriteQueue(mockApp, mockSettings);
		queue.beginSession(createSession());
	});

	afterEach(() => {
		consoleErrorSpy.mockRestore();
	});

	describe('enqueue', () => {
		it('should run tasks of one target in FIFO order', async () => {
			const target = createTarget();
			const order: number[] = [];

			void queue.enqueue(target, async () => {
				// A real delay inside the task, not a wait on the queue: the
				// point is that a slow task still finishes before the one
				// queued behind it.
				await new Promise((resolve) => setTimeout(resolve, 10));
				order.push(1);
			});
			void queue.enqueue(target, async () => {
				order.push(2);
				return Promise.resolve();
			});
			await queue.drain([target]);

			expect(order).toEqual([1, 2]);
		});

		it('should not let targets block each other', async () => {
			const slow = createTarget();
			const fast = createTarget();
			const order: string[] = [];

			void queue.enqueue(slow, async () => {
				// Slow enough that the fast target must have finished first
				// for the assertion below to mean anything.
				await new Promise((resolve) => setTimeout(resolve, 20));
				order.push('slow');
			});
			await queue.enqueue(fast, async () => {
				order.push('fast');
				return Promise.resolve();
			});

			expect(order).toEqual(['fast']);
			await queue.drain([slow, fast]);
		});

		it('should contain a failing task and keep the chain alive', async () => {
			const target = createTarget();
			const order: string[] = [];

			const failed = queue.enqueue(target, () =>
				Promise.reject(new Error('disk full')),
			);
			await expect(failed).resolves.toBeUndefined();

			await queue.enqueue(target, async () => {
				order.push('after-failure');
				return Promise.resolve();
			});

			expect(order).toEqual(['after-failure']);
			await expect(target.pendingWrite).resolves.toBeUndefined();
		});

		it('should notify once per failure streak', async () => {
			const target = createTarget();

			await queue.enqueue(target, () =>
				Promise.reject(new Error('failure 1')),
			);
			await queue.enqueue(target, () =>
				Promise.reject(new Error('failure 2')),
			);

			expect(getNoticeCalls()).toHaveLength(1);
		});

		it('should re-arm the failure Notice after a successful flush', async () => {
			const target = createTarget();

			await queue.enqueue(target, () =>
				Promise.reject(new Error('failure 1')),
			);
			expect(getNoticeCalls()).toHaveLength(1);

			target.pcmBuffers = [new Int16Array([1, 2]).buffer];
			await queue.flushPcmBuffer(target);

			await queue.enqueue(target, () =>
				Promise.reject(new Error('failure 2')),
			);
			expect(getNoticeCalls()).toHaveLength(2);
		});

		it('should re-arm the failure Notice on beginSession', async () => {
			const target = createTarget();

			await queue.enqueue(target, () =>
				Promise.reject(new Error('failure 1')),
			);
			queue.beginSession(createSession());
			await queue.enqueue(target, () =>
				Promise.reject(new Error('failure 2')),
			);

			expect(getNoticeCalls()).toHaveLength(2);
		});
	});

	describe('flushPcmBuffer', () => {
		it('should be a no-op for an empty buffer', async () => {
			const target = createTarget();

			await queue.flushPcmBuffer(target);

			expect(mockApp.vault.adapter.writeBinary).not.toHaveBeenCalled();
			expect(target.segmentIndex).toBe(0);
		});

		it('should merge buffers in capture order into one segment', async () => {
			const target = createTarget();
			target.pcmBuffers = [
				new Uint8Array([1, 2]).buffer,
				new Uint8Array([3, 4]).buffer,
			];
			target.pcmBufferedBytes = 4;

			await queue.flushPcmBuffer(target);

			const writeBinary = mockApp.vault.adapter.writeBinary as jest.Mock;
			expect(writeBinary).toHaveBeenCalledWith(
				expect.stringMatching(/-pcm-part1\.tmp$/),
				expect.any(ArrayBuffer),
			);
			const written = new Uint8Array(
				writeBinary.mock.calls[0][1] as ArrayBuffer,
			);
			expect(Array.from(written)).toEqual([1, 2, 3, 4]);
			expect(target.pcmBuffers).toEqual([]);
			expect(target.pcmBufferedBytes).toBe(0);
			expect(target.segmentIndex).toBe(1);
			expect(target.segmentPaths).toHaveLength(1);
		});

		it('should keep the buffer and index when the write fails', async () => {
			const target = createTarget();
			target.pcmBuffers = [new Uint8Array([1, 2]).buffer];
			target.pcmBufferedBytes = 2;
			jest.mocked(
				mockApp.vault.adapter.writeBinary,
			).mockRejectedValueOnce(new Error('disk full'));

			await expect(queue.flushPcmBuffer(target)).rejects.toThrow(
				'disk full',
			);

			expect(target.pcmBuffers).toHaveLength(1);
			expect(target.segmentIndex).toBe(0);
			expect(target.segmentPaths).toHaveLength(0);
		});
	});

	describe('flushChunkBuffer', () => {
		it('should be a no-op for an empty buffer', async () => {
			const target = createTarget();

			await queue.flushChunkBuffer(target);

			expect(mockApp.vault.adapter.writeBinary).not.toHaveBeenCalled();
			expect(mockApp.vault.createBinary).not.toHaveBeenCalled();
		});

		it('should write raw chunks as a .tmp segment in the recorder container', async () => {
			const target = createTarget();
			target.bufferedChunks = [new Blob(['chunk'])];
			target.bufferedBytes = 5;

			await queue.flushChunkBuffer(target);

			expect(mockApp.vault.adapter.writeBinary).toHaveBeenCalledWith(
				expect.stringMatching(/-part1\.webm\.tmp$/),
				expect.any(ArrayBuffer),
			);
			expect(target.bufferedChunks).toEqual([]);
			expect(target.bufferedBytes).toBe(0);
			expect(target.segmentIndex).toBe(1);
		});

		it('names the segment from the session snapshot, not live settings', async () => {
			// A settings change mid-recording must not switch the segment
			// container: the chunks were captured in the session's format
			queue.beginSession(createSession({ recorderFormat: 'mp4' }));
			queue.updateSettings({
				...DEFAULT_SETTINGS,
				recordingFormat: 'mp3',
			});
			const target = createTarget();
			target.bufferedChunks = [new Blob(['chunk'])];
			target.bufferedBytes = 5;

			await queue.flushChunkBuffer(target);

			expect(mockApp.vault.adapter.writeBinary).toHaveBeenCalledWith(
				expect.stringMatching(/-part1\.mp4\.tmp$/),
				expect.any(ArrayBuffer),
			);
			expect(mockApp.vault.createBinary).not.toHaveBeenCalled();
		});

		it('should throw when used outside a session', async () => {
			const freshQueue = new TrackWriteQueue(mockApp, mockSettings);
			const target = createTarget();
			target.bufferedChunks = [new Blob(['chunk'])];

			await expect(freshQueue.flushChunkBuffer(target)).rejects.toThrow(
				'No active recording session',
			);
		});
	});
});
