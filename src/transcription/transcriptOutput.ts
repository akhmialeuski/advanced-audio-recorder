/**
 * Writes transcript outputs: a sidecar transcript file next to the audio
 * (JSON/SRT/VTT/TXT) and/or the rendered Markdown inserted into a note.
 * @module transcription/transcriptOutput
 */

import { MarkdownView, Notice } from 'obsidian';
import type { App, TFile } from 'obsidian';
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
 * Inserts the transcript Markdown into the active Markdown note at the
 * cursor, optionally under a heading. Returns true when inserted, false
 * when there is no active note to insert into.
 * @param app - Obsidian App
 * @param markdown - Rendered transcript Markdown
 * @param heading - Optional heading line (empty for none)
 */
export function insertTranscriptIntoActiveNote(
	app: App,
	markdown: string,
	heading: string,
): boolean {
	const view = app.workspace.getActiveViewOfType(MarkdownView);
	if (!view) {
		return false;
	}
	const block = heading ? `${heading}\n\n${markdown}` : markdown;
	const editor = view.editor;
	const cursor = editor.getCursor();
	editor.replaceRange(`\n\n${block}\n`, cursor);
	return true;
}

/**
 * Notifies the user about where the transcript was written.
 * @param notePath - Note path, when inserted into a note
 * @param filePath - Sidecar file path, when written
 */
export function notifyTranscriptWritten(
	insertedIntoNote: boolean,
	filePath: string | null,
): void {
	const parts: string[] = [];
	if (insertedIntoNote) {
		parts.push('inserted into the note');
	}
	if (filePath) {
		parts.push(`saved to ${filePath}`);
	}
	new Notice(
		parts.length > 0
			? `Transcript ${parts.join(' and ')}.`
			: 'Transcript ready.',
	);
}
