/**
 * High-level entry point that runs the transcription pipeline and writes
 * its outputs (sidecar file and/or in-note Markdown) according to
 * settings. Shared by the command, the context menu, and the
 * transcribe-on-save hook.
 * @module transcription/runTranscription
 */

import type { App, TFile } from 'obsidian';
import type { AudioRecorderSettings } from '../settings/settingsSchema';
import {
	TranscriptionService,
	type CancellationToken,
	type TranscribeRunCost,
	type TranscribeRunResult,
	type TranscriptionServiceDeps,
} from './TranscriptionService';
import {
	insertTranscriptFileLink,
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
	/** Running-cost callback (cumulative, after each completed part). */
	onCost?: (cost: TranscribeRunCost) => void;
	/**
	 * Pre-read audio bytes, passed through to the service so a caller that
	 * already holds the file's bytes avoids a second full-file read.
	 */
	audioBytes?: ArrayBuffer;
	/** Cancellation token. */
	token?: CancellationToken;
}

/**
 * Transcribes a file and writes the configured outputs.
 * @param app - Obsidian App
 * @param getSettings - Returns current plugin settings
 * @param file - Audio file to transcribe
 * @param options - Run options
 * @param deps - Optional provider factories (injected in tests)
 * @returns The transcription result
 */
export async function transcribeFile(
	app: App,
	getSettings: () => AudioRecorderSettings,
	file: TFile,
	options: TranscribeFileOptions,
	deps: TranscriptionServiceDeps = {},
): Promise<TranscribeRunResult> {
	const settings = getSettings();
	const service = new TranscriptionService(app, getSettings, deps);
	const result = await service.run(file, {
		notePathForLinks: options.notePathForLinks,
		onProgress: options.onProgress,
		onCost: options.onCost,
		audioBytes: options.audioBytes,
		token: options.token,
	});

	const destination = settings.transcriptDestination;
	const wantsFile =
		destination === 'file' ||
		destination === 'both' ||
		destination === 'link';
	const wantsNote = destination === 'note' || destination === 'both';
	const wantsLink = destination === 'link';

	let transcriptFile: TFile | null = null;
	if (wantsFile) {
		transcriptFile = await writeTranscriptFile(
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
	let linkInserted = false;
	if (wantsLink && transcriptFile) {
		linkInserted = insertTranscriptFileLink(
			app,
			options.notePathForLinks,
			transcriptFile,
			settings.transcriptHeading,
		);
	}
	// Safety net: a completed (and, on a paid API, already-billed) transcript
	// must never be silently dropped. If in-note output was the only requested
	// destination but the insert failed (note not open, reading mode), write a
	// sidecar file instead of reporting a hollow success.
	let savedAsFallback = false;
	if (wantsNote && !inserted && transcriptFile === null) {
		transcriptFile = await writeTranscriptFile(
			app,
			file,
			result.transcript,
			settings.transcriptFileFormat,
		);
		savedAsFallback = true;
	}
	notifyTranscriptWritten({
		inserted,
		filePath: transcriptFile?.path ?? null,
		noteRequested: wantsNote,
		savedAsFallback,
		linkRequested: wantsLink,
		linkInserted,
	});
	return result;
}
