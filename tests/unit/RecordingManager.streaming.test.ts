/**
 * Unit tests for RecordingManager streaming behavior: chunk buffering
 * and segment flushes, write chain containment, and auto-split part
 * rotation.
 * @module tests/unit/RecordingManager.streaming.test
 */

import { RecordingManager } from 'src/recording/RecordingManager';
import { at } from '../helpers/assertions';
import { RecordingStatus } from 'src/types';
import {
	DEFAULT_SETTINGS,
	type AudioRecorderSettings,
} from 'src/settings/settingsSchema';
import type { App } from 'obsidian';
import {
	createDesktopRecorder,
	createRecordingMockApp,
	flushAsync,
	getChunkTarget,
	installMediaRecorder,
	installMediaRecorderFactory,
	installRecordingMediaStubs,
	makeFakeMarkerStore,
	type MutableTarget,
} from './helpers/recordingManagerTestKit';
import {
	setPlatform,
	useDesktopPlatform,
	useMobilePlatform,
} from '../helpers/platform';

// Mock obsidian module
jest.mock('obsidian', () => ({
	Notice: jest.fn(),
	MarkdownView: jest.fn(),
	normalizePath: (path: string) => path.replace(/\\/g, '/'),
	Platform: {
		isMobile: false,
		isMobileApp: false,
	},
}));

// Mock AudioStreamHandler
jest.mock('src/recording/AudioStreamHandler', () => ({
	getAudioStreams: jest.fn(),
	getAudioSourceName: jest.fn().mockResolvedValue('TestDevice'),
	stopAllStreams: jest.fn(),
	validateSelectedDevices: jest.fn(),
}));

// Mock AudioEncoder module to avoid mediabunny TextDecoder requirement
jest.mock('src/audio/AudioEncoder', () => ({
	encodeAudioBuffer: jest
		.fn()
		.mockResolvedValue(new Blob(['encoded'], { type: 'audio/webm' })),
	isOfflineEncodingSupported: jest.fn((format: string) => {
		return ['mp3', 'flac', 'aac', 'webm', 'ogg', 'mp4', 'm4a'].includes(
			format,
		);
	}),
}));

// Mock WavEncoder
jest.mock('src/audio/WavEncoder', () => ({
	assembleWavFromPcmSegmentFiles: jest
		.fn()
		.mockResolvedValue(new ArrayBuffer(44)),
}));

// Mock PcmStreamRecorder
let capturedPcmChunkCallback: ((data: ArrayBuffer) => void) | null = null;
jest.mock('src/recording/PcmStreamRecorder', () => ({
	PcmStreamRecorder: jest
		.fn()
		.mockImplementation(
			(
				_stream: MediaStream,
				_sampleRate: number,
				onChunk: (data: ArrayBuffer) => void,
			) => {
				capturedPcmChunkCallback = onChunk;
				return {
					channels: 1,
					sampleRate: 44100,
					start: jest.fn().mockResolvedValue(undefined),
					stop: jest.fn().mockResolvedValue(undefined),
					pause: jest.fn(),
					resume: jest.fn(),
				};
			},
		),
}));

installRecordingMediaStubs();

