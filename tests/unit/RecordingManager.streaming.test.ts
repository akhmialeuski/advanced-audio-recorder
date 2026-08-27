/**
 * Unit tests for RecordingManager streaming behavior: chunk buffering
 * and segment flushes, write chain containment, and auto-split part
 * rotation.
 * @module tests/unit/RecordingManager.streaming.test
 */

import { RecordingManager } from 'src/recording/RecordingManager';
import { at, defined } from '../helpers/assertions';
import { RecordingStatus } from 'src/types';
import {
	DEFAULT_SETTINGS,
	type AudioRecorderSettings,
} from 'src/settings/settingsSchema';
import type { App } from 'obsidian';
import {
	createDesktopRecorder,
	createRecordingSut,
	getChunkTarget,
	installMediaRecorder,
	installMediaRecorderFactory,
	installRecordingMediaStubs,
	makeMediaRecorderDouble,
	recordingManagerOver,
	stubAudioStreams,
	type MockMediaRecorder,
	type MutableTarget,
} from '../helpers/recordingManagerTestKit';
import {
	setPlatform,
	useDesktopPlatform,
	useMobilePlatform,
} from '../helpers/platform';
import { flushMicrotasks } from '../helpers/async';
import { Notice } from 'obsidian';
import { internalsOf } from '../helpers/doubles';
import { PcmStreamRecorder } from 'src/recording/PcmStreamRecorder';
import { WAV_PCM_WARNING_BYTES } from 'src/audio/WavEncoder';
import { tickTimes } from '../helpers/async';

// Mock AudioStreamHandler
jest.mock('src/recording/AudioStreamHandler', () =>
	require('../mocks/modules/audioStreamHandler'),
);

// Mock AudioEncoder module to avoid mediabunny TextDecoder requirement
jest.mock('src/audio/AudioEncoder', () =>
	require('../mocks/modules/audioEncoder'),
);

// Mock WavEncoder
jest.mock('src/audio/WavEncoder', () => require('../mocks/modules/wavEncoder'));

jest.mock('src/recording/PcmStreamRecorder', () =>
	require('../mocks/modules/pcmStreamRecorder'),
);

/**
 * The chunk callback the manager gave one of the PCM recorders it built.
 * @param track - Index of the recorder, in the order the manager built them
 * @returns The callback that recorder reports captured audio through
 */
function pcmChunkCallback(track = 0): (data: ArrayBuffer) => void {
	return at(jest.mocked(PcmStreamRecorder).mock.calls, track)[2];
}

installRecordingMediaStubs();

