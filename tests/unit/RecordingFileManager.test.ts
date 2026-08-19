/**
 * Unit tests for RecordingFileManager module.
 * Tests file I/O operations: path resolution, saving, cleanup, and rollback.
 * @module tests/unit/RecordingFileManager.test
 */

import type { App, TFile } from 'obsidian';
import {
	DEFAULT_SETTINGS,
	type AudioRecorderSettings,
} from 'src/settings/settingsSchema';
import type { RecordingTarget } from 'src/types';
import {
	getActiveFileDirectory,
	getBaseSaveDirectory,
	ensureFolderExists,
	resolveUniquePath,
	resolveUniquePathInDirectory,
	saveAudioFile,
	removeTemporaryArtifacts,
	cleanupIntermediateFiles,
} from 'src/audio/RecordingFileManager';
import { partial } from '../helpers/doubles';
import { createMockApp } from '../helpers/createApp';
import { at } from '../helpers/assertions';

// Polyfill Blob.arrayBuffer for jsdom if missing

describe('RecordingFileManager', () => {
	let mockApp: App;
	let mockSettings: AudioRecorderSettings;
	let consoleDebugSpy: jest.SpyInstance;
	let consoleWarnSpy: jest.SpyInstance;

	beforeEach(() => {
		consoleDebugSpy = jest.spyOn(console, 'debug').mockImplementation();
		consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation();
		jest.spyOn(console, 'error').mockImplementation();

		// Create mock App with all required vault and workspace methods
		mockApp = createMockApp({
			vault: {
				adapter: {
					exists: jest.fn().mockResolvedValue(false),
					remove: jest.fn().mockResolvedValue(undefined),
				},
				createBinary: jest.fn().mockResolvedValue(undefined),
				createFolder: jest.fn().mockResolvedValue(undefined),
			},
			workspace: {
				getActiveFile: jest.fn().mockReturnValue(null),
				getActiveViewOfType: jest.fn().mockReturnValue(null),
			},
		}).app;

		// Use default settings with a defined saveFolder
		mockSettings = {
			...DEFAULT_SETTINGS,
			saveFolder: 'Recordings',
		};
	});

	// -----------------------------------------------------------------------
	// getActiveFileDirectory
	// -----------------------------------------------------------------------
	describe('getActiveFileDirectory', () => {
		it.each([
			{
				name: 'a note in a folder',
				path: 'Notes/Daily/2024-01-01.md',
				expected: 'Notes/Daily',
			},
			{
				name: 'a deeply nested note',
				path: 'a/b/c/d/note.md',
				expected: 'a/b/c/d',
			},
			{
				name: 'a note whose extension is upper-case',
				path: 'Notes/README.MD',
				expected: 'Notes',
			},
			{ name: 'a note at the vault root', path: 'note.md', expected: '' },
			{
				name: 'a file that is not a note',
				path: 'Assets/image.png',
				expected: '',
			},
			{ name: 'no active file at all', path: null, expected: '' },
		])('answers "$expected" for $name', ({ path, expected }) => {
			// This decides where a recording lands when "save near the active
			// file" is on, so anything that is not a note in a folder has to
			// fall back to the configured folder rather than guess.
			jest.mocked(mockApp.workspace.getActiveFile).mockReturnValue(
				path === null ? null : partial<TFile>({ path }),
			);

			expect(getActiveFileDirectory(mockApp)).toBe(expected);
		});
	});

	// -----------------------------------------------------------------------
	// getBaseSaveDirectory
	// -----------------------------------------------------------------------
	describe('getBaseSaveDirectory', () => {
		it('returns saveFolder when saveNearActiveFile is false', () => {
			mockSettings.saveNearActiveFile = false;
			mockSettings.saveFolder = 'MyRecordings';

			const result = getBaseSaveDirectory(mockSettings, mockApp);

			expect(result).toBe('MyRecordings');
		});

		it('returns active file directory when saveNearActiveFile is true and subfolder is empty', () => {
			mockSettings.saveNearActiveFile = true;
			mockSettings.activeFileSubfolder = '';
			(mockApp.workspace.getActiveFile as jest.Mock).mockReturnValue({
				path: 'Notes/Daily/today.md',
			});

			const result = getBaseSaveDirectory(mockSettings, mockApp);

			expect(result).toBe('Notes/Daily');
		});

		it('returns active file directory + subfolder when saveNearActiveFile is true and subfolder set', () => {
			mockSettings.saveNearActiveFile = true;
			mockSettings.activeFileSubfolder = 'audio';
			(mockApp.workspace.getActiveFile as jest.Mock).mockReturnValue({
				path: 'Notes/Daily/today.md',
			});

			const result = getBaseSaveDirectory(mockSettings, mockApp);

			expect(result).toBe('Notes/Daily/audio');
		});

		it('handles whitespace-only subfolder as empty', () => {
			mockSettings.saveNearActiveFile = true;
			mockSettings.activeFileSubfolder = '   ';
			(mockApp.workspace.getActiveFile as jest.Mock).mockReturnValue({
				path: 'Notes/today.md',
			});

			const result = getBaseSaveDirectory(mockSettings, mockApp);

			expect(result).toBe('Notes');
		});

		it('returns subfolder relative to root when no active .md file', () => {
			mockSettings.saveNearActiveFile = true;
			mockSettings.activeFileSubfolder = 'recordings';
			(mockApp.workspace.getActiveFile as jest.Mock).mockReturnValue(
				null,
			);

			const result = getBaseSaveDirectory(mockSettings, mockApp);

			// activeDir = '', so result = '/recordings' normalized
			expect(result).toBe('/recordings');
		});
	});

	// -----------------------------------------------------------------------
	// ensureFolderExists
	// -----------------------------------------------------------------------
	describe('ensureFolderExists', () => {
		it('does not create folder if it already exists', async () => {
			(mockApp.vault.adapter.exists as jest.Mock).mockResolvedValue(true);

			await ensureFolderExists('Recordings', mockApp);

			expect(mockApp.vault.adapter.exists).toHaveBeenCalledWith(
				'Recordings',
			);
			expect(mockApp.vault.createFolder).not.toHaveBeenCalled();
		});

		it('creates folder if it does not exist', async () => {
			(mockApp.vault.adapter.exists as jest.Mock).mockResolvedValue(
				false,
			);

			await ensureFolderExists('Recordings/new', mockApp);

			expect(mockApp.vault.adapter.exists).toHaveBeenCalledWith(
				'Recordings/new',
			);
			expect(mockApp.vault.createFolder).toHaveBeenCalledWith(
				'Recordings/new',
			);
		});

		it('skips creation for empty path', async () => {
			await ensureFolderExists('', mockApp);

			expect(mockApp.vault.adapter.exists).not.toHaveBeenCalled();
			expect(mockApp.vault.createFolder).not.toHaveBeenCalled();
		});

		it('skips creation for whitespace-only path', async () => {
			await ensureFolderExists('   ', mockApp);

			expect(mockApp.vault.adapter.exists).not.toHaveBeenCalled();
			expect(mockApp.vault.createFolder).not.toHaveBeenCalled();
		});

		it('normalizes backslashes in path', async () => {
			(mockApp.vault.adapter.exists as jest.Mock).mockResolvedValue(
				false,
			);

			await ensureFolderExists('Recordings\\subfolder', mockApp);

			// normalizePath converts backslashes to forward slashes
			expect(mockApp.vault.adapter.exists).toHaveBeenCalledWith(
				'Recordings/subfolder',
			);
			expect(mockApp.vault.createFolder).toHaveBeenCalledWith(
				'Recordings/subfolder',
			);
		});
	});

	// -----------------------------------------------------------------------
	// resolveUniquePathInDirectory
	// -----------------------------------------------------------------------
	describe('resolveUniquePathInDirectory', () => {
		it('returns the path directly when free', async () => {
			(mockApp.vault.adapter.exists as jest.Mock).mockResolvedValue(
				false,
			);

			const result = await resolveUniquePathInDirectory(
				'Recordings',
				'clip.webm',
				mockApp,
			);

			expect(result).toBe('Recordings/clip.webm');
		});

		it('appends a counter on collision', async () => {
			(mockApp.vault.adapter.exists as jest.Mock)
				.mockResolvedValueOnce(true)
				.mockResolvedValueOnce(false);

			const result = await resolveUniquePathInDirectory(
				'Recordings',
				'clip.webm',
				mockApp,
			);

			expect(result).toBe('Recordings/clip_1.webm');
		});

		it('keeps multi-dot names intact', async () => {
			(mockApp.vault.adapter.exists as jest.Mock)
				.mockResolvedValueOnce(true)
				.mockResolvedValueOnce(false);

			const result = await resolveUniquePathInDirectory(
				'Recordings',
				'clip.part1.webm.tmp',
				mockApp,
			);

			expect(result).toBe('Recordings/clip.part1.webm_1.tmp');
		});

		it('sanitizes illegal characters', async () => {
			(mockApp.vault.adapter.exists as jest.Mock).mockResolvedValue(
				false,
			);

			const result = await resolveUniquePathInDirectory(
				'Recordings',
				'clip:1?.webm',
				mockApp,
			);

			expect(result).toBe('Recordings/clip-1-.webm');
		});
	});

	// -----------------------------------------------------------------------
	// resolveUniquePath
	// -----------------------------------------------------------------------
	describe('resolveUniquePath', () => {
		it('returns the path directly when no collision', async () => {
			mockSettings.saveFolder = 'Recordings';
			(mockApp.vault.adapter.exists as jest.Mock).mockResolvedValue(
				false,
			);

			const result = await resolveUniquePath(
				'test.webm',
				mockApp,
				mockSettings,
			);

			expect(result).toBe('Recordings/test.webm');
		});

		it('appends counter when file already exists', async () => {
			mockSettings.saveFolder = 'Recordings';
			(mockApp.vault.adapter.exists as jest.Mock)
				.mockResolvedValueOnce(false) // ensureFolderExists check
				.mockResolvedValueOnce(true) // first path exists
				.mockResolvedValueOnce(false); // counter path does not exist

			const result = await resolveUniquePath(
				'test.webm',
				mockApp,
				mockSettings,
			);

			expect(result).toBe('Recordings/test_1.webm');
		});

		it('increments counter multiple times until unique path found', async () => {
			// The implementation mutates sanitizedFileName each iteration,
			// so counters accumulate: test -> test_1 -> test_1_2 -> test_1_2_3
			mockSettings.saveFolder = 'Recordings';
			(mockApp.vault.adapter.exists as jest.Mock)
				.mockResolvedValueOnce(false) // ensureFolderExists check
				.mockResolvedValueOnce(true) // Recordings/test.webm exists
				.mockResolvedValueOnce(true) // Recordings/test_1.webm exists
				.mockResolvedValueOnce(true) // Recordings/test_1_2.webm exists
				.mockResolvedValueOnce(false); // Recordings/test_1_2_3.webm free

			const result = await resolveUniquePath(
				'test.webm',
				mockApp,
				mockSettings,
			);

			expect(result).toBe('Recordings/test_1_2_3.webm');
		});

		it('sanitizes special characters in filename', async () => {
			mockSettings.saveFolder = 'Recordings';
			(mockApp.vault.adapter.exists as jest.Mock).mockResolvedValue(
				false,
			);

			const result = await resolveUniquePath(
				'test:file*name?.webm',
				mockApp,
				mockSettings,
			);

			expect(result).toBe('Recordings/test-file-name-.webm');
		});

		it('ensures folder is created before resolving path', async () => {
			mockSettings.saveFolder = 'NewFolder';
			(mockApp.vault.adapter.exists as jest.Mock).mockResolvedValue(
				false,
			);

			await resolveUniquePath('file.mp3', mockApp, mockSettings);

			expect(mockApp.vault.createFolder).toHaveBeenCalledWith(
				'NewFolder',
			);
		});

		it('handles filename with multiple dots', async () => {
			mockSettings.saveFolder = 'Recordings';
			(mockApp.vault.adapter.exists as jest.Mock)
				.mockResolvedValueOnce(false) // ensureFolderExists
				.mockResolvedValueOnce(true) // first attempt exists
				.mockResolvedValueOnce(false); // counter path free

			const result = await resolveUniquePath(
				'my.recording.2024.webm',
				mockApp,
				mockSettings,
			);

			expect(result).toBe('Recordings/my.recording.2024_1.webm');
		});

		it('sanitizes all invalid characters from filename', async () => {
			mockSettings.saveFolder = '';
			(mockApp.vault.adapter.exists as jest.Mock).mockResolvedValue(
				false,
			);

			const result = await resolveUniquePath(
				'a\\b/c:d*e?f"g<h>i|j.ogg',
				mockApp,
				mockSettings,
			);

			expect(result).toBe('/a-b-c-d-e-f-g-h-i-j.ogg');
		});
	});

	// -----------------------------------------------------------------------
	// saveAudioFile
	// -----------------------------------------------------------------------
	describe('saveAudioFile', () => {
		it('saves a non-empty blob and return the file path', async () => {
			mockSettings.saveFolder = 'Recordings';
			(mockApp.vault.adapter.exists as jest.Mock).mockResolvedValue(
				false,
			);
			const blob = new Blob(['audio data'], { type: 'audio/webm' });

			const result = await saveAudioFile(
				blob,
				'test.webm',
				mockApp,
				mockSettings,
			);

			expect(result).toBe('Recordings/test.webm');
			expect(mockApp.vault.createBinary).toHaveBeenCalledWith(
				'Recordings/test.webm',
				expect.any(ArrayBuffer),
			);
		});

		it('returns null for an empty blob', async () => {
			const emptyBlob = new Blob([], { type: 'audio/webm' });

			const result = await saveAudioFile(
				emptyBlob,
				'empty.webm',
				mockApp,
				mockSettings,
			);

			expect(result).toBeNull();
			expect(consoleDebugSpy).toHaveBeenCalledWith(
				expect.stringContaining('Skipping empty file'),
			);
			expect(mockApp.vault.createBinary).not.toHaveBeenCalled();
		});

		it('uses resolveUniquePath to determine the final path', async () => {
			mockSettings.saveFolder = 'Recordings';
			(mockApp.vault.adapter.exists as jest.Mock)
				.mockResolvedValueOnce(false) // ensureFolderExists
				.mockResolvedValueOnce(true) // first path collision
				.mockResolvedValueOnce(false); // counter path free
			const blob = new Blob(['data'], { type: 'audio/webm' });

			const result = await saveAudioFile(
				blob,
				'recording.webm',
				mockApp,
				mockSettings,
			);

			expect(result).toBe('Recordings/recording_1.webm');
			expect(mockApp.vault.createBinary).toHaveBeenCalledWith(
				'Recordings/recording_1.webm',
				expect.any(ArrayBuffer),
			);
		});

		it('converts blob to ArrayBuffer before saving', async () => {
			mockSettings.saveFolder = '';
			(mockApp.vault.adapter.exists as jest.Mock).mockResolvedValue(
				false,
			);
			const blob = new Blob(['hello world'], { type: 'audio/wav' });

			await saveAudioFile(blob, 'test.wav', mockApp, mockSettings);

			// The type alone would pass on an empty buffer, which saves a
			// zero-byte recording and loses the take.
			const [, written] = at(
				jest.mocked(mockApp.vault.createBinary).mock.calls,
				0,
			);

			expect(written).toBeInstanceOf(ArrayBuffer);
			expect(new TextDecoder().decode(written)).toBe('hello world');
		});
	});

	// -----------------------------------------------------------------------
	// removeTemporaryArtifacts
	// -----------------------------------------------------------------------
	describe('removeTemporaryArtifacts', () => {
		it('removes all paths successfully and return empty array', async () => {
			(mockApp.vault.adapter.remove as jest.Mock).mockResolvedValue(
				undefined,
			);

			const result = await removeTemporaryArtifacts(
				['path/a.tmp', 'path/b.tmp', 'path/c.tmp'],
				'cleanup context',
				mockApp,
			);

			expect(result).toEqual([]);
			expect(mockApp.vault.adapter.remove).toHaveBeenCalledTimes(3);
			expect(mockApp.vault.adapter.remove).toHaveBeenCalledWith(
				'path/a.tmp',
			);
			expect(mockApp.vault.adapter.remove).toHaveBeenCalledWith(
				'path/b.tmp',
			);
			expect(mockApp.vault.adapter.remove).toHaveBeenCalledWith(
				'path/c.tmp',
			);
		});

		it('returns failed paths when some removals fail', async () => {
			(mockApp.vault.adapter.remove as jest.Mock)
				.mockResolvedValueOnce(undefined) // a.tmp succeeds
				.mockRejectedValueOnce(new Error('ENOENT')) // b.tmp fails
				.mockResolvedValueOnce(undefined); // c.tmp succeeds

			const result = await removeTemporaryArtifacts(
				['path/a.tmp', 'path/b.tmp', 'path/c.tmp'],
				'cleanup context',
				mockApp,
			);

			expect(result).toEqual(['path/b.tmp']);
			expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
			expect(consoleWarnSpy).toHaveBeenCalledWith(
				expect.stringContaining('cleanup context'),
				expect.objectContaining({
					path: 'path/b.tmp',
					error: expect.any(Error),
				}),
			);
		});

		it('returns all paths when all removals fail', async () => {
			(mockApp.vault.adapter.remove as jest.Mock).mockRejectedValue(
				new Error('Permission denied'),
			);

			const result = await removeTemporaryArtifacts(
				['x.tmp', 'y.tmp'],
				'total failure',
				mockApp,
			);

			expect(result).toEqual(expect.arrayContaining(['x.tmp', 'y.tmp']));
			expect(result).toHaveLength(2);
			expect(consoleWarnSpy).toHaveBeenCalledTimes(2);
		});

		it('returns empty array for empty input', async () => {
			const result = await removeTemporaryArtifacts(
				[],
				'no paths',
				mockApp,
			);

			expect(result).toEqual([]);
			expect(mockApp.vault.adapter.remove).not.toHaveBeenCalled();
		});

		it('includes log prefix in warning messages', async () => {
			(mockApp.vault.adapter.remove as jest.Mock).mockRejectedValue(
				new Error('fail'),
			);

			await removeTemporaryArtifacts(
				['file.tmp'],
				'removal failed',
				mockApp,
			);

			expect(consoleWarnSpy).toHaveBeenCalledWith(
				expect.stringContaining('[AudioRecorder]'),
				expect.anything(),
			);
		});
	});

	// -----------------------------------------------------------------------
	// cleanupIntermediateFiles
	// -----------------------------------------------------------------------
	describe('cleanupIntermediateFiles', () => {
		function createMockTarget(segmentPaths: string[]): RecordingTarget {
			return {
				fileBaseName: 'recording',
				sourceName: 'TestDevice',
				bufferedChunks: [],
				bufferedBytes: 0,
				segmentIndex: 0,
				segmentPaths,
				pendingWrite: Promise.resolve(),
				pcmBuffers: [],
				pcmBufferedBytes: 0,
				pcmChannels: 1,
				pcmSampleRate: 44100,
				partIndex: 0,
				partPaths: [],
				partPcmBytes: 0,
			};
		}

		it('collects segment paths from all targets and remove them', async () => {
			(mockApp.vault.adapter.remove as jest.Mock).mockResolvedValue(
				undefined,
			);

			const targets = [
				createMockTarget(['seg1.webm', 'seg2.webm']),
				createMockTarget(['seg3.webm']),
			];

			const result = await cleanupIntermediateFiles(targets, mockApp);

			expect(result).toEqual([]);
			expect(mockApp.vault.adapter.remove).toHaveBeenCalledTimes(3);
			expect(mockApp.vault.adapter.remove).toHaveBeenCalledWith(
				'seg1.webm',
			);
			expect(mockApp.vault.adapter.remove).toHaveBeenCalledWith(
				'seg2.webm',
			);
			expect(mockApp.vault.adapter.remove).toHaveBeenCalledWith(
				'seg3.webm',
			);
		});

		it('returns failed paths from multiple targets', async () => {
			(mockApp.vault.adapter.remove as jest.Mock)
				.mockResolvedValueOnce(undefined) // seg1 ok
				.mockRejectedValueOnce(new Error('fail')) // seg2 fail
				.mockResolvedValueOnce(undefined); // seg3 ok

			const targets = [
				createMockTarget(['seg1.webm', 'seg2.webm']),
				createMockTarget(['seg3.webm']),
			];

			const result = await cleanupIntermediateFiles(targets, mockApp);

			expect(result).toEqual(['seg2.webm']);
		});

		it('handles empty targets array', async () => {
			const result = await cleanupIntermediateFiles([], mockApp);

			expect(result).toEqual([]);
			expect(mockApp.vault.adapter.remove).not.toHaveBeenCalled();
		});

		it('handles targets with empty segmentPaths', async () => {
			const targets = [createMockTarget([]), createMockTarget([])];

			const result = await cleanupIntermediateFiles(targets, mockApp);

			expect(result).toEqual([]);
			expect(mockApp.vault.adapter.remove).not.toHaveBeenCalled();
		});

		it('uses correct log context for failed removals', async () => {
			(mockApp.vault.adapter.remove as jest.Mock).mockRejectedValue(
				new Error('fail'),
			);

			const targets = [createMockTarget(['seg.webm'])];

			await cleanupIntermediateFiles(targets, mockApp);

			expect(consoleWarnSpy).toHaveBeenCalledWith(
				expect.stringContaining(
					'Failed to remove intermediate recording file',
				),
				expect.anything(),
			);
		});
	});
});
