/**
 * Vault-side application of a speaker rename, driven entirely by the
 * recording's sidecar transcript section: the file outputs are rewritten at
 * their recorded paths and formats, and the note outputs with the render
 * templates each note was actually written with, scoped to the lines whose
 * timecode link resolves to this audio. A transcript without such links
 * cannot be scoped, so a broad rewrite of the whole note is offered only
 * after the caller confirms. Each output is rewritten independently, so one
 * failure is logged and skipped rather than aborting the rest.
 * @module speakers/applySpeakerRenames
 */

import type { App, TFile } from 'obsidian';
import { PLUGIN_LOG_PREFIX } from '../constants';
import { audioTimecodeRefs } from '../obsidian/timecodeRefs';
import type { TranscriptSection } from '../sidecar/recordingSidecarModel';
import type { TranscriptFileFormat } from '../transcription/TranscriptTypes';
import type { SpeakerRename } from './speakerRename';
import {
	renameSpeakersInMarkdown,
	renameSpeakersInNoteLines,
	renameSpeakersInPlainText,
	renameSpeakersInSubtitles,
	renameSpeakersInTranscriptJson,
} from './transcriptRewrite';

/** Counts of what a rename application actually touched. */
export interface SpeakerRenameApplyResult {
	/** Notes whose rendered transcript was updated. */
	updatedNotes: number;
	/** Transcript sidecar files that were updated. */
	updatedTranscriptFiles: number;
	/** Outputs whose rewrite threw and were skipped. */
	failed: number;
	/** Recorded notes skipped because an LLM pass replaced their body. */
	skippedLlmNotes: number;
	/** Recorded outputs whose path no longer resolves to a file. */
	missingOutputs: number;
}

/**
 * Returns the zero-based line indices of a note that belong to a recording,
 * meaning a link or embed on that line resolves to the audio through a
 * timecode subpath.
 * @param app - Obsidian App
 * @param note - Note to inspect
 * @param audioPath - Vault path of the audio file
 */
function audioLineIndices(
	app: App,
	note: TFile,
	audioPath: string,
): Set<number> {
	const lines = new Set<number>();
	for (const ref of audioTimecodeRefs(app, note, audioPath)) {
		for (let line = ref.startLine; line <= ref.endLine; line++) {
			lines.add(line);
		}
	}
	return lines;
}

/** Rewrites one sidecar file's content by format, no-op on a parse mismatch. */
function rewriteSidecar(
	format: TranscriptFileFormat,
	content: string,
	renames: readonly SpeakerRename[],
): string {
	switch (format) {
		case 'json':
			return renameSpeakersInTranscriptJson(content, renames) ?? content;
		case 'srt':
		case 'vtt':
			return renameSpeakersInSubtitles(content, renames);
		case 'txt':
			return renameSpeakersInPlainText(content, renames);
		default: {
			const exhaustive: never = format;
			throw new Error(
				`Unsupported transcript file format: ${String(exhaustive)}`,
			);
		}
	}
}

/** Returns a zeroed apply result. */
function emptyApplyResult(): SpeakerRenameApplyResult {
	return {
		updatedNotes: 0,
		updatedTranscriptFiles: 0,
		failed: 0,
		skippedLlmNotes: 0,
		missingOutputs: 0,
	};
}

/**
 * Rewrites one transcript sidecar file, counting the outcome into the shared
 * result. A failure is logged and counted, never thrown.
 */
async function rewriteTranscriptFileOutput(
	app: App,
	file: TFile,
	format: TranscriptFileFormat,
	renames: readonly SpeakerRename[],
	result: SpeakerRenameApplyResult,
): Promise<void> {
	try {
		// Skip untouched files with a cheap read, but perform the rewrite
		// against the content vault.process supplies so a concurrent edit
		// between this read and the write is never clobbered.
		const current = await app.vault.read(file);
		if (rewriteSidecar(format, current, renames) === current) {
			return;
		}
		let changed = false;
		await app.vault.process(file, (data) => {
			const rewritten = rewriteSidecar(format, data, renames);
			changed = rewritten !== data;
			return rewritten;
		});
		if (changed) {
			result.updatedTranscriptFiles++;
		}
	} catch (error) {
		result.failed++;
		console.warn(
			`${PLUGIN_LOG_PREFIX} Failed to rewrite ${file.path}:`,
			error,
		);
	}
}

