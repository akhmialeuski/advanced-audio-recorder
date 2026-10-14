/**
 * One cleanup of a recording from start to finish: the processed copy is
 * written, linked into the note in place of (or next to) the source, and the
 * source is trashed when that was asked for. The dialog and the command line
 * both run exactly this, so the order that keeps a note's link valid - link
 * first, while the source still resolves, then trash - is decided once.
 * @module cleanup/cleanupRun
 */

import type { App, TFile } from 'obsidian';
import { PLUGIN_LOG_PREFIX } from '../constants';
import { AudioProcessingService } from './AudioProcessingService';
import type { AudioDspConfig } from './audioDsp';

/** What the caller does once the processed copy exists. */
export type ProcessedHandler = (result: {
	/** Vault path of the processed copy. */
	outputPath: string;
	/** Whether the source is about to be trashed, so its links can be replaced. */
	replaceSource: boolean;
}) => void | Promise<void>;

/** Options of one cleanup run. */
export interface CleanupRunOptions {
	/** Whether the source is trashed after the processed copy is linked. */
	readonly deleteSource: boolean;
	/**
	 * Called after the copy is written and before the source is trashed. A
	 * failure here is logged and does not fail the run: the copy exists.
	 */
	readonly onProcessed?: ProcessedHandler | undefined;
}

/** What a cleanup run left behind. */
export interface CleanupRunResult {
	/** Vault path of the processed copy. */
	readonly outputPath: string;
	/** Whether the source was to be trashed and trashing it failed. */
	readonly sourceKept: boolean;
}

/**
 * Cleans up a recording.
 * @param app - Obsidian App
 * @param file - The recording
 * @param config - The stages to apply
 * @param options - What happens around the processing
 * @returns Where the copy went and whether a requested delete failed
 * @throws When the processing itself fails; nothing was written then
 */
export async function cleanUpRecording(
	app: App,
	file: TFile,
	config: AudioDspConfig,
	options: CleanupRunOptions,
): Promise<CleanupRunResult> {
	const outputPath = await new AudioProcessingService(app).process(
		file,
		config,
	);
	if (options.onProcessed) {
		// Linked before the source is trashed, so the source embed still
		// resolves when it is matched and replaced.
		try {
			await options.onProcessed({
				outputPath,
				replaceSource: options.deleteSource,
			});
		} catch (linkError) {
			console.warn(
				`${PLUGIN_LOG_PREFIX} Failed to link the processed file into the note:`,
				linkError,
			);
		}
	}
	if (!options.deleteSource) {
		return { outputPath, sourceKept: false };
	}
	try {
		await app.fileManager.trashFile(file);
		return { outputPath, sourceKept: false };
	} catch (deleteError) {
		console.warn(
			`${PLUGIN_LOG_PREFIX} Failed to delete source after processing:`,
			deleteError,
		);
		return { outputPath, sourceKept: true };
	}
}

/**
 * The sentence a finished run is reported with.
 * @param result - What the run left behind
 */
export function describeCleanup(result: CleanupRunResult): string {
	return result.sourceKept
		? `Processed audio saved to ${result.outputPath}, but the source could not be deleted.`
		: `Processed audio saved to ${result.outputPath}`;
}
