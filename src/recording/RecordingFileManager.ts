/**
 * File I/O operations for the recording pipeline.
 * Handles path resolution, saving, temporary file cleanup, and rollback.
 * @module recording/RecordingFileManager
 */

import { normalizePath } from 'obsidian';
import type { App } from 'obsidian';
import type { AudioRecorderSettings } from '../settings/Settings';
import type { RecordingTarget } from '../types';
import { PLUGIN_LOG_PREFIX } from '../constants';

/**
 * Returns the directory of the currently active Markdown file.
 * @param app - Obsidian App instance
 * @returns Directory path or empty string if no active .md file
 */
export function getActiveFileDirectory(app: App): string {
	const activeFile = app.workspace.getActiveFile();
	if (!activeFile || !activeFile.path.toLowerCase().endsWith('.md')) {
		return '';
	}
	const segments = activeFile.path.split('/');
	segments.pop();
	return segments.join('/');
}

/**
 * Resolves the base save directory based on plugin settings.
 * @param settings - Plugin settings
 * @param app - Obsidian App instance
 * @returns Normalized directory path
 */
export function getBaseSaveDirectory(
	settings: AudioRecorderSettings,
	app: App,
): string {
	if (settings.saveNearActiveFile) {
		const activeDirectory = getActiveFileDirectory(app);
		if (settings.activeFileSubfolder.trim() === '') {
			return activeDirectory;
		}
		return normalizePath(
			`${activeDirectory}/${settings.activeFileSubfolder}`,
		);
	}
	return settings.saveFolder;
}

/**
 * Creates a folder if it does not exist.
 * @param path - Folder path to ensure
 * @param app - Obsidian App instance
 */
export async function ensureFolderExists(
	path: string,
	app: App,
): Promise<void> {
	const normalizedPath = normalizePath(path).trim();
	if (!normalizedPath) {
		return;
	}
	if (await app.vault.adapter.exists(normalizedPath)) {
		return;
	}
	await app.vault.createFolder(normalizedPath);
}

/**
 * Resolves a unique file path inside an explicit directory, appending
 * a counter suffix while the path is taken. The file name is
 * sanitized of path separators and other illegal characters.
 * @param directory - Vault-relative directory (may be empty for root)
 * @param fileName - Desired file name
 * @param app - Obsidian App instance
 * @returns Unique normalized file path
 */
export async function resolveUniquePathInDirectory(
	directory: string,
	fileName: string,
	app: App,
): Promise<string> {
	let sanitizedFileName = fileName.replace(/[\\/:*?"<>|]/g, '-');
	let filePath = normalizePath(`${directory}/${sanitizedFileName}`);

	let counter = 1;
	while (await app.vault.adapter.exists(filePath)) {
		const parts = sanitizedFileName.split('.');
		const ext = parts.pop() ?? '';
		const name = parts.join('.');
		sanitizedFileName = `${name}_${String(counter)}.${ext}`;
		filePath = normalizePath(`${directory}/${sanitizedFileName}`);
		counter++;
	}

	return filePath;
}

/**
 * Resolves a unique file path in the configured save directory,
 * appending a counter suffix if needed.
 * @param fileName - Desired file name
 * @param app - Obsidian App instance
 * @param settings - Plugin settings
 * @returns Unique normalized file path
 */
export async function resolveUniquePath(
	fileName: string,
	app: App,
	settings: AudioRecorderSettings,
): Promise<string> {
	const baseDirectory = getBaseSaveDirectory(settings, app);
	await ensureFolderExists(baseDirectory, app);
	return resolveUniquePathInDirectory(baseDirectory, fileName, app);
}

/**
 * Saves an audio Blob as a binary file in the vault.
 * @param audioBlob - Audio data to save
 * @param fileName - Desired file name
 * @param app - Obsidian App instance
 * @param settings - Plugin settings
 * @returns File path on success, null if blob is empty
 */
export async function saveAudioFile(
	audioBlob: Blob,
	fileName: string,
	app: App,
	settings: AudioRecorderSettings,
): Promise<string | null> {
	if (audioBlob.size === 0) {
		console.debug(`${PLUGIN_LOG_PREFIX} Skipping empty file: ${fileName}`);
		return null;
	}

	const arrayBuffer = await audioBlob.arrayBuffer();
	const filePath = await resolveUniquePath(fileName, app, settings);

	await app.vault.createBinary(filePath, arrayBuffer);
	return filePath;
}

/**
 * Removes temporary files from the vault, collecting any that fail.
 * @param paths - File paths to remove
 * @param logContext - Context message for warning logs on failure
 * @param app - Obsidian App instance
 * @returns Array of paths that could not be removed
 */
export async function removeTemporaryArtifacts(
	paths: string[],
	logContext: string,
	app: App,
): Promise<string[]> {
	const failedPaths: string[] = [];

	await Promise.all(
		paths.map(async (path) => {
			try {
				await app.vault.adapter.remove(path);
			} catch (error) {
				failedPaths.push(path);
				console.warn(`${PLUGIN_LOG_PREFIX} ${logContext}:`, {
					path,
					error,
				});
			}
		}),
	);

	return failedPaths;
}

/**
 * Attempts to remove a finalized file during rollback.
 * @param filePath - Path of the file to remove
 * @param logContext - Context message for error logs
 * @param app - Obsidian App instance
 */
export async function rollbackFinalFile(
	filePath: string,
	logContext: string,
	app: App,
): Promise<void> {
	try {
		await app.vault.adapter.remove(filePath);
	} catch (error) {
		console.error(`${PLUGIN_LOG_PREFIX} ${logContext}:`, {
			filePath,
			error,
		});
	}
}

/**
 * Removes all intermediate segment files across recording targets.
 * @param chunkTargets - Recording targets with segment paths
 * @param app - Obsidian App instance
 * @returns Array of paths that could not be removed
 */
export async function cleanupIntermediateFiles(
	chunkTargets: RecordingTarget[],
	app: App,
): Promise<string[]> {
	const intermediatePaths = chunkTargets.flatMap(
		(target) => target.segmentPaths,
	);

	return removeTemporaryArtifacts(
		intermediatePaths,
		'Failed to remove intermediate recording file',
		app,
	);
}