/**
 * Rewrites one note, scoped to the recording's lines when timecode links
 * identify them and whole-note only under `allowBroad`, counting the outcome
 * into the shared result. A failure is logged and counted, never thrown.
 */
async function rewriteNoteOutput(
	app: App,
	note: TFile,
	audioPath: string,
	speakerFormat: string,
	renames: readonly SpeakerRename[],
	allowBroad: boolean,
	result: SpeakerRenameApplyResult,
): Promise<void> {
	try {
		const lines = audioLineIndices(app, note, audioPath);
		const rewriteNote = (data: string): string => {
			if (lines.size > 0) {
				return renameSpeakersInNoteLines(
					data,
					speakerFormat,
					renames,
					lines,
				);
			}
			if (allowBroad) {
				return renameSpeakersInMarkdown(data, speakerFormat, renames);
			}
			return data;
		};
		const current = await app.vault.read(note);
		if (rewriteNote(current) === current) {
			return;
		}
		let changed = false;
		await app.vault.process(note, (data) => {
			const rewritten = rewriteNote(data);
			changed = rewritten !== data;
			return rewritten;
		});
		if (changed) {
			result.updatedNotes++;
		}
	} catch (error) {
		result.failed++;
		console.warn(
			`${PLUGIN_LOG_PREFIX} Failed to rewrite ${note.path}:`,
			error,
		);
	}
}

/**
 * Applies speaker renames to the outputs recorded in the recording's sidecar
 * transcript section: file outputs at their recorded paths and formats, and
 * note outputs with the speaker template each note was actually written with
 * (per-run overrides included), so changing the settings later never breaks
 * a rename. A recorded note replaced by an LLM pass is skipped and counted
 * (rewriting it would silently do nothing); a recorded path that no longer
 * resolves is skipped and counted.
 * @param app - Obsidian App
 * @param audioFile - Recording whose outputs are renamed
 * @param section - The recording's sidecar transcript section
 * @param renames - Display-name renames to apply
 * @param options - `allowBroad` permits whole-note rewrites for untimecoded
 *   transcripts
 * @returns Counts of updated, skipped, and failed outputs
 */
export async function applySpeakerRenamesWithSidecar(
	app: App,
	audioFile: TFile,
	section: TranscriptSection,
	renames: readonly SpeakerRename[],
	options: { allowBroad: boolean },
): Promise<SpeakerRenameApplyResult> {
	const result = emptyApplyResult();
	if (renames.length === 0) {
		return result;
	}

	for (const output of section.fileOutputs) {
		const file = app.vault.getFileByPath(output.path);
		if (!file) {
			result.missingOutputs++;
			continue;
		}
		await rewriteTranscriptFileOutput(
			app,
			file,
			output.format,
			renames,
			result,
		);
	}

	for (const output of section.noteOutputs) {
		const note = app.vault.getFileByPath(output.path);
		if (!note) {
			result.missingOutputs++;
			continue;
		}
		if (output.llmProcessed) {
			// The LLM replaced the rendered transcript body, so a line-scoped
			// rewrite would silently find nothing; count it so the dialog can
			// say the note was left as it is.
			result.skippedLlmNotes++;
			continue;
		}
		await rewriteNoteOutput(
			app,
			note,
			audioFile.path,
			output.templates.speakerFormat,
			renames,
			options.allowBroad,
			result,
		);
	}
	return result;
}

/**
 * Whether any of a recording's recorded note outputs cannot be scoped by
 * timecode links (the note exists, was not LLM-replaced, but carries no line
 * whose link resolves to this audio), so the dialog can offer the broad
 * whole-note rewrite opt-in.
 * @param app - Obsidian App
 * @param audioFile - Recording being renamed
 * @param section - The recording's sidecar transcript section
 */
export function hasUnscopableRecordedNote(
	app: App,
	audioFile: TFile,
	section: TranscriptSection,
): boolean {
	for (const output of section.noteOutputs) {
		if (output.llmProcessed) {
			continue;
		}
		const note = app.vault.getFileByPath(output.path);
		if (!note) {
			continue;
		}
		if (audioLineIndices(app, note, audioFile.path).size === 0) {
			return true;
		}
	}
	return false;
}
