/**
 * Writes transcript outputs: a sidecar transcript file next to the audio
 * (JSON/SRT/VTT/TXT) and/or the rendered Markdown inserted into a note.
 * @module transcription/transcriptOutput
 */

import { MarkdownView, Notice } from 'obsidian';
import type { App, TFile } from 'obsidian';
import { PLUGIN_LOG_PREFIX } from '../constants';
import { resolveUniquePathInDirectory } from '../recording/RecordingFileManager';
import { serializeTranscriptFile } from './transcriptFormat';
import type { Transcript, TranscriptFileFormat } from './TranscriptTypes';

/**
 * Builds the transcript sidecar file name for an audio path and format.
 * JSON uses a `.transcript.json` suffix to avoid being mistaken for other
 * JSON; subtitle/text formats use their conventional extension.
 * @param audioPath - Vault path of the audio file
 * @param format - Transcript file format
 * @returns Sidecar file path (same directory as the audio)
 */
export function buildTranscriptFilePath(
	audioPath: string,
	format: TranscriptFileFormat,
): string {
	const dotIndex = audioPath.lastIndexOf('.');
	const base = dotIndex > 0 ? audioPath.slice(0, dotIndex) : audioPath;
	const suffix = format === 'json' ? 'transcript.json' : format;
	return `${base}.${suffix}`;
}

/**
 * Returns the directory portion of a vault path ('' for a root file).
 * @param path - Vault path
 */
function directoryOf(path: string): string {
	const slash = path.lastIndexOf('/');
	return slash >= 0 ? path.slice(0, slash) : '';
}

/**
 * Writes the transcript to a sidecar file next to the audio, avoiding
 * collisions with an existing file.
 * @param app - Obsidian App
 * @param audioFile - Source audio file
 * @param transcript - Transcript to serialize
 * @param format - File format
 * @returns The created file's vault path
 */
export async function writeTranscriptFile(
	app: App,
	audioFile: TFile,
	transcript: Transcript,
	format: TranscriptFileFormat,
): Promise<string> {
	const desired = buildTranscriptFilePath(audioFile.path, format);
	const directory = directoryOf(desired);
	const fileName = desired.slice(
		directory.length === 0 ? 0 : directory.length + 1,
	);
	const target = await resolveUniquePathInDirectory(directory, fileName, app);
	await app.vault.create(target, serializeTranscriptFile(transcript, format));
	return target;
}

/**
 * Inserts the transcript Markdown at the cursor of the note the timecode
 * links were generated against, optionally under a heading. Targets that
 * specific note — not whatever happens to be active when transcription
 * finishes — so a long async run that ends after the user switched notes
 * never writes the transcript (with links relative to the source note)
 * into an unrelated file. Returns true when inserted, false when that note
 * is not open in an editable view (the caller falls back to the file/notice).
 * @param app - Obsidian App
 * @param notePath - Vault path of the target note (the link source)
 * @param markdown - Rendered transcript Markdown
 * @param heading - Optional heading line (empty for none)
 */
export function insertTranscriptIntoNote(
	app: App,
	notePath: string,
	markdown: string,
	heading: string,
): boolean {
	if (!notePath) {
		return false;
	}
	const view = app.workspace
		.getLeavesOfType('markdown')
		.map((leaf) => leaf.view)
		.find(
			(candidate): candidate is MarkdownView =>
				candidate instanceof MarkdownView &&
				candidate.file?.path === notePath,
		);
	if (!view) {
		return false;
	}
	const block = heading ? `${heading}\n\n${markdown}` : markdown;
	try {
		const editor = view.editor;
		const cursor = editor.getCursor();
		editor.replaceRange(`\n\n${block}\n`, cursor);
		return true;
	} catch (error) {
		// The note may be in reading mode or otherwise not editable; report
		// not-inserted so the caller can fall back to the file/notice.
		console.warn(
			`${PLUGIN_LOG_PREFIX} Could not insert transcript into the note:`,
			error,
		);
		return false;
	}
}

/** Outcome of writing a transcript, used to build an honest user notice. */
export interface TranscriptWriteOutcome {
	/** Whether the Markdown was inserted into the target note. */
	inserted: boolean;
	/** Sidecar file path when one was written, otherwise null. */
	filePath: string | null;
	/** Whether the user asked for in-note output. */
	noteRequested: boolean;
	/** Whether the file was written only as a fallback after a failed insert. */
	savedAsFallback: boolean;
}

/**
 * Builds the user-facing notice for a transcript write outcome. Pure (no
 * Obsidian dependency) so the wording — especially the "could not insert"
 * cases that must never read as success — is unit tested.
 * @param outcome - What was written and what the user requested
 * @returns The notice text
 */
export function describeTranscriptOutcome(
	outcome: TranscriptWriteOutcome,
): string {
	const { inserted, filePath, noteRequested, savedAsFallback } = outcome;
	if (savedAsFallback && filePath) {
		return (
			`Could not insert the transcript into the note (open it in editing ` +
			`mode to insert there). Saved to ${filePath} instead.`
		);
	}
	const parts: string[] = [];
	if (inserted) {
		parts.push('inserted into the note');
	}
	if (filePath) {
		parts.push(`saved to ${filePath}`);
	}
	if (parts.length > 0) {
		return `Transcript ${parts.join(' and ')}.`;
	}
	if (noteRequested) {
		// Note output was requested but nothing was written and no fallback
		// file exists: be honest rather than claim a hollow success.
		return 'Could not write the transcript. Open the note in editing mode and try again.';
	}
	return 'Transcript ready.';
}

/**
 * Notifies the user about where the transcript was written.
 * @param outcome - What was written and what the user requested
 */
export function notifyTranscriptWritten(outcome: TranscriptWriteOutcome): void {
	new Notice(describeTranscriptOutcome(outcome));
}
