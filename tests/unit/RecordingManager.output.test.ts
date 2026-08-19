/**
 * Unit tests for RecordingManager output handling: save location,
 * track file naming, merged output formats, save results, and note
 * link insertion.
 * @module tests/unit/RecordingManager.output.test
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
	createRecordingSut,
	installMediaRecorder,
	installMultiTrackRecorders,
	installRecordingMediaStubs,
	makeFakeMarkerStore,
	makeMediaRecorderDouble,
	recordingManagerOver,
	stubAudioStreams,
} from '../helpers/recordingManagerTestKit';
import { useDesktopPlatform } from '../helpers/platform';
import { MarkdownView, Notice } from 'obsidian';
import { PcmStreamRecorder } from 'src/recording/PcmStreamRecorder';
import { encodeAudioBuffer } from 'src/audio/AudioEncoder';
import { getAudioSourceName } from 'src/recording/AudioStreamHandler';

// Mock AudioStreamHandler
import type { TrackAudioSource } from 'src/recording/AudioStreamHandler';

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

/** The chunk callback the manager gave the PCM recorder it built. */
function pcmChunkCallback(): (data: ArrayBuffer) => void {
	return at(jest.mocked(PcmStreamRecorder).mock.calls, 0)[2];
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

	describe('merged output with no audio', () => {
		it('keeps and report segment files when the merged blob is empty', async () => {
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

			// The mixed render encodes to an empty blob: nothing to save
			jest.mocked(encodeAudioBuffer).mockResolvedValueOnce(new Blob([]));

			await manager.startRecording();

			const pcmData = new Int16Array([100, -100, 200, -200]).buffer;
			pcmChunkCallback()(pcmData);
			await Promise.resolve();

			await manager.stopRecording();

			// No final file, no cleanup of the only remaining audio copy
			expect(mockApp.vault.createBinary).not.toHaveBeenCalledWith(
				expect.stringMatching(/multitrack-.*\.wav$/),
				expect.anything(),
			);
			expect(mockApp.vault.adapter.remove).not.toHaveBeenCalled();

			const keptNotice = (Notice as jest.Mock).mock.calls.find((call) =>
				String(call[0]).includes('Temporary track files were kept'),
			);
			expect(keptNotice).toBeDefined();
			expect(manager.getStatus()).toBe(RecordingStatus.Idle);
		});
	});

	describe('track file base names', () => {
		const setupTwoTrackRecording = (
			trackOrder: TrackAudioSource[],
		): void => {
			useDesktopPlatform();

			makeMediaRecorderDouble();

			stubAudioStreams({ count: 2, trackOrder });
		};

		const getTargets = (): { fileBaseName: string; sourceName: string }[] =>
			(
				manager as unknown as {
					chunkTargets: {
						fileBaseName: string;
						sourceName: string;
					}[];
				}
			).chunkTargets;

		it('appends track numbers when tracks share a device', async () => {
			mockSettings = {
				...DEFAULT_SETTINGS,
				enableMultiTrack: true,
				useSourceNamesForTracks: true,
				outputMode: 'multiple',
			};
			manager = recordingManagerOver(
				mockApp,
				mockSettings,
				statusChangeCallback,
			);
			setupTwoTrackRecording([
				{
					trackNumber: 1,
					deviceId: 'shared-device',
					channelMode: 'source',
				},
				{
					trackNumber: 2,
					deviceId: 'shared-device',
					channelMode: 'source',
				},
			]);

			await manager.startRecording();

			const targets = getTargets();
			expect(targets).toHaveLength(2);
			expect(at(targets, 0).sourceName).toBe('TestDevice-1');
			expect(at(targets, 1).sourceName).toBe('TestDevice-2');
			expect(at(targets, 0).fileBaseName).not.toBe(
				at(targets, 1).fileBaseName,
			);

			await manager.stopRecording();
		});

		it('keeps plain source names when they are unique', async () => {
			jest.mocked(getAudioSourceName)
				.mockResolvedValueOnce('DeviceA')
				.mockResolvedValueOnce('DeviceB');

			mockSettings = {
				...DEFAULT_SETTINGS,
				enableMultiTrack: true,
				useSourceNamesForTracks: true,
				outputMode: 'multiple',
			};
			manager = recordingManagerOver(
				mockApp,
				mockSettings,
				statusChangeCallback,
			);
			setupTwoTrackRecording([
				{ trackNumber: 1, deviceId: 'device-a', channelMode: 'source' },
				{ trackNumber: 2, deviceId: 'device-b', channelMode: 'source' },
			]);

			await manager.startRecording();

			const targets = getTargets();
			expect(at(targets, 0).sourceName).toBe('DeviceA');
			expect(at(targets, 1).sourceName).toBe('DeviceB');

			await manager.stopRecording();
		});
	});

	describe('single mode output format handling', () => {
		/**
		 * Verifies that single-file output in multi-track mode produces
		 * the configured format via offline encoding when supported.
		 */
		it('saves single-mode multi-track recording in configured format via offline encoding', async () => {
			useDesktopPlatform();

			mockSettings = {
				...DEFAULT_SETTINGS,
				enableMultiTrack: true,
				outputMode: 'single',
				recordingFormat: 'webm',
			};
			manager = recordingManagerOver(
				mockApp,
				mockSettings,
				statusChangeCallback,
			);

			const mockMediaRecorders = installMultiTrackRecorders(2);

			(mockApp.vault.adapter.readBinary as jest.Mock).mockResolvedValue(
				new Uint8Array([1, 2, 3]).buffer,
			);

			await manager.startRecording();

			const chunk = new Blob([new Uint8Array([1, 2, 3])], {
				type: 'audio/webm',
			});
			mockMediaRecorders.forEach((recorder) => {
				recorder.ondataavailable?.({ data: chunk } as BlobEvent);
			});

			await Promise.resolve();
			await manager.stopRecording();

			// Multi-track single output encodes to target format (webm) via offline encoding
			expect(mockApp.vault.createBinary).toHaveBeenCalledWith(
				expect.stringMatching(/multitrack-.*\.webm$/),
				expect.any(ArrayBuffer),
			);
			expect(mockApp.vault.adapter.remove).toHaveBeenCalledWith(
				expect.stringMatching(/-part\d+\.webm\.tmp$/),
			);
			// Verify proper audio mixing was used
			expect(global.OfflineAudioContext).toHaveBeenCalled();
		});

		it('keeps the merged file when cleanup of temporary partial files fails', async () => {
			const consoleWarnSpy = jest
				.spyOn(console, 'warn')
				.mockImplementation(() => {});
			const consoleErrorSpy = jest
				.spyOn(console, 'error')
				.mockImplementation(() => {});

			useDesktopPlatform();

			mockSettings = {
				...DEFAULT_SETTINGS,
				enableMultiTrack: true,
				outputMode: 'single',
				recordingFormat: 'webm',
			};
			manager = recordingManagerOver(
				mockApp,
				mockSettings,
				statusChangeCallback,
			);

			const mockMediaRecorders = installMultiTrackRecorders(2);

			(mockApp.vault.adapter.readBinary as jest.Mock).mockResolvedValue(
				new Uint8Array([1, 2, 3]).buffer,
			);
			(mockApp.vault.adapter.remove as jest.Mock).mockImplementation(
				async (path: string) => {
					if (path.includes('.tmp')) {
						throw new Error('cleanup failed');
					}
					return undefined;
				},
			);

			await manager.startRecording();

			const chunk = new Blob([new Uint8Array([1, 2, 3])], {
				type: 'audio/webm',
			});
			mockMediaRecorders.forEach((recorder) => {
				recorder.ondataavailable?.({ data: chunk } as BlobEvent);
			});

			await Promise.resolve();
			await manager.stopRecording();

			expect(mockApp.vault.createBinary).toHaveBeenCalledWith(
				expect.stringMatching(/multitrack-.*\.webm$/),
				expect.any(ArrayBuffer),
			);
			// The merged file is the only complete copy of the audio of
			// segments removed by the partial cleanup: it must never be
			// rolled back
			expect(mockApp.vault.adapter.remove).not.toHaveBeenCalledWith(
				expect.stringMatching(/multitrack-.*\.webm$/),
			);
			expect(Notice).toHaveBeenCalledWith(
				expect.stringContaining(
					'Recording saved, but temporary files could not be removed:',
				),
			);
			expect(Notice).toHaveBeenCalledWith('Saved 1 audio file(s)');
			expect(Notice).not.toHaveBeenCalledWith(
				expect.stringContaining('Error stopping recording:'),
			);
			expect(consoleErrorSpy).toHaveBeenCalledWith(
				expect.stringContaining(
					'Temporary segment files could not be removed',
				),
				expect.arrayContaining([expect.stringContaining('.tmp')]),
			);
			expect(consoleWarnSpy).toHaveBeenCalledWith(
				expect.stringContaining('[AudioRecorder]'),
				expect.objectContaining({
					error: expect.objectContaining({
						message: 'cleanup failed',
					}),
				}),
			);

			consoleWarnSpy.mockRestore();
		});

		/**
		 * Regression: multi-track MP4 must produce a properly mixed/encoded file
		 * via OfflineAudioContext instead of broken concatenated MP4 containers.
		 */
		it('merges MP4 multi-track recording into target format with all tracks mixed', async () => {
			useDesktopPlatform();

			mockSettings = {
				...DEFAULT_SETTINGS,
				enableMultiTrack: true,
				outputMode: 'single',
				recordingFormat: 'mp4',
			};
			manager = recordingManagerOver(
				mockApp,
				mockSettings,
				statusChangeCallback,
			);

			const mockMediaRecorders = installMultiTrackRecorders(2);

			(mockApp.vault.adapter.readBinary as jest.Mock).mockResolvedValue(
				new Uint8Array([1, 2, 3]).buffer,
			);

			await manager.startRecording();

			const chunk = new Blob([new Uint8Array([1, 2, 3])], {
				type: 'audio/mp4',
			});
			mockMediaRecorders.forEach((recorder) => {
				recorder.ondataavailable?.({ data: chunk } as BlobEvent);
			});

			await Promise.resolve();
			await manager.stopRecording();

			// Must produce MP4 (properly mixed via OfflineAudioContext + offline encoding)
			expect(mockApp.vault.createBinary).toHaveBeenCalledWith(
				expect.stringMatching(/multitrack-.*\.mp4$/),
				expect.any(ArrayBuffer),
			);
			// OfflineAudioContext should have been used for mixing
			expect(global.OfflineAudioContext).toHaveBeenCalled();
		});

		/**
		 * Ensures that WAV output mode uses direct PCM capture on desktop
		 * and writes files with .wav extension assembled from PCM segments.
		 */
		it('converts to wav only when output format is wav', async () => {
			mockSettings = {
				...DEFAULT_SETTINGS,
				recordingFormat: 'wav',
			};
			manager = recordingManagerOver(
				mockApp,
				mockSettings,
				statusChangeCallback,
			);

			installMediaRecorder(undefined, (mime) => mime === 'audio/webm');

			stubAudioStreams();

			await manager.startRecording();

			// Simulate PCM chunk via captured callback
			const pcmData = new Int16Array([100, -100, 200, -200]).buffer;
			pcmChunkCallback()(pcmData);

			await Promise.resolve();
			await manager.stopRecording();

			expect(mockApp.vault.createBinary).toHaveBeenCalledWith(
				expect.stringMatching(/\.wav$/),
				expect.any(ArrayBuffer),
			);
			expect(mockApp.vault.adapter.rename).not.toHaveBeenCalled();
		});
	});

	describe('context-aware save location', () => {
		it('saves near active markdown file when enabled without subfolder', async () => {
			mockSettings = {
				...DEFAULT_SETTINGS,
				saveNearActiveFile: true,
				activeFileSubfolder: '',
			};
			manager = recordingManagerOver(
				mockApp,
				mockSettings,
				statusChangeCallback,
			);
			(mockApp.workspace.getActiveFile as jest.Mock).mockReturnValue({
				path: 'Meetings/2026/Meeting Note.md',
			});

			const mockMediaRecorder = makeMediaRecorderDouble();

			stubAudioStreams();

			await manager.startRecording();

			const chunk = new Blob([new Uint8Array([1, 2, 3])], {
				type: 'audio/webm',
			});
			mockMediaRecorder.ondataavailable?.({ data: chunk } as BlobEvent);
			await Promise.resolve();

			await manager.stopRecording();

			expect(mockApp.vault.adapter.writeBinary).toHaveBeenCalledWith(
				expect.stringMatching(
					/^Meetings\/2026\/recording-Track1-.*-part1\.webm\.tmp$/,
				),
				expect.any(ArrayBuffer),
			);
		});

		it('creates active file subfolder and save recording there', async () => {
			mockSettings = {
				...DEFAULT_SETTINGS,
				saveNearActiveFile: true,
				activeFileSubfolder: 'Audio',
			};
			manager = recordingManagerOver(
				mockApp,
				mockSettings,
				statusChangeCallback,
			);
			(mockApp.workspace.getActiveFile as jest.Mock).mockReturnValue({
				path: 'Meetings/2026/Meeting Note.md',
			});

			const mockMediaRecorder = makeMediaRecorderDouble();

			stubAudioStreams();

			await manager.startRecording();

			const chunk = new Blob([new Uint8Array([1, 2, 3])], {
				type: 'audio/webm',
			});
			mockMediaRecorder.ondataavailable?.({ data: chunk } as BlobEvent);
			await Promise.resolve();

			await manager.stopRecording();

			expect(mockApp.vault.createFolder).toHaveBeenCalledWith(
				'Meetings/2026/Audio',
			);
			expect(mockApp.vault.adapter.writeBinary).toHaveBeenCalledWith(
				expect.stringMatching(
					/^Meetings\/2026\/Audio\/recording-Track1-.*-part1\.webm\.tmp$/,
				),
				expect.any(ArrayBuffer),
			);
		});

		it('fallbacks to global save folder when near-active mode is disabled', async () => {
			mockSettings = {
				...DEFAULT_SETTINGS,
				saveFolder: 'Recordings',
				saveNearActiveFile: false,
				activeFileSubfolder: 'Audio',
			};
			manager = recordingManagerOver(
				mockApp,
				mockSettings,
				statusChangeCallback,
			);
			(mockApp.workspace.getActiveFile as jest.Mock).mockReturnValue({
				path: 'Meetings/2026/Meeting Note.md',
			});

			const mockMediaRecorder = makeMediaRecorderDouble();

			stubAudioStreams();

			await manager.startRecording();

			const chunk = new Blob([new Uint8Array([1, 2, 3])], {
				type: 'audio/webm',
			});
			mockMediaRecorder.ondataavailable?.({ data: chunk } as BlobEvent);
			await Promise.resolve();

			await manager.stopRecording();

			expect(mockApp.vault.adapter.writeBinary).toHaveBeenCalledWith(
				expect.stringMatching(
					/^Recordings\/recording-Track1-.*-part1\.webm\.tmp$/,
				),
				expect.any(ArrayBuffer),
			);
		});
	});

	describe('insertFileLinks uses basename only', () => {
		it('inserts only filename without directory path in wikilinks', async () => {
			const mockReplaceSelection = jest.fn();
			(
				mockApp.workspace.getActiveViewOfType as jest.Mock
			).mockReturnValue({
				editor: { replaceSelection: mockReplaceSelection },
			});

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
			await Promise.resolve();

			await manager.stopRecording();

			expect(mockReplaceSelection).toHaveBeenCalled();
			const insertedText = mockReplaceSelection.mock
				.calls[0][0] as string;
			expect(insertedText).not.toContain('/');
			expect(insertedText).toMatch(/^!\[\[recording-.*\]\]$/);
		});

		it('uses basename when file is saved in a nested directory', async () => {
			mockSettings = {
				...DEFAULT_SETTINGS,
				saveNearActiveFile: true,
				activeFileSubfolder: 'Audio',
			};
			manager = recordingManagerOver(
				mockApp,
				mockSettings,
				statusChangeCallback,
			);
			(mockApp.workspace.getActiveFile as jest.Mock).mockReturnValue({
				path: 'Projects/Notes/Daily.md',
			});

			const mockReplaceSelection = jest.fn();
			(
				mockApp.workspace.getActiveViewOfType as jest.Mock
			).mockReturnValue({
				editor: { replaceSelection: mockReplaceSelection },
			});

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
			await Promise.resolve();

			await manager.stopRecording();

			expect(mockReplaceSelection).toHaveBeenCalled();
			const insertedText = mockReplaceSelection.mock
				.calls[0][0] as string;
			expect(insertedText).not.toContain('Projects/');
			expect(insertedText).not.toContain('Audio/');
			expect(insertedText).toMatch(/^!\[\[recording-.*\]\]$/);
		});
	});

	describe('insertFileLinks with insertionContext', () => {
		let mockMediaRecorder: {
			start: jest.Mock;
			stop: jest.Mock;
			pause: jest.Mock;
			resume: jest.Mock;
			ondataavailable: ((event: BlobEvent) => void) | null;
			onerror: ((event: Event) => void) | null;
			addEventListener: jest.Mock;
		};

		beforeEach(() => {
			mockMediaRecorder = makeMediaRecorderDouble();

			stubAudioStreams();

			(mockApp.vault.adapter.readBinary as jest.Mock).mockResolvedValue(
				new Uint8Array([1, 2, 3]).buffer,
			);
		});

		it('uses replaceSelection on active note when insertAtOriginalPosition is disabled', async () => {
			const mockReplaceSelection = jest.fn();
			(
				mockApp.workspace.getActiveViewOfType as jest.Mock
			).mockReturnValue({
				editor: { replaceSelection: mockReplaceSelection },
			});

			mockSettings = {
				...DEFAULT_SETTINGS,
				insertAtOriginalPosition: false,
			};
			manager = recordingManagerOver(
				mockApp,
				mockSettings,
				statusChangeCallback,
			);

			await manager.startRecording();
			const chunk = new Blob([new Uint8Array([1, 2, 3])], {
				type: 'audio/webm',
			});
			mockMediaRecorder.ondataavailable?.({ data: chunk } as BlobEvent);
			await Promise.resolve();
			await manager.stopRecording();

			expect(mockReplaceSelection).toHaveBeenCalled();
		});

		it('forwards the saved audio paths and note path to the post-save hook', async () => {
			// Regression: transcribe-on-save must receive the note the recording
			// links landed in, so an auto-transcription targets that note rather
			// than whatever file is active when the async job runs.
			const onRecordingSaved = jest.fn();
			(
				mockApp.workspace.getActiveViewOfType as jest.Mock
			).mockReturnValue({
				file: { path: 'Notes/active.md' },
				editor: { replaceSelection: jest.fn() },
			});

			mockSettings = {
				...DEFAULT_SETTINGS,
				insertAtOriginalPosition: false,
			};
			manager = new RecordingManager(
				mockApp,
				mockSettings,
				statusChangeCallback,
				makeFakeMarkerStore().store,
				undefined,
				onRecordingSaved,
			);

			await manager.startRecording();
			const chunk = new Blob([new Uint8Array([1, 2, 3])], {
				type: 'audio/webm',
			});
			mockMediaRecorder.ondataavailable?.({ data: chunk } as BlobEvent);
			await Promise.resolve();
			await manager.stopRecording();

			expect(onRecordingSaved).toHaveBeenCalledTimes(1);
			const result = onRecordingSaved.mock.calls[0][0] as {
				audioPaths: string[];
				notePath: string | null;
				durationSeconds?: number;
			};
			expect(result.audioPaths.length).toBeGreaterThan(0);
			expect(result.notePath).toBe('Notes/active.md');
			expect(result.durationSeconds).toEqual(expect.any(Number));
		});

		it('uses replaceRange at stored position when insertAtOriginalPosition is enabled', async () => {
			const mockReplaceRange = jest.fn();
			const mockGetCursor = jest.fn().mockReturnValue({ line: 5, ch: 3 });

			// Mock getActiveViewOfType to return a view with file and editor for capture
			(
				mockApp.workspace.getActiveViewOfType as jest.Mock
			).mockReturnValue({
				file: { path: 'Notes/my-note.md' },
				editor: {
					getCursor: mockGetCursor,
					replaceRange: mockReplaceRange,
					replaceSelection: jest.fn(),
				},
			});

			// Mock getLeavesOfType for finding the stored note
			const mockLeafView = {
				file: { path: 'Notes/my-note.md' },
				editor: {
					replaceRange: mockReplaceRange,
					replaceSelection: jest.fn(),
				},
			};
			// The production code narrows leaves with instanceof MarkdownView.
			Object.setPrototypeOf(mockLeafView, MarkdownView.prototype);
			(
				mockApp.workspace as unknown as Record<string, unknown>
			).getLeavesOfType = jest
				.fn()
				.mockReturnValue([{ view: mockLeafView }]);

			mockSettings = {
				...DEFAULT_SETTINGS,
				insertAtOriginalPosition: true,
			};
			manager = recordingManagerOver(
				mockApp,
				mockSettings,
				statusChangeCallback,
			);

			await manager.startRecording();
			const chunk = new Blob([new Uint8Array([1, 2, 3])], {
				type: 'audio/webm',
			});
			mockMediaRecorder.ondataavailable?.({ data: chunk } as BlobEvent);
			await Promise.resolve();
			await manager.stopRecording();

			expect(mockReplaceRange).toHaveBeenCalledWith(
				expect.stringMatching(/^!\[\[recording-.*\]\]\n$/),
				{ line: 6, ch: 0 },
			);
		});

		it('fallbacks to replaceSelection when stored note leaf is not found', async () => {
			const mockReplaceSelection = jest.fn();
			const mockGetCursor = jest.fn().mockReturnValue({ line: 2, ch: 0 });

			// During capture, return a view with file and editor
			(
				mockApp.workspace.getActiveViewOfType as jest.Mock
			).mockReturnValue({
				file: { path: 'Notes/original.md' },
				editor: {
					getCursor: mockGetCursor,
					replaceSelection: mockReplaceSelection,
				},
			});

			// No matching leaf found
			(
				mockApp.workspace as unknown as Record<string, unknown>
			).getLeavesOfType = jest.fn().mockReturnValue([]);

			mockSettings = {
				...DEFAULT_SETTINGS,
				insertAtOriginalPosition: true,
			};
			manager = recordingManagerOver(
				mockApp,
				mockSettings,
				statusChangeCallback,
			);

			await manager.startRecording();
			const chunk = new Blob([new Uint8Array([1, 2, 3])], {
				type: 'audio/webm',
			});
			mockMediaRecorder.ondataavailable?.({ data: chunk } as BlobEvent);
			await Promise.resolve();
			await manager.stopRecording();

			// Falls back to active view replaceSelection
			expect(mockReplaceSelection).toHaveBeenCalled();
		});

		it('clears insertionContext after stopRecording', async () => {
			const mockGetCursor = jest.fn().mockReturnValue({ line: 0, ch: 0 });
			(
				mockApp.workspace.getActiveViewOfType as jest.Mock
			).mockReturnValue({
				file: { path: 'Notes/test.md' },
				editor: {
					getCursor: mockGetCursor,
					replaceSelection: jest.fn(),
				},
			});
			(
				mockApp.workspace as unknown as Record<string, unknown>
			).getLeavesOfType = jest.fn().mockReturnValue([]);

			mockSettings = {
				...DEFAULT_SETTINGS,
				insertAtOriginalPosition: true,
			};
			manager = recordingManagerOver(
				mockApp,
				mockSettings,
				statusChangeCallback,
			);

			await manager.startRecording();
			await manager.stopRecording();

			// Access private field to verify cleanup
			const context = (
				manager as unknown as { insertionContext: unknown }
			).insertionContext;
			expect(context).toBeNull();
		});
	});
});
