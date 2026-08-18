/**
 * Unit tests for RecordingManager session journal integration: what
 * gets journaled on start, flush, stop, failure, and cleanup.
 * @module tests/unit/RecordingManager.journal.test
 */

import { RecordingManager } from 'src/recording/RecordingManager';
import {
	DEFAULT_SETTINGS,
	type AudioRecorderSettings,
} from 'src/settings/settingsSchema';
import type { App } from 'obsidian';
import {
	createDesktopRecorder,
	createRecordingMockApp,
	installRecordingMediaStubs,
	makeFakeMarkerStore,
} from './helpers/recordingManagerTestKit';
import { at } from '../helpers/assertions';
import { useDesktopPlatform, useMobilePlatform } from '../helpers/platform';
import { tick } from '../helpers/async';

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
jest.mock('src/recording/PcmStreamRecorder', () => ({
	PcmStreamRecorder: jest.fn().mockImplementation(() => ({
		channels: 1,
		sampleRate: 44100,
		start: jest.fn().mockResolvedValue(undefined),
		stop: jest.fn().mockResolvedValue(undefined),
		pause: jest.fn(),
		resume: jest.fn(),
	})),
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

	describe('session journal integration', () => {
		interface JournalMock {
			startSession: jest.Mock;
			addSegment: jest.Mock;
			addPart: jest.Mock;
			removeSegments: jest.Mock;
			endSession: jest.Mock;
			flush: jest.Mock;
		}
		let mockJournal: JournalMock;

		const createManager = (): RecordingManager =>
			new RecordingManager(
				mockApp,
				mockSettings,
				statusChangeCallback,
				makeFakeMarkerStore().store,
				// eslint-disable-next-line @typescript-eslint/no-explicit-any -- journal double
				mockJournal as any,
			);

		beforeEach(() => {
			useDesktopPlatform();
			mockJournal = {
				startSession: jest.fn(),
				addSegment: jest.fn(),
				addPart: jest.fn(),
				removeSegments: jest.fn(),
				endSession: jest.fn(),
				flush: jest.fn().mockResolvedValue(undefined),
			};
		});

		it('should journal the session on desktop start and end it on stop', async () => {
			createDesktopRecorder();
			manager = createManager();
			(mockApp.vault.adapter.readBinary as jest.Mock).mockResolvedValue(
				new Uint8Array([1, 2, 3]).buffer,
			);

			await manager.startRecording();

			expect(mockJournal.startSession).toHaveBeenCalledWith(
				expect.objectContaining({
					recorderFormat: 'webm',
					tracks: [
						expect.objectContaining({
							fileBaseName: expect.stringContaining('Track1'),
							isPcm: false,
						}),
					],
				}),
			);

			await manager.stopRecording();

			expect(mockJournal.endSession).toHaveBeenCalled();
			expect(mockJournal.flush).toHaveBeenCalled();
		});

		it('should end the journal session when start fails after journaling', async () => {
			createDesktopRecorder();
			manager = createManager();
			// The first status update (Recording) fires after the journal
			// start; failing it exercises the partial-session release.
			// Without endSession the orphaned entry keeps an empty journal
			// file on disk until the next launch prunes it.
			statusChangeCallback.mockImplementationOnce(() => {
				throw new Error('status bar update failed');
			});

			await manager.startRecording();

			expect(mockJournal.startSession).toHaveBeenCalledTimes(1);
			expect(mockJournal.endSession).toHaveBeenCalledTimes(1);
		});

		it('should not journal mobile sessions', async () => {
			useMobilePlatform();
			createDesktopRecorder();
			manager = createManager();

			await manager.startRecording();
			await manager.stopRecording();

			expect(mockJournal.startSession).not.toHaveBeenCalled();
		});

		it('should record flushed segments in the journal', async () => {
			const recorder = createDesktopRecorder();
			manager = createManager();
			(mockApp.vault.adapter.readBinary as jest.Mock).mockResolvedValue(
				new Uint8Array([1, 2, 3]).buffer,
			);

			await manager.startRecording();
			const target = at(
				(
					manager as unknown as {
						chunkTargets: { bufferedBytes: number }[];
					}
				).chunkTargets,
				0,
			);
			target.bufferedBytes = 50 * 1024 * 1024 - 1;
			recorder.ondataavailable?.({
				data: new Blob([new Uint8Array([1])], { type: 'audio/webm' }),
			} as BlobEvent);
			// The Blob.arrayBuffer polyfill reads through FileReader, which
			// takes an extra event-loop turn before the flush lands
			await tick();
			await tick();

			expect(mockJournal.addSegment).toHaveBeenCalledWith(
				expect.stringContaining('Track1'),
				expect.stringMatching(/-part1\.webm\.tmp$/),
			);

			await manager.stopRecording();
		});

		it('should keep the journal when saving fails', async () => {
			const recorder = createDesktopRecorder();
			manager = createManager();
			(mockApp.vault.adapter.readBinary as jest.Mock).mockResolvedValue(
				new Uint8Array([1, 2, 3]).buffer,
			);
			(mockApp.vault.createBinary as jest.Mock).mockRejectedValue(
				new Error('disk full'),
			);

			await manager.startRecording();
			recorder.ondataavailable?.({
				data: new Blob([new Uint8Array([1])], { type: 'audio/webm' }),
			} as BlobEvent);
			await tick();

			await manager.stopRecording();

			expect(mockJournal.endSession).not.toHaveBeenCalled();
		});

		it('should keep the journal and release recorders on cleanup', async () => {
			mockSettings = { ...DEFAULT_SETTINGS, recordingFormat: 'wav' };
			createDesktopRecorder();
			manager = createManager();

			await manager.startRecording();
			manager.cleanup();

			const { PcmStreamRecorder } = jest.requireMock(
				'src/recording/PcmStreamRecorder',
			);
			const recorderInstance = at(
				(PcmStreamRecorder as jest.Mock).mock.results,
				0,
			).value as { stop: jest.Mock };
			expect(recorderInstance.stop).toHaveBeenCalled();
			expect(mockJournal.endSession).not.toHaveBeenCalled();
		});
	});
});
