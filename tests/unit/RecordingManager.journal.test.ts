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
	createRecordingSut,
	installRecordingMediaStubs,
	makeFakeMarkerStore,
} from '../helpers/recordingManagerTestKit';
import { at } from '../helpers/assertions';
import { useDesktopPlatform, useMobilePlatform } from '../helpers/platform';
import { tick, waitFor } from '../helpers/async';
import { PcmStreamRecorder } from 'src/recording/PcmStreamRecorder';

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

// Mock PcmStreamRecorder
jest.mock('src/recording/PcmStreamRecorder', () =>
	require('../mocks/modules/pcmStreamRecorder'),
);

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

		it('journals the session on desktop start and end it on stop', async () => {
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

		it('ends the journal session when start fails after journaling', async () => {
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

		it('does not journal mobile sessions', async () => {
			useMobilePlatform();
			createDesktopRecorder();
			manager = createManager();

			await manager.startRecording();
			await manager.stopRecording();

			expect(mockJournal.startSession).not.toHaveBeenCalled();
		});

		it('records flushed segments in the journal', async () => {
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
			// The Blob.arrayBuffer polyfill reads through FileReader, and
			// how many event-loop turns that takes is the runtime's business,
			// not something a fixed count of ticks can promise
			await waitFor(() => mockJournal.addSegment.mock.calls.length > 0, {
				message: 'the flushed segment to reach the journal',
			});

			expect(mockJournal.addSegment).toHaveBeenCalledWith(
				expect.stringContaining('Track1'),
				expect.stringMatching(/-part1\.webm\.tmp$/),
			);

			await manager.stopRecording();
		});

		it('keeps the journal when saving fails', async () => {
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

		it('keeps the journal and release recorders on cleanup', async () => {
			mockSettings = { ...DEFAULT_SETTINGS, recordingFormat: 'wav' };
			createDesktopRecorder();
			manager = createManager();

			await manager.startRecording();
			manager.cleanup();

			const recorderInstance = at(
				(PcmStreamRecorder as jest.Mock).mock.results,
				0,
			).value as { stop: jest.Mock };
			expect(recorderInstance.stop).toHaveBeenCalled();
			expect(mockJournal.endSession).not.toHaveBeenCalled();
		});
	});
});
