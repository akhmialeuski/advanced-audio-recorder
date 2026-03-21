/**
 * Unit tests for RecordingFileManager module.
 * Tests file I/O operations: path resolution, saving, cleanup, and rollback.
 * @module tests/unit/RecordingFileManager.test
 */
/** @jest-environment jsdom */

import type { App } from 'obsidian';
import {
	DEFAULT_SETTINGS,
	AudioRecorderSettings,
} from '../../src/settings/Settings';
import type { RecordingTarget } from '../../src/types';
import {
	getActiveFileDirectory,
	getBaseSaveDirectory,
	ensureFolderExists,
	resolveUniquePath,
	saveAudioFile,
	removeTemporaryArtifacts,
	rollbackFinalFile,
	cleanupIntermediateFiles,
} from '../../src/recording/RecordingFileManager';

// Mock obsidian module
jest.mock('obsidian', () => ({
	normalizePath: (path: string) => path.replace(/\\/g, '/'),
}));

// Polyfill Blob.arrayBuffer for jsdom if missing
if (!Blob.prototype.arrayBuffer) {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- jsdom polyfill required for test environment
	(Blob.prototype as any).arrayBuffer = function (): Promise<ArrayBuffer> {
		return new Promise((resolve, reject) => {
			const reader = new FileReader();
			reader.onload = (): void => resolve(reader.result as ArrayBuffer);
			reader.onerror = (): void => reject(reader.error);
			reader.readAsArrayBuffer(this as Blob);
		});
	};
}

