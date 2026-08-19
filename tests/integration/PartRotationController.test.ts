/**
 * Unit tests for PartRotationController module.
 * Tests rotation gating, active-time accounting, rotation/stop races,
 * and part finalization error paths.
 * @module tests/unit/PartRotationController.test
 */

import { PartRotationController } from 'src/recording/PartRotationController';
import { at } from '../helpers/assertions';
import { DebugLogger } from 'src/utils/DebugLogger';
import { RecordingStatus } from 'src/types';
import type { RecordingSessionConfig, RecordingTarget } from 'src/types';
import {
	DEFAULT_SETTINGS,
	type AudioRecorderSettings,
} from 'src/settings/settingsSchema';
import { MS_PER_MINUTE } from 'src/constants';
import type { App } from 'obsidian';
import type { TrackWriteQueue } from 'src/recording/TrackWriteQueue';
import type { RecordingFinalizer } from 'src/recording/RecordingFinalizer';
import { noticeMessages } from '../mocks/obsidian';
import { createMockApp } from '../helpers/createApp';
import { createSession, createTarget } from '../helpers/recordingFixtures';

describe('PartRotationController', () => {
	let controller: PartRotationController;
	let hooks: {
		getTargets: jest.Mock;
		getStatus: jest.Mock;
		stopRecorders: jest.Mock;
		restartRecorders: jest.Mock;
	};
	let writeQueue: {
		drain: jest.Mock;
		flushChunkBuffer: jest.Mock;
		flushPcmBuffer: jest.Mock;
	};
	let finalizer: {
		finalizeSegmentsToFile: jest.Mock;
		assembleWavFile: jest.Mock;
	};
	let targets: RecordingTarget[];
	let mockApp: App;
	let mockSettings: AudioRecorderSettings;

	const buildController = (session: RecordingSessionConfig): void => {
		controller = new PartRotationController(
			mockApp,
			mockSettings,
			writeQueue as unknown as TrackWriteQueue,
			finalizer as unknown as RecordingFinalizer,
			new DebugLogger(mockSettings),
			hooks,
		);
		controller.beginSession(session);
	};

	beforeEach(() => {
		jest.useFakeTimers();
		jest.spyOn(console, 'error').mockImplementation();

		targets = [createTarget()];
		hooks = {
			getTargets: jest.fn(() => targets),
			getStatus: jest.fn(() => RecordingStatus.Recording),
			stopRecorders: jest.fn().mockResolvedValue(undefined),
			restartRecorders: jest.fn(),
		};
		writeQueue = {
			drain: jest.fn().mockResolvedValue(undefined),
			flushChunkBuffer: jest.fn().mockResolvedValue(undefined),
			flushPcmBuffer: jest.fn().mockResolvedValue(undefined),
		};
		finalizer = {
			finalizeSegmentsToFile: jest.fn().mockResolvedValue('/part.webm'),
			assembleWavFile: jest.fn().mockResolvedValue(undefined),
		};
		mockApp = createMockApp({
			vault: {
				adapter: {
					exists: jest.fn().mockResolvedValue(false),
				},
				createFolder: jest.fn().mockResolvedValue(undefined),
			},
			workspace: {
				getActiveFile: jest.fn().mockReturnValue(null),
			},
		}).app;
		mockSettings = { ...DEFAULT_SETTINGS };
		buildController(
			createSession({
				splitEnabled: true,
			}),
		);
	});

	afterEach(() => {
		jest.useRealTimers();
	});

	/** Advances fake time without running timer callbacks. */
	const advanceMinutes = (minutes: number): void => {
		jest.setSystemTime(Date.now() + minutes * MS_PER_MINUTE);
	};

	const rotationStarted = (): boolean =>
		hooks.stopRecorders.mock.calls.length > 0;

	describe('rotation gating', () => {
		it('does not rotate before the part boundary', () => {
			advanceMinutes(14);
			controller.maybeRotate();

			expect(rotationStarted()).toBe(false);
		});

		it('rotates once the active time reaches the boundary', async () => {
			advanceMinutes(15);
			controller.maybeRotate();
			await controller.waitForPendingRotation();

			expect(rotationStarted()).toBe(true);
			expect(hooks.restartRecorders).toHaveBeenCalled();
		});

		it('excludes paused time from the part accounting', () => {
			advanceMinutes(10);
			controller.markPaused();
			advanceMinutes(30);
			controller.markResumed();
			advanceMinutes(4);

			controller.maybeRotate();
			expect(rotationStarted()).toBe(false);

			advanceMinutes(1);
			controller.maybeRotate();
			expect(rotationStarted()).toBe(true);
		});

		it('does not rotate when auto-split is disabled', () => {
			buildController(
				createSession({
					splitEnabled: false,
				}),
			);
			advanceMinutes(60);
			controller.maybeRotate();

			expect(rotationStarted()).toBe(false);
		});

		it('does not rotate for PCM/WAV sessions', () => {
			buildController(
				createSession({
					splitEnabled: true,
					isWavPcm: true,
				}),
			);
			advanceMinutes(60);
			controller.maybeRotate();

			expect(rotationStarted()).toBe(false);
		});

		it('does not rotate while stopping', () => {
			advanceMinutes(60);
			controller.requestStop();
			controller.maybeRotate();

			expect(rotationStarted()).toBe(false);
		});

		it('does not rotate unless the status is Recording', () => {
			hooks.getStatus.mockReturnValue(RecordingStatus.Paused);
			advanceMinutes(60);
			controller.maybeRotate();

			expect(rotationStarted()).toBe(false);
		});

		it('does not start a second rotation while one is in flight', async () => {
			let releaseStop: () => void = () => undefined;
			hooks.stopRecorders.mockReturnValue(
				new Promise<void>((resolve) => {
					releaseStop = resolve;
				}),
			);
			advanceMinutes(15);
			controller.maybeRotate();
			controller.maybeRotate();

			expect(hooks.stopRecorders).toHaveBeenCalledTimes(1);
			releaseStop();
			await controller.waitForPendingRotation();
		});
	});

	describe('size-boundary rotation', () => {
		it('exposes the session size boundary to the chunk handler', () => {
			buildController(
				createSession({
					chunkRotationBytes: 1024,
					splitEnabled: false,
				}),
			);
			expect(controller.sizeRotationBytes()).toBe(1024);

			buildController(
				createSession({
					splitEnabled: true,
					chunkRotationBytes: null,
				}),
			);
			expect(controller.sizeRotationBytes()).toBeNull();
		});

		it('reports no size boundary outside a session', () => {
			controller = new PartRotationController(
				mockApp,
				mockSettings,
				writeQueue as unknown as TrackWriteQueue,
				finalizer as unknown as RecordingFinalizer,
				new DebugLogger(mockSettings),
				hooks,
			);
			expect(controller.sizeRotationBytes()).toBeNull();
		});

		it('rotates when a target buffer reaches the size boundary without auto-split', async () => {
			buildController(
				createSession({
					chunkRotationBytes: 1024,
					splitEnabled: false,
				}),
			);
			at(targets, 0).bufferedBytes = 1024;

			controller.maybeRotate();
			await controller.waitForPendingRotation();

			expect(hooks.stopRecorders).toHaveBeenCalled();
			expect(writeQueue.flushChunkBuffer).toHaveBeenCalled();
			expect(hooks.restartRecorders).toHaveBeenCalled();
		});

		it('does not rotate below the size boundary', () => {
			buildController(
				createSession({
					chunkRotationBytes: 1024,
					splitEnabled: false,
				}),
			);
			at(targets, 0).bufferedBytes = 1023;

			controller.maybeRotate();

			expect(hooks.stopRecorders).not.toHaveBeenCalled();
		});

		it('never size-rotates when the session allows plain flushes', () => {
			buildController(
				createSession({
					chunkRotationBytes: null,
					splitEnabled: false,
				}),
			);
			at(targets, 0).bufferedBytes = Number.MAX_SAFE_INTEGER;

			controller.maybeRotate();

			expect(hooks.stopRecorders).not.toHaveBeenCalled();
		});
	});

	describe('requestStop', () => {
		it('returns true once and false on reentry', () => {
			expect(controller.requestStop()).toBe(true);
			expect(controller.requestStop()).toBe(false);
		});

		it('res-arm on beginSession', () => {
			controller.requestStop();
			controller.beginSession(
				createSession({
					splitEnabled: true,
				}),
			);

			expect(controller.requestStop()).toBe(true);
		});
	});

	describe('rotation flow', () => {
		beforeEach(() => {
			advanceMinutes(15);
		});

		it('restarts the recorders before finalizing the snapshot', async () => {
			const order: string[] = [];
			writeQueue.flushChunkBuffer.mockImplementation(
				async (target: RecordingTarget) => {
					target.segmentPaths = ['seg1.tmp'];
					order.push('flush');
				},
			);
			hooks.restartRecorders.mockImplementation(() => {
				order.push('restart');
			});
			finalizer.finalizeSegmentsToFile.mockImplementation(async () => {
				order.push('finalize');
				return '/part1.webm';
			});

			controller.maybeRotate();
			await controller.waitForPendingRotation();

			expect(order).toEqual(['flush', 'restart', 'finalize']);
		});

		it('detaches the snapshot and record the finalized part', async () => {
			writeQueue.flushChunkBuffer.mockImplementation(
				async (target: RecordingTarget) => {
					target.segmentPaths = ['seg1.tmp', 'seg2.tmp'];
					target.segmentIndex = 2;
				},
			);

			controller.maybeRotate();
			await controller.waitForPendingRotation();

			expect(finalizer.finalizeSegmentsToFile).toHaveBeenCalledWith(
				['seg1.tmp', 'seg2.tmp'],
				expect.stringMatching(/-part1\.webm$/),
			);
			expect(at(targets, 0).partIndex).toBe(1);
			expect(at(targets, 0).partPaths).toEqual(['/part.webm']);
			expect(at(targets, 0).segmentPaths).toEqual([]);
			expect(at(targets, 0).segmentIndex).toBe(0);
		});

		it('does not restart when a stop arrived mid-rotation but still finalize', async () => {
			let releaseStop: () => void = () => undefined;
			hooks.stopRecorders.mockReturnValue(
				new Promise<void>((resolve) => {
					releaseStop = resolve;
				}),
			);
			writeQueue.flushChunkBuffer.mockImplementation(
				async (target: RecordingTarget) => {
					target.segmentPaths = ['seg1.tmp'];
				},
			);

			controller.maybeRotate();
			controller.requestStop();
			releaseStop();
			await controller.waitForPendingRotation();

			expect(hooks.restartRecorders).not.toHaveBeenCalled();
			expect(finalizer.finalizeSegmentsToFile).toHaveBeenCalled();
		});

		it('keeps buffered chunks and restart when the boundary flush fails', async () => {
			writeQueue.flushChunkBuffer.mockRejectedValue(
				new Error('disk full'),
			);
			at(targets, 0).bufferedChunks = [new Blob(['chunk'])];

			controller.maybeRotate();
			await controller.waitForPendingRotation();

			expect(at(targets, 0).bufferedChunks).toHaveLength(1);
			expect(hooks.restartRecorders).toHaveBeenCalled();
			expect(finalizer.finalizeSegmentsToFile).not.toHaveBeenCalled();
		});

		it('rolls back and re-attach the snapshot when finalization fails', async () => {
			writeQueue.flushChunkBuffer.mockImplementation(
				async (target: RecordingTarget) => {
					target.segmentPaths = ['seg1.tmp'];
				},
			);
			finalizer.finalizeSegmentsToFile.mockRejectedValue(
				new Error('encode failed'),
			);

			controller.maybeRotate();
			await controller.waitForPendingRotation();

			expect(at(targets, 0).partIndex).toBe(0);
			// Snapshot segments are re-attached in front of newer data
			expect(at(targets, 0).segmentPaths).toEqual(['seg1.tmp']);
			expect(
				noticeMessages().some((message) =>
					message.includes('Failed to save recording part'),
				),
			).toBe(true);
		});

		it('contains an unexpected rotation rejection', async () => {
			hooks.stopRecorders.mockRejectedValue(new Error('boom'));
			writeQueue.drain.mockRejectedValue(new Error('boom'));

			controller.maybeRotate();
			await expect(
				controller.waitForPendingRotation(),
			).resolves.toBeUndefined();
		});
	});

	describe('finalizePcmPart', () => {
		it('carries the overshoot into the next part on success', async () => {
			const target = createTarget({
				pcmBuffers: [new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer],
				pcmBufferedBytes: 8,
				partPcmBytes: 8,
			});
			writeQueue.flushPcmBuffer.mockImplementation(
				async (flushTarget: RecordingTarget) => {
					flushTarget.segmentPaths = ['pcm1.tmp'];
					flushTarget.pcmBuffers = [];
				},
			);

			// Part limit 6 bytes -> 2 bytes overshoot carried over
			await controller.finalizePcmPart(target, 6);

			expect(finalizer.assembleWavFile).toHaveBeenCalledWith(
				target,
				expect.stringMatching(/-part1\.wav$/),
			);
			expect(target.partIndex).toBe(1);
			expect(target.partPaths).toHaveLength(1);
			expect(target.pcmBufferedBytes).toBe(2);
			expect(target.partPcmBytes).toBe(2);
			expect(
				Array.from(new Uint8Array(at(target.pcmBuffers, 0))),
			).toEqual([7, 8]);
		});

		it('restores buffers with the carry re-attached on failure', async () => {
			const target = createTarget({
				pcmBuffers: [new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer],
				pcmBufferedBytes: 8,
				partPcmBytes: 8,
			});
			writeQueue.flushPcmBuffer.mockRejectedValue(new Error('disk full'));

			await controller.finalizePcmPart(target, 6);

			expect(target.partIndex).toBe(0);
			// All 8 bytes are retained (kept head + re-attached carry)
			const totalBytes = target.pcmBuffers.reduce(
				(sum, buffer) => sum + buffer.byteLength,
				0,
			);
			expect(totalBytes).toBe(8);
			expect(target.pcmBufferedBytes).toBe(8);
			// Accounting restarts so the retry happens one part later
			expect(target.partPcmBytes).toBe(0);
		});

		it('resets segments without a part when nothing was flushed', async () => {
			const target = createTarget({ partPcmBytes: 4 });

			await controller.finalizePcmPart(target, 4);

			expect(finalizer.assembleWavFile).not.toHaveBeenCalled();
			expect(target.partIndex).toBe(1);
			expect(target.partPaths).toHaveLength(0);
		});
	});

	describe('getCurrentPartPosition', () => {
		it('reports the whole-session offset when auto-split is off', () => {
			buildController(
				createSession({
					splitEnabled: false,
				}),
			);

			jest.advanceTimersByTime(5000);

			expect(
				controller.getCurrentPartPosition(RecordingStatus.Recording),
			).toEqual({ partOrdinal: 0, offsetSeconds: 5 });
		});

		it('is zero immediately after the session starts', () => {
			buildController(
				createSession({
					splitEnabled: false,
				}),
			);

			expect(
				controller.getCurrentPartPosition(RecordingStatus.Recording),
			).toEqual({ partOrdinal: 0, offsetSeconds: 0 });
		});

		it('excludes paused time from the offset', () => {
			buildController(
				createSession({
					splitEnabled: false,
				}),
			);

			jest.advanceTimersByTime(3000);
			controller.markPaused();
			jest.advanceTimersByTime(4000);

			expect(
				controller.getCurrentPartPosition(RecordingStatus.Paused),
			).toEqual({ partOrdinal: 0, offsetSeconds: 3 });
		});

		it('resumes counting active time after a pause', () => {
			buildController(
				createSession({
					splitEnabled: false,
				}),
			);

			jest.advanceTimersByTime(3000);
			controller.markPaused();
			jest.advanceTimersByTime(4000);
			controller.markResumed();
			jest.advanceTimersByTime(2000);

			expect(
				controller.getCurrentPartPosition(RecordingStatus.Recording),
			).toEqual({ partOrdinal: 0, offsetSeconds: 5 });
		});

		it('derives the PCM split ordinal and offset from the session clock', () => {
			buildController(
				createSession({
					isWavPcm: true,
					splitEnabled: true,
					partMinutes: 1,
				}),
			);

			jest.advanceTimersByTime(90_000);

			expect(
				controller.getCurrentPartPosition(RecordingStatus.Recording),
			).toEqual({ partOrdinal: 1, offsetSeconds: 30 });
		});

		it('advances the compressed part ordinal after a rotation', async () => {
			buildController(
				createSession({
					splitEnabled: true,
					partMinutes: 15,
				}),
			);

			jest.advanceTimersByTime(15 * MS_PER_MINUTE);
			controller.maybeRotate();
			await controller.waitForPendingRotation();

			const position = controller.getCurrentPartPosition(
				RecordingStatus.Recording,
			);
			expect(position.partOrdinal).toBe(1);
			expect(position.offsetSeconds).toBeLessThan(1);
		});
	});

	describe('getSessionActiveMs', () => {
		it('is zero immediately after the session starts', () => {
			expect(
				controller.getSessionActiveMs(RecordingStatus.Recording),
			).toBe(0);
		});

		it('counts active wall-clock time while recording', () => {
			jest.advanceTimersByTime(5000);

			expect(
				controller.getSessionActiveMs(RecordingStatus.Recording),
			).toBe(5000);
		});

		it('freezes during a pause and excludes the paused span', () => {
			jest.advanceTimersByTime(3000);
			controller.markPaused();
			jest.advanceTimersByTime(4000);

			// Frozen at the active time accumulated before the pause
			expect(controller.getSessionActiveMs(RecordingStatus.Paused)).toBe(
				3000,
			);
		});

		it('resumes counting after a pause, never counting paused time', () => {
			jest.advanceTimersByTime(3000);
			controller.markPaused();
			jest.advanceTimersByTime(4000);
			controller.markResumed();
			jest.advanceTimersByTime(2000);

			expect(
				controller.getSessionActiveMs(RecordingStatus.Recording),
			).toBe(5000);
		});

		it('keeps accumulating across an auto-split rotation', async () => {
			jest.advanceTimersByTime(15 * MS_PER_MINUTE);
			controller.maybeRotate();
			await controller.waitForPendingRotation();
			jest.advanceTimersByTime(2000);

			// Whole-session active time spans both parts
			expect(
				controller.getSessionActiveMs(RecordingStatus.Recording),
			).toBe(15 * MS_PER_MINUTE + 2000);
		});
	});
});
