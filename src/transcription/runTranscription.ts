/**
 * High-level entry point that runs the transcription pipeline and writes
 * its outputs (sidecar file and/or in-note Markdown) according to
 * settings. Shared by the command, the context menu, and the
 * transcribe-on-save hook.
 * @module transcription/runTranscription
 */

import type { App, TFile } from 'obsidian';
import type { AudioRecorderSettings } from '../settings/Settings';
import {
	TranscriptionService,
	type CancellationToken,
	type TranscribeRunResult,
} from './TranscriptionService';
import {
	insertTranscriptIntoNote,
	notifyTranscriptWritten,
	writeTranscriptFile,
} from './transcriptOutput';

/** Options for a full transcribe-and-write run. */
export interface TranscribeFileOptions {
	/** Source note path used to generate relative timecode links. */
	notePathForLinks: string;
	/** Progress callback. */
	onProgress?: (fraction: number, label: string) => void;
	/** Cancellation token. */
	token?: CancellationToken;
}

/**
 * Transcribes a file and writes the configured outputs.
 * @param app - Obsidian App
 * @param getSettings - Returns current plugin settings
 * @param file - Audio file to transcribe
 * @param options - Run options
 * @returns The transcription result
 */
export async function transcribeFile(
	app: App,
	getSettings: () => AudioRecorderSettings,
	file: TFile,
	options: TranscribeFileOptions,
): Promise<TranscribeRunResult> {
	const settings = getSettings();
	const service = new TranscriptionService(app, getSettings);
	const result = await service.run(file, {
		notePathForLinks: options.notePathForLinks,
		onProgress: options.onProgress,
		token: options.token,
	});

	const wantsFile =
		settings.transcriptDestination === 'file' ||
		settings.transcriptDestination === 'both';
	const wantsNote =
		settings.transcriptDestination === 'note' ||
		settings.transcriptDestination === 'both';

	let filePath: string | null = null;
	if (wantsFile) {
		filePath = await writeTranscriptFile(
			app,
			file,
			result.transcript,
			settings.transcriptFileFormat,
		);
	}
	let inserted = false;
	if (wantsNote) {
		inserted = insertTranscriptIntoNote(
			app,
			options.notePathForLinks,
			result.markdown,
			settings.transcriptHeading,
		);
	}
	// Safety net: a completed (and, on a paid API, already-billed) transcript
	// must never be silently dropped. If in-note output was the only requested
	// destination but the insert failed (note not open, reading mode), write a
	// sidecar file instead of reporting a hollow success.
	let savedAsFallback = false;
	if (wantsNote && !inserted && filePath === null) {
		filePath = await writeTranscriptFile(
			app,
			file,
			result.transcript,
			settings.transcriptFileFormat,
		);
		savedAsFallback = true;
	}
	notifyTranscriptWritten({
		inserted,
		filePath,
		noteRequested: wantsNote,
		savedAsFallback,
	});
	return result;
}
