/**
 * The transcript a recording's last run wrote, read back from its own JSON
 * output, and the rewrite of every transcript file that run recorded.
 *
 * The JSON output is a serialized transcript and therefore the one lossless
 * source: subtitles and plain text drop the segment ends, the words and (in
 * part) the speakers, so a transcript changed after the fact - topped up with
 * the parts that failed, or a line split between two speakers - is read from
 * the JSON and written back over every recorded file in that file's own
 * format. Translations are left out: a translation is a second document in
 * another language, and nothing done to the original's segments applies to it.
 * @module transcription/recordedTranscript
 */

import { TFile } from 'obsidian';
import type { App } from 'obsidian';
import { PLUGIN_LOG_PREFIX } from '../constants';
import type { FileOutput } from '../sidecar/recordingSidecarModel';
import { serializeTranscriptFile } from './transcriptFormat';
import { TranscriptFileFormat, type Transcript } from './TranscriptTypes';

/** A transcript read back from its recorded JSON output. */
export interface RecordedTranscript {
	/** The transcript as the JSON output holds it. */
	transcript: Transcript;
	/** Every file output of the recording's own transcript (no translations). */
	outputs: FileOutput[];
}

/**
 * The recording's own transcript files among the recorded outputs: every
 * output that is not a translation.
 * @param fileOutputs - The file outputs the sidecar recorded
 */
export function originalTranscriptOutputs(
	fileOutputs: readonly FileOutput[],
): FileOutput[] {
	return fileOutputs.filter((output) => !output.language);
}

/**
 * Reads the transcript back from the recorded JSON output.
 * @param app - Obsidian App
 * @param fileOutputs - The file outputs the sidecar recorded
 * @returns The transcript and the recording's own file outputs, or null when
 *   no readable JSON output was recorded
 */
export async function readRecordedTranscript(
	app: App,
	fileOutputs: readonly FileOutput[],
): Promise<RecordedTranscript | null> {
	const outputs = originalTranscriptOutputs(fileOutputs);
	const json = outputs.find(
		(output) => output.format === TranscriptFileFormat.Json,
	);
	if (!json) {
		return null;
	}
	const file = app.vault.getAbstractFileByPath(json.path);
	if (!(file instanceof TFile)) {
		return null;
	}
	try {
		const parsed: unknown = JSON.parse(await app.vault.read(file));
		return isTranscript(parsed) ? { transcript: parsed, outputs } : null;
	} catch (error) {
		console.warn(
			`${PLUGIN_LOG_PREFIX} Failed to read the transcript at ${json.path}:`,
			error,
		);
		return null;
	}
}

/**
 * Writes a transcript over every recorded file, each in the format it was
 * written in. Rewritten rather than added to, so a change leaves the same
 * outputs it found instead of a second set beside them. A file that has since
 * been removed or cannot be written is counted out and warned about, never
 * thrown.
 * @param app - Obsidian App
 * @param transcript - The transcript to write
 * @param outputs - The files to write it over
 * @returns How many were rewritten
 */
export async function rewriteRecordedTranscriptFiles(
	app: App,
	transcript: Transcript,
	outputs: readonly FileOutput[],
): Promise<number> {
	let rewritten = 0;
	for (const output of outputs) {
		const file = app.vault.getAbstractFileByPath(output.path);
		if (!(file instanceof TFile)) {
			continue;
		}
		try {
			await app.vault.modify(
				file,
				serializeTranscriptFile(transcript, output.format),
			);
			rewritten++;
		} catch (error) {
			console.warn(
				`${PLUGIN_LOG_PREFIX} Failed to rewrite ${output.path}:`,
				error,
			);
		}
	}
	return rewritten;
}

/**
 * Whether a parsed value is a transcript that can be worked on.
 * @param value - Parsed JSON from a recorded output
 * @returns True when it carries a segment list
 */
function isTranscript(value: unknown): value is Transcript {
	if (typeof value !== 'object' || value === null) {
		return false;
	}
	return Array.isArray((value as { segments?: unknown }).segments);
}