describe('RecordingManager', () => {
	let manager: RecordingManager;
	let mockApp: App;
	let mockSettings: AudioRecorderSettings;
	let statusChangeCallback: jest.Mock;
	let consoleErrorSpy: jest.SpyInstance;

	beforeEach(() => {
		// Reset mocks
		consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();

		// Create mock App
		mockApp = createRecordingMockApp();

		// Use default settings
		mockSettings = { ...DEFAULT_SETTINGS };

		// Status change callback
		statusChangeCallback = jest.fn();

		// Create manager instance
		manager = new RecordingManager(
			mockApp,
			mockSettings,
			statusChangeCallback,
			makeFakeMarkerStore().store,
		);
	});

	afterEach(() => {
		consoleErrorSpy.mockRestore();
	});

	describe('streaming chunks', () => {
		it('should write chunks as segment files on desktop', async () => {
			useDesktopPlatform();

			const mockMediaRecorder = {
				start: jest.fn(),
				stop: jest.fn(),
				pause: jest.fn(),
				resume: jest.fn(),
				ondataavailable: null as ((event: BlobEvent) => void) | null,
				onerror: null as ((event: Event) => void) | null,
				addEventListener: jest.fn(
					(event: string, handler: () => void) => {
						if (event === 'stop') {
							handler();
						}
					},
				),
			};

			installMediaRecorder(mockMediaRecorder);

			const { getAudioStreams } = jest.requireMock(
				'src/recording/AudioStreamHandler',
			);
			getAudioStreams.mockResolvedValue({
				streams: [
					{
						getTracks: () => [{ stop: jest.fn() }],
					},
				],
				trackOrder: [],
			});

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

			const mockMediaRecorder = {
				start: jest.fn(),
				stop: jest.fn(),
				pause: jest.fn(),
				resume: jest.fn(),
				ondataavailable: null as ((event: BlobEvent) => void) | null,
				onerror: null as ((event: Event) => void) | null,
				addEventListener: jest.fn(
					(event: string, handler: () => void) => {
						if (event === 'stop') {
							handler();
						}
					},
				),
			};

			installMediaRecorder(mockMediaRecorder);

			const { getAudioStreams } = jest.requireMock(
				'src/recording/AudioStreamHandler',
			);
			getAudioStreams.mockResolvedValue({
				streams: [
					{
						getTracks: () => [{ stop: jest.fn() }],
					},
				],
				trackOrder: [],
			});
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
				await flushAsync();
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

		it('should buffer multiple chunks into a single segment file and clean up after finalization', async () => {
			useDesktopPlatform();

			const mockMediaRecorder = {
				start: jest.fn(),
				stop: jest.fn(),
				pause: jest.fn(),
				resume: jest.fn(),
				ondataavailable: null as ((event: BlobEvent) => void) | null,
				onerror: null as ((event: Event) => void) | null,
				addEventListener: jest.fn(
					(event: string, handler: () => void) => {
						if (event === 'stop') {
							handler();
						}
					},
				),
			};

			installMediaRecorder(mockMediaRecorder);

			const { getAudioStreams } = jest.requireMock(
				'src/recording/AudioStreamHandler',
			);
			getAudioStreams.mockResolvedValue({
				streams: [
					{
						getTracks: () => [{ stop: jest.fn() }],
					},
				],
				trackOrder: [],
			});

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

		it('should save multi-track WAV via PCM capture and merge', async () => {
			useDesktopPlatform();

			mockSettings = {
				...DEFAULT_SETTINGS,
				enableMultiTrack: true,
				outputMode: 'single',
				recordingFormat: 'wav',
			};
			manager = new RecordingManager(
				mockApp,
				mockSettings,
				statusChangeCallback,
				makeFakeMarkerStore().store,
			);

			installMediaRecorder(undefined, (mime) => mime === 'audio/webm');

			const { getAudioStreams } = jest.requireMock(
				'src/recording/AudioStreamHandler',
			);
			getAudioStreams.mockResolvedValue({
				streams: [
					{ getTracks: () => [{ stop: jest.fn() }] },
					{ getTracks: () => [{ stop: jest.fn() }] },
				],
				trackOrder: [],
			});

			await manager.startRecording();

			// Simulate PCM chunks for both tracks
			const pcmData = new Int16Array([100, -100, 200, -200]).buffer;
			capturedPcmChunkCallback?.(pcmData);

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
			const { Notice } = jest.requireMock('obsidian');
			return (Notice as jest.Mock).mock.calls.filter((call) =>
				String(call[0]).includes('Failed to write recording data'),
			);
		};

		const getTarget = (index: number): MutableTarget =>
			getChunkTarget(manager, index);

		it('should keep the chain alive and retry after a failed flush', async () => {
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
			await flushAsync();
			sendChunk();
			await flushAsync();

			// Two failed flushes: chain must stay resolvable, one Notice
			await expect(target.pendingWrite).resolves.toBeUndefined();
			expect(getWriteFailureNotices()).toHaveLength(1);
			expect(writeBinary).toHaveBeenCalledTimes(2);

			// Disk "recovers": the next chunk flushes the retained data
			sendChunk();
			await flushAsync();

			expect(writeBinary).toHaveBeenCalledTimes(3);
			expect(writeBinary).toHaveBeenLastCalledWith(
				expect.stringMatching(/-part1\.webm\.tmp$/),
				expect.any(ArrayBuffer),
			);

			await manager.stopRecording();
			expect(manager.getStatus()).toBe(RecordingStatus.Idle);
			expect(mockApp.vault.createBinary).toHaveBeenCalled();
		});

		it('should re-arm the failure Notice after a successful flush', async () => {
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
			await flushAsync();
			// Await the write chain itself rather than trusting flushAsync's
			// fixed macrotask count: under load the failure handler (which emits
			// the Notice) can settle a turn later, which would otherwise leave
			// this at 0 and leak the Notice into the next test.
			await expect(target.pendingWrite).resolves.toBeUndefined();
			expect(getWriteFailureNotices()).toHaveLength(1);

			// Successful flush ends the failure streak
			sendChunk();
			await flushAsync();
			await expect(target.pendingWrite).resolves.toBeUndefined();

			// New streak: a second Notice is allowed again
			writeBinary.mockRejectedValueOnce(new Error('disk full'));
			sendChunk();
			await flushAsync();
			await expect(target.pendingWrite).resolves.toBeUndefined();
			expect(getWriteFailureNotices()).toHaveLength(2);

			await manager.stopRecording();
		});

		it('should contain PCM flush failures without dropping later chunks', async () => {
			useDesktopPlatform();

			mockSettings = { ...DEFAULT_SETTINGS, recordingFormat: 'wav' };
			manager = new RecordingManager(
				mockApp,
				mockSettings,
				statusChangeCallback,
				makeFakeMarkerStore().store,
			);

			const { getAudioStreams } = jest.requireMock(
				'src/recording/AudioStreamHandler',
			);
			getAudioStreams.mockResolvedValue({
				streams: [{ getTracks: () => [{ stop: jest.fn() }] }],
				trackOrder: [],
			});
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
				capturedPcmChunkCallback?.(new Int16Array([100, -100]).buffer);
			};

			sendPcm();
			await flushAsync();

			await expect(target.pendingWrite).resolves.toBeUndefined();
			expect(getWriteFailureNotices()).toHaveLength(1);

			sendPcm();
			await flushAsync();

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
		}

		interface ManagerInternals {
			chunkTargets: TargetInternals[];
			rotation: { rotationPromise: Promise<void> | null };
		}

		let mockMediaRecorder: {
			start: jest.Mock;
			stop: jest.Mock;
			pause: jest.Mock;
			resume: jest.Mock;
			state: string;
			ondataavailable: ((event: BlobEvent) => void) | null;
			onerror: ((event: Event) => void) | null;
			addEventListener: jest.Mock;
		};

		function getInternals(instance: RecordingManager): {
			chunkTargets: TargetInternals[];
			rotationPromise: Promise<void> | null;
		} {
			const internals = instance as unknown as ManagerInternals;
			return {
				chunkTargets: internals.chunkTargets,
				// Rotation state lives on the PartRotationController
				get rotationPromise(): Promise<void> | null {
					return internals.rotation.rotationPromise;
				},
			};
		}

		/**
		 * Lets the voided handleChunk continuation run to completion so
		 * rotationPromise is observable after awaiting pendingWrite.
		 */
		async function flushMicrotasks(): Promise<void> {
			for (let i = 0; i < 10; i++) {
				await Promise.resolve();
			}
		}

		function createManagerWithSettings(
			overrides: Partial<AudioRecorderSettings>,
		): void {
			mockSettings = { ...DEFAULT_SETTINGS, ...overrides };
			manager = new RecordingManager(
				mockApp,
				mockSettings,
				statusChangeCallback,
				makeFakeMarkerStore().store,
			);
		}

		function setupStreams(count: number): void {
			const { getAudioStreams } = jest.requireMock(
				'src/recording/AudioStreamHandler',
			);
			getAudioStreams.mockResolvedValue({
				streams: Array.from({ length: count }, () => ({
					getTracks: () => [{ stop: jest.fn() }],
				})),
				trackOrder: [],
			});
		}

		beforeEach(() => {
			useDesktopPlatform();

			mockMediaRecorder = {
				start: jest.fn(),
				stop: jest.fn(),
				pause: jest.fn(),
				resume: jest.fn(),
				state: 'recording',
				ondataavailable: null,
				onerror: null,
				addEventListener: jest.fn(
					(event: string, handler: () => void) => {
						if (event === 'stop') {
							handler();
						}
					},
				),
			};

			installMediaRecorder(mockMediaRecorder);

			setupStreams(1);

			(mockApp.vault.adapter.readBinary as jest.Mock).mockResolvedValue(
				new Uint8Array([1, 2, 3]).buffer,
			);
		});

		afterEach(() => {
			jest.useRealTimers();
		});

		it('should save PCM parts at byte boundaries and a residual part at stop', async () => {
			createManagerWithSettings({
				recordingFormat: 'wav',
				autoSplitEnabled: true,
				splitChunkMinutes: 1,
			});

			await manager.startRecording();

			// Part limit: 1 min * 60 s * 44100 Hz * 1 ch * 2 B = 5,292,000 B
			capturedPcmChunkCallback?.(new ArrayBuffer(3_000_000));
			await at(getInternals(manager).chunkTargets, 0).pendingWrite;
			capturedPcmChunkCallback?.(new ArrayBuffer(3_000_000));
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

		it('should not split PCM recordings when auto-split is disabled', async () => {
			createManagerWithSettings({
				recordingFormat: 'wav',
				autoSplitEnabled: false,
				splitChunkMinutes: 1,
			});

			await manager.startRecording();

			capturedPcmChunkCallback?.(new ArrayBuffer(6_000_000));
			await at(getInternals(manager).chunkTargets, 0).pendingWrite;

			const partCalls = (
				mockApp.vault.createBinary as jest.Mock
			).mock.calls.filter((call: unknown[]) =>
				/-part\d+\.wav$/.test(String(call[0])),
			);
			expect(partCalls).toHaveLength(0);
		});

		it('should use the configured suffix for PCM part files', async () => {
			createManagerWithSettings({
				recordingFormat: 'wav',
				autoSplitEnabled: true,
				splitChunkMinutes: 1,
				splitPartSuffix: 'chunk',
			});

			await manager.startRecording();

			capturedPcmChunkCallback?.(new ArrayBuffer(6_000_000));
			await at(getInternals(manager).chunkTargets, 0).pendingWrite;

			expect(mockApp.vault.createBinary).toHaveBeenCalledWith(
				expect.stringMatching(/-chunk1\.wav$/),
				expect.anything(),
			);
		});

		it('should notify that auto-split is unavailable on mobile', async () => {
			setPlatform({ isMobile: true });
			createManagerWithSettings({
				recordingFormat: 'webm',
				autoSplitEnabled: true,
				splitChunkMinutes: 1,
			});

			await manager.startRecording();

			const { Notice } = jest.requireMock('obsidian');
			expect(Notice).toHaveBeenCalledWith(
				'Auto-split is not available on this device.',
			);
			await manager.stopRecording();
		});

		it('should keep the part file when segment cleanup fails', async () => {
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

			capturedPcmChunkCallback?.(new ArrayBuffer(6_000_000));
			await at(getInternals(manager).chunkTargets, 0).pendingWrite;

			// The assembled part is kept: the removed segments would
			// otherwise be the only copy of the audio
			const target = at(getInternals(manager).chunkTargets, 0);
			expect(target.partIndex).toBe(1);
			expect(target.partPaths).toHaveLength(1);
			const { Notice } = jest.requireMock('obsidian');
			expect(Notice).toHaveBeenCalledWith(
				expect.stringContaining(
					'Recording saved, but temporary files could not be removed',
				),
			);
			expect(manager.getStatus()).toBe(RecordingStatus.Recording);
		});

		it('should name the residual from the base name snapshotted at start', async () => {
			createManagerWithSettings({
				recordingFormat: 'wav',
				autoSplitEnabled: true,
				splitChunkMinutes: 1,
			});

			await manager.startRecording();

			capturedPcmChunkCallback?.(new ArrayBuffer(6_000_000));
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

		it('should rotate MediaRecorder parts after the configured duration', async () => {
			jest.useFakeTimers();
			jest.setSystemTime(0);
			createManagerWithSettings({
				recordingFormat: 'webm',
				autoSplitEnabled: true,
				splitChunkMinutes: 1,
			});

			await manager.startRecording();
			expect(global.MediaRecorder).toHaveBeenCalledTimes(1);

			jest.setSystemTime(61_000);
			const chunk = new Blob([new Uint8Array([1, 2, 3])], {
				type: 'audio/webm',
			});
			mockMediaRecorder.ondataavailable?.({ data: chunk } as BlobEvent);
			await at(getInternals(manager).chunkTargets, 0).pendingWrite;
			await flushMicrotasks();

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

		it('should not count paused time toward the part duration', async () => {
			jest.useFakeTimers();
			jest.setSystemTime(0);
			createManagerWithSettings({
				recordingFormat: 'webm',
				autoSplitEnabled: true,
				splitChunkMinutes: 1,
			});

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
			await flushMicrotasks();
			expect(getInternals(manager).rotationPromise).toBeNull();

			// Active time reaches 30 s + 35 s = 65 s, beyond the boundary
			jest.setSystemTime(165_000);
			mockMediaRecorder.ondataavailable?.({ data: chunk } as BlobEvent);
			await at(getInternals(manager).chunkTargets, 0).pendingWrite;
			await flushMicrotasks();

			const rotation = getInternals(manager).rotationPromise;
			expect(rotation).not.toBeNull();
			await rotation;
			expect(global.MediaRecorder).toHaveBeenCalledTimes(2);
		});

		it('should skip auto-split for merged multi-track recordings', async () => {
			setupStreams(2);
			createManagerWithSettings({
				recordingFormat: 'webm',
				autoSplitEnabled: true,
				splitChunkMinutes: 1,
				outputMode: 'single',
			});

			await manager.startRecording();

			const { Notice } = jest.requireMock('obsidian');
			expect(Notice).toHaveBeenCalledWith(
				'Auto-split is skipped for merged multi-track recordings.',
			);
		});

		it('should keep recording when part finalization fails', async () => {
			jest.useFakeTimers();
			jest.setSystemTime(0);
			createManagerWithSettings({
				recordingFormat: 'webm',
				autoSplitEnabled: true,
				splitChunkMinutes: 1,
			});
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
			await flushMicrotasks();
			await getInternals(manager).rotationPromise;

			const { Notice } = jest.requireMock('obsidian');
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

		it('should preserve buffered PCM audio when a part save fails', async () => {
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
			capturedPcmChunkCallback?.(new ArrayBuffer(6_000_000));
			await at(getInternals(manager).chunkTargets, 0).pendingWrite;

			const { Notice } = jest.requireMock('obsidian');
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

		it('should restart recorders before transcoding the rotated part', async () => {
			jest.useFakeTimers();
			jest.setSystemTime(0);
			createManagerWithSettings({
				recordingFormat: 'webm',
				autoSplitEnabled: true,
				splitChunkMinutes: 1,
			});

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
			await flushMicrotasks();
			await getInternals(manager).rotationPromise;

			// Restart (2nd construction) precedes the part file write so
			// the capture gap excludes the transcoding time
			expect(callLog).toEqual([
				'recorder-created',
				'recorder-created',
				'part-file-written',
			]);
		});

		it('should skip pausing recorders that are inactive during rotation', async () => {
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

		it('should stop and salvage the session when recorder restart fails', async () => {
			jest.useFakeTimers();
			jest.setSystemTime(0);
			createManagerWithSettings({
				recordingFormat: 'webm',
				autoSplitEnabled: true,
				splitChunkMinutes: 1,
			});

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
			await flushMicrotasks();
			await getInternals(manager).rotationPromise;

			// The internally fired stopRecording is not awaitable from the
			// outside; drain microtasks until its chain settles
			for (let i = 0; i < 20; i++) {
				if (manager.getStatus() === RecordingStatus.Idle) {
					break;
				}
				await flushMicrotasks();
			}

			const { Notice } = jest.requireMock('obsidian');
			expect(Notice).toHaveBeenCalledWith(
				'Could not restart recording after saving a part. Stopping and saving the recording.',
			);
			// Session was salvaged: the part saved before the failure is
			// kept and the session ends cleanly instead of going dead
			expect(Notice).toHaveBeenCalledWith('Recording stopped');
			expect(manager.getStatus()).toBe(RecordingStatus.Idle);
		});

		it('should keep the session output format when settings change mid-session', async () => {
			jest.useFakeTimers();
			jest.setSystemTime(0);
			createManagerWithSettings({
				recordingFormat: 'webm',
				autoSplitEnabled: true,
				splitChunkMinutes: 1,
			});

			await manager.startRecording();

			// Settings change mid-session must not leak into the session
			manager.updateSettings({ ...mockSettings, recordingFormat: 'ogg' });

			jest.setSystemTime(61_000);
			const chunk = new Blob([new Uint8Array([1, 2, 3])], {
				type: 'audio/webm',
			});
			mockMediaRecorder.ondataavailable?.({ data: chunk } as BlobEvent);
			await at(getInternals(manager).chunkTargets, 0).pendingWrite;
			await flushMicrotasks();
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

		it('should ignore a reentrant stopRecording call', async () => {
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

			const { Notice } = jest.requireMock('obsidian');
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

		it('should stop cleanly while a rotation is in flight', async () => {
			jest.useFakeTimers();
			jest.setSystemTime(0);
			createManagerWithSettings({
				recordingFormat: 'webm',
				autoSplitEnabled: true,
				splitChunkMinutes: 1,
			});

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
			await flushMicrotasks();
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
