/**
 * High-level entry point that runs the transcription pipeline and writes
 * its outputs (sidecar file and/or in-note Markdown) according to
 * settings. Shared by the command, the context menu, and the
 * transcribe-on-save hook.
 * @module transcription/runTranscription
 */

import type { App, TFile } from 'obsidian';
import { PLUGIN_LOG_PREFIX } from '../constants';
import type { AudioRecorderSettings } from '../settings/settingsSchema';
import type {
	FileOutput,
	NoteOutput,
	TranscriptProvenance,
} from '../sidecar/recordingSidecarModel';
import {
	TranscriptionService,
	type CancellationToken,
	type TranscribeRunCost,
	type TranscribeRunResult,
	type TranscriptionServiceDeps,
	type TranscriptionSidecarAccess,
} from './TranscriptionService';
import {
	insertTranscriptFileLink,
	insertTranscriptIntoNote,
	notifyTranscriptWritten,
	writeTranscriptFile,
} from './transcriptOutput';

/**
 * The sidecar surface a transcribe-and-write run needs: the service's name
 * continuity plus registration of the outputs this run actually wrote (with
 * the exact paths and the render templates in effect). Implemented by
 * `RecordingSidecarStore`; structural so tests can stub it.
 */
export interface TranscriptOutputSidecar extends TranscriptionSidecarAccess {
	/** Records (or refreshes) a note this run inserted the transcript into. */
	recordNoteOutput(path: string, output: NoteOutput): Promise<void>;
	/** Records (or refreshes) a transcript file this run wrote. */
	recordFileOutput(path: string, output: FileOutput): Promise<void>;
	/** Records the provenance (language/engine/timestamp) of this run. */
	recordProvenance(
		path: string,
		provenance: TranscriptProvenance,
	): Promise<void>;
}

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
	audioBytes?: ArrayBuffer | undefined;
	/** Cancellation token. */
	token?: CancellationToken;
	/**
	 * Recording sidecar store: lets the run re-apply stored speaker names and
	 * register the outputs it wrote. Without it, speaker names are neither
	 * re-applied nor renamable later, and no output record is kept.
	 */
	sidecar?: TranscriptOutputSidecar | undefined;
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
		// One injection channel: the same store serves speaker-name
		// continuity inside the run and output registration below.
		sidecar: options.sidecar,
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
	// Register what this run actually wrote in the recording's sidecar - the
	// exact file path (collision suffix included) and, for the note, the
	// render templates and heading of this run's settings snapshot - so a
	// later rename rewrites by recorded fact instead of guessing from current
	// settings, and any consumer can tell where the transcript lives. Every
	// run registers, diarized or not: absence of records must always mean "no
	// transcript", never "a transcript this feature ignored". Best-effort: a
	// sidecar failure never fails a completed (and possibly billed) run.
	if (options.sidecar && (transcriptFile || inserted)) {
		try {
			const writtenAt = new Date().toISOString();
			if (transcriptFile) {
				await options.sidecar.recordFileOutput(file.path, {
					path: transcriptFile.path,
					format: settings.transcriptFileFormat,
					writtenAt,
				});
			}
			if (inserted) {
				await options.sidecar.recordNoteOutput(file.path, {
					path: options.notePathForLinks,
					templates: {
						lineFormat: settings.transcriptLineFormat,
						speakerFormat: settings.transcriptSpeakerFormat,
						includeTimestamps: settings.transcriptIncludeTimestamps,
						timestampLinks: settings.transcriptTimestampLinks,
						mergeConsecutiveSpeaker:
							settings.transcriptMergeConsecutiveSpeaker,
					},
					// Cleanup/custom rewrite the transcript body, so a later
					// line-scoped read or rename may no longer match it; a
					// summary is prepended above the intact body and does not
					// count. Recorded as a hint only - consumers still try the
					// note and judge by what actually matched.
					llmProcessed:
						settings.llmPostProcessEnabled &&
						(settings.llmPostProcessTask === 'cleanup' ||
							settings.llmPostProcessTask === 'custom'),
					heading: settings.transcriptHeading,
					writtenAt,
				});
			}
			const provenance: TranscriptProvenance = {
				...(result.transcript.language
					? { language: result.transcript.language }
					: {}),
				...(result.transcript.model
					? { model: result.transcript.model }
					: {}),
				createdAt: result.transcript.createdAt ?? writtenAt,
			};
			await options.sidecar.recordProvenance(file.path, provenance);
		} catch (error) {
			console.warn(
				`${PLUGIN_LOG_PREFIX} Failed to record transcript outputs for ${file.path}:`,
				error,
			);
		}
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