describe('RecordingFileManager', () => {
	let mockApp: App;
	let mockSettings: AudioRecorderSettings;
	let consoleDebugSpy: jest.SpyInstance;
	let consoleWarnSpy: jest.SpyInstance;
	let consoleErrorSpy: jest.SpyInstance;

	beforeEach(() => {
		jest.clearAllMocks();

		consoleDebugSpy = jest.spyOn(console, 'debug').mockImplementation();
		consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation();
		consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();

		// Create mock App with all required vault and workspace methods
		mockApp = {
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
		} as unknown as App;

		// Use default settings with a defined saveFolder
		mockSettings = {
			...DEFAULT_SETTINGS,
			saveFolder: 'Recordings',
		};
	});

	afterEach(() => {
		consoleDebugSpy.mockRestore();
		consoleWarnSpy.mockRestore();
		consoleErrorSpy.mockRestore();
	});

	// -----------------------------------------------------------------------
	// getActiveFileDirectory
	// -----------------------------------------------------------------------
	describe('getActiveFileDirectory', () => {
		it('should return the directory of the active .md file', () => {
			(mockApp.workspace.getActiveFile as jest.Mock).mockReturnValue({
				path: 'Notes/Daily/2024-01-01.md',
			});

			const result = getActiveFileDirectory(mockApp);

			expect(result).toBe('Notes/Daily');
		});

		it('should handle .MD extension (case-insensitive)', () => {
			(mockApp.workspace.getActiveFile as jest.Mock).mockReturnValue({
				path: 'Notes/README.MD',
			});

			const result = getActiveFileDirectory(mockApp);

			expect(result).toBe('Notes');
		});

		it('should return empty string for a non-.md active file', () => {
			(mockApp.workspace.getActiveFile as jest.Mock).mockReturnValue({
				path: 'Assets/image.png',
			});

			const result = getActiveFileDirectory(mockApp);

			expect(result).toBe('');
		});

		it('should return empty string when no file is active', () => {
			(mockApp.workspace.getActiveFile as jest.Mock).mockReturnValue(
				null,
			);

			const result = getActiveFileDirectory(mockApp);

			expect(result).toBe('');
		});

		it('should return empty string for a root-level .md file', () => {
			(mockApp.workspace.getActiveFile as jest.Mock).mockReturnValue({
				path: 'note.md',
			});

			const result = getActiveFileDirectory(mockApp);

			expect(result).toBe('');
		});

		it('should return deeply nested directory path', () => {
			(mockApp.workspace.getActiveFile as jest.Mock).mockReturnValue({
				path: 'a/b/c/d/note.md',
			});

			const result = getActiveFileDirectory(mockApp);

			expect(result).toBe('a/b/c/d');
		});
	});

	// -----------------------------------------------------------------------
	// getBaseSaveDirectory
	// -----------------------------------------------------------------------
	describe('getBaseSaveDirectory', () => {
		it('should return saveFolder when saveNearActiveFile is false', () => {
			mockSettings.saveNearActiveFile = false;
			mockSettings.saveFolder = 'MyRecordings';

			const result = getBaseSaveDirectory(mockSettings, mockApp);

			expect(result).toBe('MyRecordings');
		});

		it('should return active file directory when saveNearActiveFile is true and subfolder is empty', () => {
			mockSettings.saveNearActiveFile = true;
			mockSettings.activeFileSubfolder = '';
			(mockApp.workspace.getActiveFile as jest.Mock).mockReturnValue({
				path: 'Notes/Daily/today.md',
			});

			const result = getBaseSaveDirectory(mockSettings, mockApp);

			expect(result).toBe('Notes/Daily');
		});

		it('should return active file directory + subfolder when saveNearActiveFile is true and subfolder set', () => {
			mockSettings.saveNearActiveFile = true;
			mockSettings.activeFileSubfolder = 'audio';
			(mockApp.workspace.getActiveFile as jest.Mock).mockReturnValue({
				path: 'Notes/Daily/today.md',
			});

			const result = getBaseSaveDirectory(mockSettings, mockApp);

			expect(result).toBe('Notes/Daily/audio');
		});

		it('should handle whitespace-only subfolder as empty', () => {
			mockSettings.saveNearActiveFile = true;
			mockSettings.activeFileSubfolder = '   ';
			(mockApp.workspace.getActiveFile as jest.Mock).mockReturnValue({
				path: 'Notes/today.md',
			});

			const result = getBaseSaveDirectory(mockSettings, mockApp);

			expect(result).toBe('Notes');
		});

		it('should return subfolder relative to root when no active .md file', () => {
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
		it('should not create folder if it already exists', async () => {
			(mockApp.vault.adapter.exists as jest.Mock).mockResolvedValue(true);

			await ensureFolderExists('Recordings', mockApp);

			expect(mockApp.vault.adapter.exists).toHaveBeenCalledWith(
				'Recordings',
			);
			expect(mockApp.vault.createFolder).not.toHaveBeenCalled();
		});

		it('should create folder if it does not exist', async () => {
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

		it('should skip creation for empty path', async () => {
			await ensureFolderExists('', mockApp);

			expect(mockApp.vault.adapter.exists).not.toHaveBeenCalled();
			expect(mockApp.vault.createFolder).not.toHaveBeenCalled();
		});

		it('should skip creation for whitespace-only path', async () => {
			await ensureFolderExists('   ', mockApp);

			expect(mockApp.vault.adapter.exists).not.toHaveBeenCalled();
			expect(mockApp.vault.createFolder).not.toHaveBeenCalled();
		});

		it('should normalize backslashes in path', async () => {
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
	// resolveUniquePath
	// -----------------------------------------------------------------------
	describe('resolveUniquePath', () => {
		it('should return the path directly when no collision', async () => {
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

		it('should append counter when file already exists', async () => {
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

		it('should increment counter multiple times until unique path found', async () => {
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

		it('should sanitize special characters in filename', async () => {
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

		it('should ensure folder is created before resolving path', async () => {
			mockSettings.saveFolder = 'NewFolder';
			(mockApp.vault.adapter.exists as jest.Mock).mockResolvedValue(
				false,
			);

			await resolveUniquePath('file.mp3', mockApp, mockSettings);

			expect(mockApp.vault.createFolder).toHaveBeenCalledWith(
				'NewFolder',
			);
		});

		it('should handle filename with multiple dots', async () => {
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

		it('should sanitize all invalid characters from filename', async () => {
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
		it('should save a non-empty blob and return the file path', async () => {
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

		it('should return null for an empty blob', async () => {
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

		it('should use resolveUniquePath to determine the final path', async () => {
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

		it('should convert blob to ArrayBuffer before saving', async () => {
			mockSettings.saveFolder = '';
			(mockApp.vault.adapter.exists as jest.Mock).mockResolvedValue(
				false,
			);
			const blob = new Blob(['hello world'], { type: 'audio/wav' });

			await saveAudioFile(blob, 'test.wav', mockApp, mockSettings);

			const createBinaryCall = (mockApp.vault.createBinary as jest.Mock)
				.mock.calls[0];
			expect(createBinaryCall[1]).toBeInstanceOf(ArrayBuffer);
		});
	});

	// -----------------------------------------------------------------------
	// removeTemporaryArtifacts
	// -----------------------------------------------------------------------
	describe('removeTemporaryArtifacts', () => {
		it('should remove all paths successfully and return empty array', async () => {
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

		it('should return failed paths when some removals fail', async () => {
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

		it('should return all paths when all removals fail', async () => {
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

		it('should return empty array for empty input', async () => {
			const result = await removeTemporaryArtifacts(
				[],
				'no paths',
				mockApp,
			);

			expect(result).toEqual([]);
			expect(mockApp.vault.adapter.remove).not.toHaveBeenCalled();
		});

		it('should include log prefix in warning messages', async () => {
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
	// rollbackFinalFile
	// -----------------------------------------------------------------------
	describe('rollbackFinalFile', () => {
		it('should remove the file successfully', async () => {
			(mockApp.vault.adapter.remove as jest.Mock).mockResolvedValue(
				undefined,
			);

			await rollbackFinalFile(
				'Recordings/final.webm',
				'rollback context',
				mockApp,
			);

			expect(mockApp.vault.adapter.remove).toHaveBeenCalledWith(
				'Recordings/final.webm',
			);
			expect(consoleErrorSpy).not.toHaveBeenCalled();
		});

		it('should log error when removal fails', async () => {
			(mockApp.vault.adapter.remove as jest.Mock).mockRejectedValue(
				new Error('Cannot delete'),
			);

			await rollbackFinalFile(
				'Recordings/final.webm',
				'rollback failed',
				mockApp,
			);

			expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
			expect(consoleErrorSpy).toHaveBeenCalledWith(
				expect.stringContaining('rollback failed'),
				expect.objectContaining({
					filePath: 'Recordings/final.webm',
					error: expect.any(Error),
				}),
			);
		});

		it('should include log prefix in error message', async () => {
			(mockApp.vault.adapter.remove as jest.Mock).mockRejectedValue(
				new Error('fail'),
			);

			await rollbackFinalFile('file.webm', 'context', mockApp);

			expect(consoleErrorSpy).toHaveBeenCalledWith(
				expect.stringContaining('[AudioRecorder]'),
				expect.anything(),
			);
		});

		it('should not throw even when removal fails', async () => {
			(mockApp.vault.adapter.remove as jest.Mock).mockRejectedValue(
				new Error('Catastrophic failure'),
			);

			await expect(
				rollbackFinalFile('file.webm', 'context', mockApp),
			).resolves.toBeUndefined();
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
			};
		}

		it('should collect segment paths from all targets and remove them', async () => {
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

		it('should return failed paths from multiple targets', async () => {
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

		it('should handle empty targets array', async () => {
			const result = await cleanupIntermediateFiles([], mockApp);

			expect(result).toEqual([]);
			expect(mockApp.vault.adapter.remove).not.toHaveBeenCalled();
		});

		it('should handle targets with empty segmentPaths', async () => {
			const targets = [createMockTarget([]), createMockTarget([])];

			const result = await cleanupIntermediateFiles(targets, mockApp);

			expect(result).toEqual([]);
			expect(mockApp.vault.adapter.remove).not.toHaveBeenCalled();
		});

		it('should use correct log context for failed removals', async () => {
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