describe('RecordingManager', () => {
	let manager: RecordingManager;
	let mockApp: App;
	let mockSettings: AudioRecorderSettings;
	let statusChangeCallback: jest.Mock;

	beforeEach(() => {
		jest.spyOn(console, 'error').mockImplementation();
		({
			manager,
			app: mockApp,
			settings: mockSettings,
			onStatusChange: statusChangeCallback,
		} = createRecordingSut());
	});

	describe('streaming chunks', () => {
		it('writes chunks as segment files on desktop', async () => {
			useDesktopPlatform();

			const mockMediaRecorder = makeMediaRecorderDouble();

			stubAudioStreams();

			(mockApp.vault.adapter.readBinary as jest.Mock).mockResolvedValue(
				new Uint8Array([1, 2, 3]).buffer,
			);

			await manager.startRecording();

			const chunk = new Blob([new Uint8Array([1, 2, 3])], {
				type: 'audio/webm',
			});
			mockMediaRecorder.ondataavailable?.({ data: chunk } as BlobEvent);

			await manager.stopRecording();

			expect(mockApp.vault.adapter.writeBinary).toHaveBeenCalledWith(
				expect.stringMatching(/-part1\.webm\.tmp$/),
				expect.any(ArrayBuffer),
			);
		});

		it('rotates the recorder at the mobile size boundary and writes a converted part', async () => {
			useMobilePlatform();

			const mockMediaRecorder = makeMediaRecorderDouble();

			stubAudioStreams();
			(mockApp.vault.adapter.readBinary as jest.Mock).mockResolvedValue(
				new Uint8Array([1, 2, 3]).buffer,
			);

			await manager.startRecording();

			const target = at(
				(
					manager as unknown as {
						chunkTargets: Array<{ bufferedBytes: number }>;
					}
				).chunkTargets,
				0,
			);
			target.bufferedBytes = 50 * 1024 * 1024 - 1;

			const chunk = new Blob([new Uint8Array([1])], {
				type: 'audio/webm',
			});
			mockMediaRecorder.ondataavailable?.({ data: chunk } as BlobEvent);

			// Let the size rotation run to completion: it stops the
			// recorders, flushes a self-contained raw segment, restarts
			// capture, and converts the segment into a final part file
			for (let i = 0; i < 10; i++) {
				await tickTimes(2);
			}

			// The flush wrote a raw recorder-container segment...
			expect(mockApp.vault.adapter.writeBinary).toHaveBeenCalledWith(
				expect.stringMatching(/-part1\.webm\.tmp$/),
				expect.any(ArrayBuffer),
			);
			// ...that was finalized into a real part file...
			expect(mockApp.vault.createBinary).toHaveBeenCalledWith(
				expect.stringMatching(/-part1\.webm$/),
				expect.any(ArrayBuffer),
			);
			// ...and capture continued on a fresh recorder (stop + restart),
			// so the next part starts with its own container header
			expect(mockMediaRecorder.stop).toHaveBeenCalled();
			expect(global.MediaRecorder).toHaveBeenCalledTimes(2);

			await manager.stopRecording();
		});

		it('buffers multiple chunks into a single segment file and clean up after finalization', async () => {
			useDesktopPlatform();

			const mockMediaRecorder = makeMediaRecorderDouble();

			stubAudioStreams();

			(mockApp.vault.adapter.readBinary as jest.Mock).mockResolvedValue(
				new Uint8Array([1, 2, 3]).buffer,
			);

			await manager.startRecording();

			// Send 3 small chunks - all buffered in memory, flushed as 1 segment on stop
			for (let i = 0; i < 3; i++) {
				const chunk = new Blob([new Uint8Array([1, 2, 3])], {
					type: 'audio/webm',
				});
				mockMediaRecorder.ondataavailable?.({
					data: chunk,
				} as BlobEvent);
			}
			await Promise.resolve();

			await manager.stopRecording();

			// 1 combined segment file + 1 final file (instead of 3 + 1 before buffering)
			expect(mockApp.vault.adapter.writeBinary).toHaveBeenCalledWith(
				expect.stringMatching(/-part1\.webm\.tmp$/),
				expect.any(ArrayBuffer),
			);
			// Only 1 segment to clean up
			expect(mockApp.vault.adapter.remove).toHaveBeenCalledTimes(1);
		});

		it('saves multi-track WAV via PCM capture and merge', async () => {
			useDesktopPlatform();

			mockSettings = {
				...DEFAULT_SETTINGS,
				enableMultiTrack: true,
				outputMode: 'single',
				recordingFormat: 'wav',
			};
			manager = recordingManagerOver(
				mockApp,
				mockSettings,
				statusChangeCallback,
			);

			installMediaRecorder(undefined, (mime) => mime === 'audio/webm');

			stubAudioStreams({ count: 2 });

			await manager.startRecording();

			// Simulate PCM chunks for both tracks
			const pcmData = new Int16Array([100, -100, 200, -200]).buffer;
			pcmChunkCallback()(pcmData);

			await Promise.resolve();
			await manager.stopRecording();

			// Should have created WAV file via mergeAudioTracks path
			expect(mockApp.vault.createBinary).toHaveBeenCalledWith(
				expect.stringMatching(/multitrack-.*\.wav$/),
				expect.any(ArrayBuffer),
			);
		});
	});

	describe('write chain containment', () => {
		beforeEach(() => {
			// The desktop reset used to live in the local recorder factory;
			// the shared kit factory leaves Platform untouched
			useDesktopPlatform();
		});

		const getWriteFailureNotices = (): unknown[][] => {
			return (Notice as jest.Mock).mock.calls.filter((call) =>
				String(call[0]).includes('Failed to write recording data'),
			);
		};

		const getTarget = (index: number): MutableTarget =>
			getChunkTarget(manager, index);

		it('keeps the chain alive and retry after a failed flush', async () => {
			const recorder = createDesktopRecorder();
			(mockApp.vault.adapter.readBinary as jest.Mock).mockResolvedValue(
				new Uint8Array([1, 2, 3]).buffer,
			);

			await manager.startRecording();
			const target = getTarget(0);

			const writeBinary = mockApp.vault.adapter.writeBinary as jest.Mock;
			writeBinary
				.mockRejectedValueOnce(new Error('disk full'))
				.mockRejectedValueOnce(new Error('disk full'));

			const sendChunk = (): void => {
				// Keep the buffer over the threshold so every chunk
				// triggers a flush attempt
				target.bufferedBytes = 50 * 1024 * 1024 - 1;
				recorder.ondataavailable?.({
					data: new Blob([new Uint8Array([1, 2, 3])], {
						type: 'audio/webm',
					}),
				} as BlobEvent);
			};

			sendChunk();
			await tickTimes(2);
			sendChunk();
			await tickTimes(2);

			// Two failed flushes: chain must stay resolvable, one Notice
			await expect(target.pendingWrite).resolves.toBeUndefined();
			expect(getWriteFailureNotices()).toHaveLength(1);
			expect(writeBinary).toHaveBeenCalledTimes(2);

			// Disk "recovers": the next chunk flushes the retained data
			sendChunk();
			await tickTimes(2);

			expect(writeBinary).toHaveBeenCalledTimes(3);
			expect(writeBinary).toHaveBeenLastCalledWith(
				expect.stringMatching(/-part1\.webm\.tmp$/),
				expect.any(ArrayBuffer),
			);

			await manager.stopRecording();
			expect(manager.getStatus()).toBe(RecordingStatus.Idle);
			expect(mockApp.vault.createBinary).toHaveBeenCalledWith(
				expect.stringMatching(/\.webm$/),
				expect.any(ArrayBuffer),
			);
		});

		it('res-arm the failure Notice after a successful flush', async () => {
			const recorder = createDesktopRecorder();
			await manager.startRecording();
			const target = getTarget(0);

			const writeBinary = mockApp.vault.adapter.writeBinary as jest.Mock;
			const sendChunk = (): void => {
				target.bufferedBytes = 50 * 1024 * 1024 - 1;
				recorder.ondataavailable?.({
					data: new Blob([new Uint8Array([1])], {
						type: 'audio/webm',
					}),
				} as BlobEvent);
			};

			writeBinary.mockRejectedValueOnce(new Error('disk full'));
			sendChunk();
			await tickTimes(2);
			// Await the write chain itself rather than trusting flushAsync's
			// fixed macrotask count: under load the failure handler (which emits
			// the Notice) can settle a turn later, which would otherwise leave
			// this at 0 and leak the Notice into the next test.
			await expect(target.pendingWrite).resolves.toBeUndefined();
			expect(getWriteFailureNotices()).toHaveLength(1);

			// Successful flush ends the failure streak
			sendChunk();
			await tickTimes(2);
			await expect(target.pendingWrite).resolves.toBeUndefined();

			// New streak: a second Notice is allowed again
			writeBinary.mockRejectedValueOnce(new Error('disk full'));
			sendChunk();
			await tickTimes(2);
			await expect(target.pendingWrite).resolves.toBeUndefined();
			expect(getWriteFailureNotices()).toHaveLength(2);

			await manager.stopRecording();
		});

		it('contains PCM flush failures without dropping later chunks', async () => {
			useDesktopPlatform();
			// Installs a recorder that reports every format recordable, and
			// stubs the streams. Without it this test inherits whichever
			// recorder the previous one left installed - and the sibling that
			// narrows support to audio/webm makes WAV unrecordable here,
			// which is a failure that only appears in some orders.
			createDesktopRecorder();

			mockSettings = { ...DEFAULT_SETTINGS, recordingFormat: 'wav' };
			manager = recordingManagerOver(
				mockApp,
				mockSettings,
				statusChangeCallback,
			);

			(mockApp.vault.adapter.readBinary as jest.Mock).mockResolvedValue(
				new Uint8Array([1, 2, 3, 4]).buffer,
			);

			await manager.startRecording();
			const target = getTarget(0);

			const writeBinary = mockApp.vault.adapter.writeBinary as jest.Mock;
			writeBinary.mockRejectedValueOnce(new Error('disk full'));

			const sendPcm = (): void => {
				// Keep the PCM buffer over the threshold so every chunk
				// triggers a flush attempt
				target.pcmBufferedBytes = 50 * 1024 * 1024 - 1;
				pcmChunkCallback()(new Int16Array([100, -100]).buffer);
			};

			sendPcm();
			await tickTimes(2);

			await expect(target.pendingWrite).resolves.toBeUndefined();
			expect(getWriteFailureNotices()).toHaveLength(1);

			sendPcm();
			await tickTimes(2);

			expect(writeBinary).toHaveBeenCalledTimes(2);
			expect(writeBinary).toHaveBeenLastCalledWith(
				expect.stringMatching(/-pcm-part1\.tmp$/),
				expect.any(ArrayBuffer),
			);

			await manager.stopRecording();
			expect(manager.getStatus()).toBe(RecordingStatus.Idle);
		});
	});

	describe('auto-split', () => {
		interface TargetInternals {
			pendingWrite: Promise<void>;
			partPaths: string[];
			partIndex: number;
			pcmBuffers: ArrayBuffer[];
			pcmBufferedBytes: number;
			partPcmBytes: number;
			filePcmBytes: number;
			pcmChannels: number;
		}

		interface ManagerInternals {
			chunkTargets: TargetInternals[];
			rotation: { rotationPromise: Promise<void> | null };
		}

		let mockMediaRecorder: MockMediaRecorder;

		function getInternals(instance: RecordingManager): {
			chunkTargets: TargetInternals[];
			rotationPromise: Promise<void> | null;
		} {
			const internals = internalsOf<ManagerInternals>(instance);
			return {
				chunkTargets: internals.chunkTargets,
				// Rotation state lives on the PartRotationController
				get rotationPromise(): Promise<void> | null {
					return internals.rotation.rotationPromise;
				},
			};
		}

		function createManagerWithSettings(
			overrides: Partial<AudioRecorderSettings>,
		): void {
			mockSettings = { ...DEFAULT_SETTINGS, ...overrides };
			manager = recordingManagerOver(
				mockApp,
				mockSettings,
				statusChangeCallback,
			);
		}

		/**
		 * A manager configured to rotate a WebM part every minute, with the
		 * clock frozen at zero so a test moves it by hand.
		 *
		 * Seven rotation tests open this way; what they differ on is where
		 * they move the clock to and what they then break.
		 */
		function startOneMinuteSplitClock(): void {
			jest.useFakeTimers();
			jest.setSystemTime(0);
			createManagerWithSettings({
				recordingFormat: 'webm',
				autoSplitEnabled: true,
				splitChunkMinutes: 1,
			});
		}

		beforeEach(() => {
			useDesktopPlatform();

			mockMediaRecorder = makeMediaRecorderDouble({ state: 'recording' });

			stubAudioStreams();

			(mockApp.vault.adapter.readBinary as jest.Mock).mockResolvedValue(
				new Uint8Array([1, 2, 3]).buffer,
			);
		});

		afterEach(() => {
			jest.useRealTimers();
		});

		it('saves PCM parts at byte boundaries and a residual part at stop', async () => {
			createManagerWithSettings({
				recordingFormat: 'wav',
				autoSplitEnabled: true,
				splitChunkMinutes: 1,
			});

			await manager.startRecording();

			// Part limit: 1 min * 60 s * 44100 Hz * 1 ch * 2 B = 5,292,000 B
			pcmChunkCallback()(new ArrayBuffer(3_000_000));
			await at(getInternals(manager).chunkTargets, 0).pendingWrite;
			pcmChunkCallback()(new ArrayBuffer(3_000_000));
			await at(getInternals(manager).chunkTargets, 0).pendingWrite;

			expect(mockApp.vault.createBinary).toHaveBeenCalledWith(
				expect.stringMatching(/-part1\.wav$/),
				expect.anything(),
			);
			const target = at(getInternals(manager).chunkTargets, 0);
			expect(target.partIndex).toBe(1);
			expect(target.partPaths).toHaveLength(1);

			await manager.stopRecording();

			// The 708,000-byte carry becomes the residual second part
			expect(mockApp.vault.createBinary).toHaveBeenCalledWith(
				expect.stringMatching(/-part2\.wav$/),
				expect.anything(),
			);
		});

		/** Notices about the recording running out of WAV container. */
		const getCeilingNotices = (): unknown[][] =>
			(Notice as jest.Mock).mock.calls.filter((call) =>
				String(call[0]).includes('approaching the 4 GB limit'),
			);

		/**
		 * Starts a WAV session with auto-split off and puts its file counter
		 * a couple of bytes below the warning threshold, so the next chunk
		 * crosses it without anyone allocating four gigabytes.
		 * @returns The track's internals, ready to be fed chunks
		 */
		async function startNearTheCeiling(): Promise<TargetInternals> {
			createManagerWithSettings({
				recordingFormat: 'wav',
				autoSplitEnabled: false,
			});
			await manager.startRecording();
			const target = at(getInternals(manager).chunkTargets, 0);
			target.filePcmBytes = WAV_PCM_WARNING_BYTES - 2;
			return target;
		}

		// Auto-split off is the case that can reach the ceiling at all, and
		// the warning has to arrive while the session can still act on it: at
		// the stop the only outcomes left are a refused save and a file
		// players read as truncated.
		it('warns when a WAV recording approaches the container ceiling', async () => {
			const target = await startNearTheCeiling();

			pcmChunkCallback()(new ArrayBuffer(2));
			await target.pendingWrite;

			expect(getCeilingNotices()).toHaveLength(1);
		});

		it('warns once rather than on every chunk past the threshold', async () => {
			const target = await startNearTheCeiling();

			pcmChunkCallback()(new ArrayBuffer(2));
			await target.pendingWrite;
			pcmChunkCallback()(new ArrayBuffer(2));
			await target.pendingWrite;

			expect(getCeilingNotices()).toHaveLength(1);
		});

		it('stays quiet while the file is still well inside the container', async () => {
			createManagerWithSettings({
				recordingFormat: 'wav',
				autoSplitEnabled: false,
			});
			await manager.startRecording();

			pcmChunkCallback()(new ArrayBuffer(6_000_000));
			await at(getInternals(manager).chunkTargets, 0).pendingWrite;

			expect(getCeilingNotices()).toHaveLength(0);
		});

		// A session merging its tracks writes no per-track WAV at all, and the
		// file it does write is larger than any track feeding it: a long mono
		// track beside a stereo one is mixed up to stereo, which doubles it.
		// Warning on the track let the merged file pass the ceiling in
		// silence, and the refusal then arrived at the stop with the whole
		// session already recorded.
		/**
		 * Starts a merged two-track WAV session, a mono track beside a stereo
		 * one, with the mono track's counter just below where the up-mix puts
		 * the merged file over the warning threshold.
		 * @returns Both tracks' internals, mono first
		 */
		async function startMergedNearTheCeiling(): Promise<
			[TargetInternals, TargetInternals]
		> {
			useDesktopPlatform();
			stubAudioStreams({ count: 2 });
			createManagerWithSettings({
				recordingFormat: 'wav',
				autoSplitEnabled: false,
				enableMultiTrack: true,
				outputMode: 'single',
			});
			await manager.startRecording();
			const [mono, stereo] = getInternals(manager).chunkTargets;
			defined(mono).pcmChannels = 1;
			defined(stereo).pcmChannels = 2;
			// A quarter of the ceiling in frames, which the up-mix to stereo
			// turns into the whole of it, while the track itself stays at
			// half and would never have warned on its own.
			defined(mono).filePcmBytes =
				Math.ceil(WAV_PCM_WARNING_BYTES / 4) * 2 - 2;
			return [defined(mono), defined(stereo)];
		}

		it('warns on the merged file rather than on the track feeding it', async () => {
			const [mono] = await startMergedNearTheCeiling();

			pcmChunkCallback()(new ArrayBuffer(2));
			await mono.pendingWrite;

			expect(mono.filePcmBytes).toBeLessThan(WAV_PCM_WARNING_BYTES);
			expect(getCeilingNotices()).toHaveLength(1);
		});

		// The merged session writes one file, so it gets one warning. Held per
		// track, the memory of having warned said nothing about the other
		// tracks feeding the same file, and each of them repeated the notice
		// as its own next chunk arrived - four tracks, four notices, one file.
		it('warns once about the merged file however many tracks feed it', async () => {
			const [mono, stereo] = await startMergedNearTheCeiling();

			pcmChunkCallback(0)(new ArrayBuffer(2));
			await mono.pendingWrite;
			pcmChunkCallback(1)(new ArrayBuffer(2));
			await stereo.pendingWrite;

			expect(getCeilingNotices()).toHaveLength(1);
		});

		it('does not split PCM recordings when auto-split is disabled', async () => {
			createManagerWithSettings({
				recordingFormat: 'wav',
				autoSplitEnabled: false,
				splitChunkMinutes: 1,
			});

			await manager.startRecording();

			pcmChunkCallback()(new ArrayBuffer(6_000_000));
			await at(getInternals(manager).chunkTargets, 0).pendingWrite;

			const partCalls = (
				mockApp.vault.createBinary as jest.Mock
			).mock.calls.filter((call: unknown[]) =>
				/-part\d+\.wav$/.test(String(call[0])),
			);
			expect(partCalls).toHaveLength(0);
		});

		it('uses the configured suffix for PCM part files', async () => {
			createManagerWithSettings({
				recordingFormat: 'wav',
				autoSplitEnabled: true,
				splitChunkMinutes: 1,
				splitPartSuffix: 'chunk',
			});

			await manager.startRecording();

			pcmChunkCallback()(new ArrayBuffer(6_000_000));
			await at(getInternals(manager).chunkTargets, 0).pendingWrite;

			expect(mockApp.vault.createBinary).toHaveBeenCalledWith(
				expect.stringMatching(/-chunk1\.wav$/),
				expect.anything(),
			);
		});

		it('rotates a mobile part on the configured duration', async () => {
			setPlatform({ isMobile: true });
			startOneMinuteSplitClock();

			await manager.startRecording();
			jest.setSystemTime(61_000);
			mockMediaRecorder.ondataavailable?.({
				data: new Blob([new Uint8Array([1, 2, 3])], {
					type: 'audio/webm',
				}),
			} as BlobEvent);
			await at(getInternals(manager).chunkTargets, 0).pendingWrite;
			await flushMicrotasks(10);
			await getInternals(manager).rotationPromise;

			// Auto-split runs on the phone too. Without it a mobile part
			// only lands at the 50 MB buffer boundary, and that boundary is
			// the whole of what a crash can take with it.
			expect(mockApp.vault.createBinary).toHaveBeenCalledWith(
				expect.stringMatching(/-part1\.webm$/),
				expect.anything(),
			);
			await manager.stopRecording();
		});

		it('keeps the part file when segment cleanup fails', async () => {
			createManagerWithSettings({
				recordingFormat: 'wav',
				autoSplitEnabled: true,
				splitChunkMinutes: 1,
			});
			// Segment removal fails after the part file was assembled
			(mockApp.vault.adapter.remove as jest.Mock).mockRejectedValue(
				new Error('locked'),
			);

			await manager.startRecording();

			pcmChunkCallback()(new ArrayBuffer(6_000_000));
			await at(getInternals(manager).chunkTargets, 0).pendingWrite;

			// The assembled part is kept: the removed segments would
			// otherwise be the only copy of the audio
			const target = at(getInternals(manager).chunkTargets, 0);
			expect(target.partIndex).toBe(1);
			expect(target.partPaths).toHaveLength(1);
			expect(Notice).toHaveBeenCalledWith(
				expect.stringContaining(
					'Recording saved, but temporary files could not be removed',
				),
			);
			expect(manager.getStatus()).toBe(RecordingStatus.Recording);
		});

		it('names the residual from the base name snapshotted at start', async () => {
			createManagerWithSettings({
				recordingFormat: 'wav',
				autoSplitEnabled: true,
				splitChunkMinutes: 1,
			});

			await manager.startRecording();

			pcmChunkCallback()(new ArrayBuffer(6_000_000));
			await at(getInternals(manager).chunkTargets, 0).pendingWrite;

			// Changing the prefix mid-session must not affect this session
			manager.updateSettings({
				...mockSettings,
				filePrefix: 'changed',
			});
			await manager.stopRecording();

			const residualCall = (
				mockApp.vault.createBinary as jest.Mock
			).mock.calls.find((call: unknown[]) =>
				/-part2\.wav$/.test(String(call[0])),
			);
			expect(residualCall).toBeDefined();
			expect(String(residualCall?.[0])).toContain('recording-');
			expect(String(residualCall?.[0])).not.toContain('changed-');
		});

		it('rotates MediaRecorder parts after the configured duration', async () => {
			startOneMinuteSplitClock();

			await manager.startRecording();
			expect(global.MediaRecorder).toHaveBeenCalledTimes(1);

			jest.setSystemTime(61_000);
			const chunk = new Blob([new Uint8Array([1, 2, 3])], {
				type: 'audio/webm',
			});
			mockMediaRecorder.ondataavailable?.({ data: chunk } as BlobEvent);
			await at(getInternals(manager).chunkTargets, 0).pendingWrite;
			await flushMicrotasks(10);

			const rotation = getInternals(manager).rotationPromise;
			expect(rotation).not.toBeNull();
			await rotation;

			// Part finalized as a real file and recorders restarted
			expect(mockApp.vault.createBinary).toHaveBeenCalledWith(
				expect.stringMatching(/-part1\.webm$/),
				expect.anything(),
			);
			expect(global.MediaRecorder).toHaveBeenCalledTimes(2);
			expect(
				at(getInternals(manager).chunkTargets, 0).partPaths,
			).toHaveLength(1);

			// Residual data recorded after rotation becomes the next part
			jest.setSystemTime(70_000);
			mockMediaRecorder.ondataavailable?.({ data: chunk } as BlobEvent);
			await at(getInternals(manager).chunkTargets, 0).pendingWrite;
			await manager.stopRecording();

			expect(mockApp.vault.createBinary).toHaveBeenCalledWith(
				expect.stringMatching(/-part2\.webm$/),
				expect.anything(),
			);
		});

		it('does not count paused time toward the part duration', async () => {
			startOneMinuteSplitClock();

			await manager.startRecording();

			jest.setSystemTime(30_000);
			manager.togglePauseResume();
			jest.setSystemTime(130_000);
			manager.togglePauseResume();

			// Active time is 30 s + 10 s = 40 s, below the 60 s boundary
			jest.setSystemTime(140_000);
			const chunk = new Blob([new Uint8Array([1, 2, 3])], {
				type: 'audio/webm',
			});
			mockMediaRecorder.ondataavailable?.({ data: chunk } as BlobEvent);
			await at(getInternals(manager).chunkTargets, 0).pendingWrite;
			await flushMicrotasks(10);
			expect(getInternals(manager).rotationPromise).toBeNull();

			// Active time reaches 30 s + 35 s = 65 s, beyond the boundary
			jest.setSystemTime(165_000);
			mockMediaRecorder.ondataavailable?.({ data: chunk } as BlobEvent);
			await at(getInternals(manager).chunkTargets, 0).pendingWrite;
			await flushMicrotasks(10);

			const rotation = getInternals(manager).rotationPromise;
			expect(rotation).not.toBeNull();
			await rotation;
			expect(global.MediaRecorder).toHaveBeenCalledTimes(2);
		});

		it('skips auto-split for merged multi-track recordings', async () => {
			stubAudioStreams({ count: 2 });
			createManagerWithSettings({
				recordingFormat: 'webm',
				autoSplitEnabled: true,
				splitChunkMinutes: 1,
				outputMode: 'single',
			});

			await manager.startRecording();

			expect(Notice).toHaveBeenCalledWith(
				'Auto-split is skipped for merged multi-track recordings.',
			);
		});

		it('keeps recording when part finalization fails', async () => {
			startOneMinuteSplitClock();
			// Fail only the final part write; segment (.tmp) writes succeed
			(mockApp.vault.createBinary as jest.Mock).mockImplementation(
				(path: string) =>
					/-part1\.webm$/.test(path)
						? Promise.reject(new Error('disk full'))
						: Promise.resolve(),
			);

			await manager.startRecording();

			jest.setSystemTime(61_000);
			const chunk = new Blob([new Uint8Array([1, 2, 3])], {
				type: 'audio/webm',
			});
			mockMediaRecorder.ondataavailable?.({ data: chunk } as BlobEvent);
			await at(getInternals(manager).chunkTargets, 0).pendingWrite;
			await flushMicrotasks(10);
			await getInternals(manager).rotationPromise;

			expect(Notice).toHaveBeenCalledWith(
				'Failed to save recording part. Recording continues; data is kept for the next part.',
			);
			const target = at(getInternals(manager).chunkTargets, 0);
			expect(target.partIndex).toBe(0);
			expect(target.partPaths).toHaveLength(0);
			// Recorders were restarted despite the failure
			expect(global.MediaRecorder).toHaveBeenCalledTimes(2);
			expect(manager.getStatus()).toBe(RecordingStatus.Recording);
		});

		it('preserves buffered PCM audio when a part save fails', async () => {
			createManagerWithSettings({
				recordingFormat: 'wav',
				autoSplitEnabled: true,
				splitChunkMinutes: 1,
			});
			// Fail only the PCM segment write that backs the part assembly
			(mockApp.vault.adapter.writeBinary as jest.Mock).mockImplementation(
				(path: string) =>
					path.includes('-pcm-part')
						? Promise.reject(new Error('disk full'))
						: Promise.resolve(),
			);

			await manager.startRecording();

			// Part limit: 1 min * 60 s * 44100 Hz * 1 ch * 2 B = 5,292,000 B
			pcmChunkCallback()(new ArrayBuffer(6_000_000));
			await at(getInternals(manager).chunkTargets, 0).pendingWrite;

			expect(Notice).toHaveBeenCalledWith(
				'Failed to save recording part. Recording continues; data is kept for the next part.',
			);
			const target = at(getInternals(manager).chunkTargets, 0);
			expect(target.partIndex).toBe(0);
			expect(target.partPaths).toHaveLength(0);
			// All captured bytes stay buffered: front portion plus the
			// carry re-attached in capture order
			const bufferedBytes = target.pcmBuffers.reduce(
				(sum, buffer) => sum + buffer.byteLength,
				0,
			);
			expect(bufferedBytes).toBe(6_000_000);
			expect(target.pcmBufferedBytes).toBe(6_000_000);
			// Part accounting restarts so the save is retried one part later
			expect(target.partPcmBytes).toBe(0);

			// Disk recovers: the preserved audio must reach the final file
			(mockApp.vault.adapter.writeBinary as jest.Mock).mockResolvedValue(
				undefined,
			);
			await manager.stopRecording();

			expect(mockApp.vault.createBinary).toHaveBeenCalledWith(
				expect.stringMatching(/\.wav$/),
				expect.anything(),
			);
			const partWavCalls = (
				mockApp.vault.createBinary as jest.Mock
			).mock.calls.filter((call: unknown[]) =>
				/-part\d+\.wav$/.test(String(call[0])),
			);
			expect(partWavCalls).toHaveLength(0);
		});

		it('restarts recorders before transcoding the rotated part', async () => {
			startOneMinuteSplitClock();

			// Shared log capturing recorder construction vs part writes
			const callLog: string[] = [];
			installMediaRecorderFactory(() => {
				callLog.push('recorder-created');
				return mockMediaRecorder;
			});
			(mockApp.vault.createBinary as jest.Mock).mockImplementation(
				(path: string) => {
					if (/-part1\.webm$/.test(path)) {
						callLog.push('part-file-written');
					}
					return Promise.resolve();
				},
			);

			await manager.startRecording();

			jest.setSystemTime(61_000);
			const chunk = new Blob([new Uint8Array([1, 2, 3])], {
				type: 'audio/webm',
			});
			mockMediaRecorder.ondataavailable?.({ data: chunk } as BlobEvent);
			await at(getInternals(manager).chunkTargets, 0).pendingWrite;
			await flushMicrotasks(10);
			await getInternals(manager).rotationPromise;

			// Restart (2nd construction) precedes the part file write so
			// the capture gap excludes the transcoding time
			expect(callLog).toEqual([
				'recorder-created',
				'recorder-created',
				'part-file-written',
			]);
		});

		it('skips pausing recorders that are inactive during rotation', async () => {
			createManagerWithSettings({
				recordingFormat: 'webm',
				autoSplitEnabled: true,
				splitChunkMinutes: 1,
			});

			await manager.startRecording();

			// Rotation window: recorders are momentarily stopped
			mockMediaRecorder.state = 'inactive';
			expect(() => manager.togglePauseResume()).not.toThrow();
			expect(mockMediaRecorder.pause).not.toHaveBeenCalled();
			expect(manager.getStatus()).toBe(RecordingStatus.Paused);

			// Resume skips inactive recorders the same way
			expect(() => manager.togglePauseResume()).not.toThrow();
			expect(mockMediaRecorder.resume).not.toHaveBeenCalled();
			expect(manager.getStatus()).toBe(RecordingStatus.Recording);

			// Active recorders keep the normal pause path
			mockMediaRecorder.state = 'recording';
			manager.togglePauseResume();
			expect(mockMediaRecorder.pause).toHaveBeenCalledTimes(1);
			expect(manager.getStatus()).toBe(RecordingStatus.Paused);
		});

		// A rotation stops and rebuilds the recorders. A session paused
		// across that window has to come back paused, or the rotation
		// silently resumes a recording the user stopped.
		it('restores the paused state across a rotation', async () => {
			startOneMinuteSplitClock();

			await manager.startRecording();

			jest.setSystemTime(61_000);
			const chunk = new Blob([new Uint8Array([1, 2, 3])], {
				type: 'audio/webm',
			});
			mockMediaRecorder.ondataavailable?.({ data: chunk } as BlobEvent);
			await at(getInternals(manager).chunkTargets, 0).pendingWrite;
			await flushMicrotasks(10);

			// Paused inside the rotation window, where the recorders are
			// momentarily gone: the restart is what has to re-apply it
			mockMediaRecorder.state = 'inactive';
			manager.togglePauseResume();
			expect(manager.getStatus()).toBe(RecordingStatus.Paused);
			expect(mockMediaRecorder.pause).not.toHaveBeenCalled();

			await getInternals(manager).rotationPromise;

			expect(global.MediaRecorder).toHaveBeenCalledTimes(2);
			// The rebuilt recorder comes back paused rather than running
			expect(manager.getStatus()).toBe(RecordingStatus.Paused);
			expect(mockMediaRecorder.pause).toHaveBeenCalledTimes(1);
		});

		it('stops and salvage the session when recorder restart fails', async () => {
			startOneMinuteSplitClock();

			// The 2nd construction is the rotation restart; it fails as if
			// the input device disappeared mid-session
			let constructionCount = 0;
			installMediaRecorderFactory(() => {
				constructionCount += 1;
				if (constructionCount === 2) {
					throw new Error('device disappeared');
				}
				return mockMediaRecorder;
			});

			await manager.startRecording();

			jest.setSystemTime(61_000);
			const chunk = new Blob([new Uint8Array([1, 2, 3])], {
				type: 'audio/webm',
			});
			mockMediaRecorder.ondataavailable?.({ data: chunk } as BlobEvent);
			await at(getInternals(manager).chunkTargets, 0).pendingWrite;
			await flushMicrotasks(10);
			await getInternals(manager).rotationPromise;

			// The internally fired stopRecording is not awaitable from the
			// outside; drain microtasks until its chain settles
			for (let i = 0; i < 20; i++) {
				if (manager.getStatus() === RecordingStatus.Idle) {
					break;
				}
				await flushMicrotasks(10);
			}

			expect(Notice).toHaveBeenCalledWith(
				'Could not restart recording after saving a part. Stopping and saving the recording.',
			);
			// Session was salvaged: the part saved before the failure is
			// kept and the session ends cleanly instead of going dead
			expect(Notice).toHaveBeenCalledWith('Recording stopped');
			expect(manager.getStatus()).toBe(RecordingStatus.Idle);
		});

		it('keeps the session output format when settings change mid-session', async () => {
			startOneMinuteSplitClock();

			await manager.startRecording();

			// Settings change mid-session must not leak into the session
			manager.updateSettings({ ...mockSettings, recordingFormat: 'ogg' });

			jest.setSystemTime(61_000);
			const chunk = new Blob([new Uint8Array([1, 2, 3])], {
				type: 'audio/webm',
			});
			mockMediaRecorder.ondataavailable?.({ data: chunk } as BlobEvent);
			await at(getInternals(manager).chunkTargets, 0).pendingWrite;
			await flushMicrotasks(10);
			await getInternals(manager).rotationPromise;

			expect(mockApp.vault.createBinary).toHaveBeenCalledWith(
				expect.stringMatching(/-part1\.webm$/),
				expect.anything(),
			);
			const oggCalls = (
				mockApp.vault.createBinary as jest.Mock
			).mock.calls.filter((call: unknown[]) =>
				String(call[0]).endsWith('.ogg'),
			);
			expect(oggCalls).toHaveLength(0);
		});

		it('ignores a reentrant stopRecording call', async () => {
			createManagerWithSettings({
				recordingFormat: 'webm',
				autoSplitEnabled: true,
				splitChunkMinutes: 1,
			});

			await manager.startRecording();
			const chunk = new Blob([new Uint8Array([1, 2, 3])], {
				type: 'audio/webm',
			});
			mockMediaRecorder.ondataavailable?.({ data: chunk } as BlobEvent);
			await at(getInternals(manager).chunkTargets, 0).pendingWrite;

			// Second concurrent call must return without a second save
			const firstStop = manager.stopRecording();
			const secondStop = manager.stopRecording();
			await Promise.all([firstStop, secondStop]);

			const stopNotices = (Notice as jest.Mock).mock.calls.filter(
				(call: unknown[]) => call[0] === 'Recording stopped',
			);
			expect(stopNotices).toHaveLength(1);
			// Exactly one final track file write (segments end in .tmp)
			const finalWrites = (
				mockApp.vault.createBinary as jest.Mock
			).mock.calls.filter((call: unknown[]) =>
				/\.webm$/.test(String(call[0])),
			);
			expect(finalWrites).toHaveLength(1);
		});

		it('stops cleanly while a rotation is in flight', async () => {
			startOneMinuteSplitClock();

			// Gate the rotation's segment flush so the stop request
			// deterministically lands while the rotation is in flight
			let releaseFlush: (() => void) | undefined;
			const flushGate = new Promise<void>((resolve) => {
				releaseFlush = resolve;
			});
			(mockApp.vault.adapter.writeBinary as jest.Mock).mockImplementation(
				(path: string) =>
					path.endsWith('.tmp') ? flushGate : Promise.resolve(),
			);

			await manager.startRecording();

			jest.setSystemTime(61_000);
			const chunk = new Blob([new Uint8Array([1, 2, 3])], {
				type: 'audio/webm',
			});
			mockMediaRecorder.ondataavailable?.({ data: chunk } as BlobEvent);
			await at(getInternals(manager).chunkTargets, 0).pendingWrite;
			await flushMicrotasks(10);
			expect(getInternals(manager).rotationPromise).not.toBeNull();

			// The rotation already stopped the recorders; the stop call
			// in this window must not throw or stop them a second time
			mockMediaRecorder.state = 'inactive';
			const stopPromise = manager.stopRecording();
			releaseFlush?.();
			await stopPromise;

			// Stop won the race: capture was not restarted, the rotated
			// part was still written, and the session ended cleanly
			expect(global.MediaRecorder).toHaveBeenCalledTimes(1);
			expect(mockMediaRecorder.stop).toHaveBeenCalledTimes(1);
			expect(mockApp.vault.createBinary).toHaveBeenCalledWith(
				expect.stringMatching(/-part1\.webm$/),
				expect.anything(),
			);
			expect(manager.getStatus()).toBe(RecordingStatus.Idle);
		});
	});
});
