/**
 * High-level entry point that runs the transcription pipeline and writes
 * its outputs (sidecar file and/or in-note Markdown) according to
 * settings. Shared by the command, the context menu, and the
 * transcribe-on-save hook.
 * @module transcription/runTranscription
 */

import type { App, TFile } from 'obsidian';
import { PLUGIN_LOG_PREFIX } from '../constants';
import { TranscriptDestination } from './TranscriptTypes';
import type { AudioRecorderSettings } from '../settings/settingsSchema';
import type {
	FileOutput,
	NoteOutput,
	NoteOutputTemplates,
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
import type { PartFailure } from './partFailure';
import { writeTemplateNote } from './templateNoteOutput';

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
	/**
	 * Records what this run could not transcribe, so exactly those parts can
	 * be asked for again. An empty list clears the previous record.
	 */
	setFailedParts(path: string, parts: readonly PartFailure[]): Promise<void>;
}

/**
 * How the note's transcript was written, for a later rename to find its
 * lines: the settings, with the timestamps a note template chose instead.
 * @param settings - The run's settings
 * @param result - What the run produced
 */
function noteOutputTemplates(
	settings: AudioRecorderSettings,
	result: TranscribeRunResult,
): NoteOutputTemplates {
	return {
		lineFormat: settings.transcriptLineFormat,
		speakerFormat: settings.transcriptSpeakerFormat,
		timestampFormat: settings.transcriptTimestampFormat,
		includeTimestamps:
			result.noteTimestamps ?? settings.transcriptIncludeTimestamps,
		timestampLinks: settings.transcriptTimestampLinks,
		mergeConsecutiveSpeaker: settings.transcriptMergeConsecutiveSpeaker,
	};
}

/**
 * Writes the run's Markdown into a note: the recording's, or where the note
 * template that wrote it sends it, with its properties.
 * @param app - Obsidian App
 * @param settings - The run's settings
 * @param file - The recording
 * @param notePath - The recording's note; '' when there is none
 * @param result - What the run produced
 * @returns The path of the note written, null when none could be
 */
async function writeNote(
	app: App,
	settings: AudioRecorderSettings,
	file: TFile,
	notePath: string,
	result: TranscribeRunResult,
): Promise<string | null> {
	const markdown = result.translation
		? `${result.markdown}\n\n### ${result.translation.language}\n\n${result.translation.markdown}`
		: result.markdown;
	const template = result.noteTemplate;
	if (template) {
		return writeTemplateNote(app, {
			recording: file,
			notePath,
			markdown,
			heading: settings.transcriptHeading,
			templateName: template.name,
			properties: template.properties,
			output: settings.llmTemplateOutput,
		});
	}
	const inserted = await insertTranscriptIntoNote(
		app,
		notePath,
		markdown,
		settings.transcriptHeading,
		file,
	);
	return inserted ? notePath : null;
}

/**
 * Where the run's transcript came from, as the sidecar keeps it.
 * @param result - What the run produced
 * @param writtenAt - When its outputs were written, for a transcript that
 *   does not say when it was made
 */
function provenanceOf(
	result: TranscribeRunResult,
	writtenAt: string,
): TranscriptProvenance {
	const { language, model, createdAt } = result.transcript;
	return {
		...(language ? { language } : {}),
		...(model ? { model } : {}),
		createdAt: createdAt ?? writtenAt,
	};
}

/**
 * Records what the run could not transcribe. Written whatever the run
 * produced, and before the output records: an absent record has to mean
 * "nothing is missing", so a run that came back whole must clear what an
 * earlier one left behind. Best-effort, as every sidecar write of a run is.
 * @param sidecar - The recording's sidecar
 * @param file - The recording
 * @param result - What the run produced
 */
async function recordFailedParts(
	sidecar: TranscriptOutputSidecar,
	file: TFile,
	result: TranscribeRunResult,
): Promise<void> {
	try {
		await sidecar.setFailedParts(file.path, result.missingParts);
	} catch (error) {
		console.warn(
			`${PLUGIN_LOG_PREFIX} Failed to record the missing parts of ${file.path}:`,
			error,
		);
	}
}

/** Options for a full transcribe-and-write run. */
export interface TranscribeFileOptions {
	/** Source note path used to generate relative timecode links. */
	notePathForLinks: string;
	/** Progress callback. */
	onProgress?: ((fraction: number, label: string) => void) | undefined;
	/** Running-cost callback (cumulative, after each completed part). */
	onCost?: (cost: TranscribeRunCost) => void;
	/**
	 * Pre-read audio bytes, passed through to the service so a caller that
	 * already holds the file's bytes avoids a second full-file read.
	 */
	audioBytes?: ArrayBuffer | undefined;
	/** Cancellation token. */
	token?: CancellationToken | undefined;
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
		destination === TranscriptDestination.File ||
		destination === TranscriptDestination.Both ||
		destination === TranscriptDestination.Link;
	const wantsNote =
		destination === TranscriptDestination.Note ||
		destination === TranscriptDestination.Both;
	const wantsLink = destination === TranscriptDestination.Link;

	let transcriptFile: TFile | null = null;
	if (wantsFile) {
		transcriptFile = await writeTranscriptFile(
			app,
			file,
			result.transcript,
			settings.transcriptFileFormat,
		);
	}
	// A translation is a second document with the same timings, so it takes
	// the same route as the original and is named by its language rather than
	// colliding with it. Written whenever a file is wanted, so the subtitle
	// formats come out translated with no further work.
	let translationFile: TFile | null = null;
	if (wantsFile && result.translation) {
		translationFile = await writeTranscriptFile(
			app,
			file,
			result.translation.transcript,
			settings.transcriptFileFormat,
			result.translation.language,
		);
	}
	// The note the transcript went into: the recording's, or the one a
	// template wrote apart.
	const notePath = wantsNote
		? await writeNote(app, settings, file, options.notePathForLinks, result)
		: null;
	const inserted = notePath !== null;
	let linkInserted = false;
	if (wantsLink && transcriptFile) {
		linkInserted = await insertTranscriptFileLink(
			app,
			options.notePathForLinks,
			transcriptFile,
			settings.transcriptHeading,
			file,
		);
	}
	// Safety net: a completed (and, on a paid API, already-billed) transcript
	// must never be silently dropped. If in-note output was the only requested
	// destination but the insert failed (the note is gone or refused the write), write a
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
	if (options.sidecar) {
		await recordFailedParts(options.sidecar, file, result);
	}
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
			if (translationFile && result.translation) {
				await options.sidecar.recordFileOutput(file.path, {
					path: translationFile.path,
					format: settings.transcriptFileFormat,
					writtenAt,
					language: result.translation.language,
				});
			}
			if (inserted) {
				await options.sidecar.recordNoteOutput(file.path, {
					path: notePath ?? options.notePathForLinks,
					templates: noteOutputTemplates(settings, result),
					heading: settings.transcriptHeading,
					writtenAt,
				});
			}
			await options.sidecar.recordProvenance(
				file.path,
				provenanceOf(result, writtenAt),
			);
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
