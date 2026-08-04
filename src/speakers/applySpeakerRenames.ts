/**
 * Vault-side application of a speaker rename, driven entirely by the
 * recording's sidecar transcript section: the file outputs are rewritten at
 * their recorded paths and formats, and the note outputs with the render
 * templates each note was actually written with, scoped to the lines whose
 * timecode link resolves to this audio. A transcript without such links
 * cannot be scoped, so a broad rewrite of the whole note is offered only
 * after the caller confirms. An output is judged only by what it turns out to
 * contain, never by what the transcribing run was configured to do, and a note
 * the rewrite left alone is read back to find out why, so the caller can name
 * the actual reason instead of guessing one. Each output is rewritten
 * independently, so one failure is logged and skipped rather than aborting
 * the rest.
 * @module speakers/applySpeakerRenames
 */

import type { App, TFile } from 'obsidian';
import { PLUGIN_LOG_PREFIX } from '../constants';
import { audioTimecodeRefs } from '../obsidian/timecodeRefs';
import type { TranscriptSection } from '../sidecar/recordingSidecarModel';
import type { TranscriptFileFormat } from '../transcription/TranscriptTypes';
import type { SpeakerRename } from './speakerRename';
import {
	noteShowsAnySpeaker,
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
	/**
	 * Notes carrying no timecode link that resolves to this recording, left
	 * untouched because a whole-note rewrite was not allowed. They were never
	 * attempted, so their labels may well be intact and the broad opt-in is
	 * what rewrites them.
	 */
	unscopableNotes: number;
	/**
	 * Notes the rewrite attempted, could not change, and read back as already
	 * showing the names being applied. Nothing was wrong with them: a rename
	 * that reaches an output twice, or an apply that only heals the others,
	 * lands here.
	 */
	alreadyCurrentNotes: number;
	/**
	 * Notes the rewrite did attempt and could not change, because no fragment
	 * rendered from the note's own speaker template survives in it - neither
	 * the text being replaced nor the text replacing it. The labels are
	 * genuinely gone, whether an LLM pass restructured the body or a hand
	 * edit did.
	 */
	unmatchedNotes: number;
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
		unscopableNotes: 0,
		alreadyCurrentNotes: 0,
		unmatchedNotes: 0,
		missingOutputs: 0,
	};
}

/**
 * Counts a note the rewrite left byte-identical, by reading back which of the
 * two opposite causes produced it: the note already shows the names this apply
 * targets (healthy, nothing to do), or it shows no rendered speaker fragment
 * at all (the labels the transcript was written with are gone). Guessing here
 * is what makes a rename dialog accuse an output that is perfectly in sync.
 * @param content - Note content as the rewrite saw it
 * @param speakerFormat - Speaker template the note was written with
 * @param renames - Replacements that found nothing to do
 * @param scope - Lines belonging to this recording, null when unscoped
 * @param result - Shared result the outcome is counted into
 */
function countUntouchedNote(
	content: string,
	speakerFormat: string,
	renames: readonly SpeakerRename[],
	scope: ReadonlySet<number> | null,
	result: SpeakerRenameApplyResult,
): void {
	const targets = renames.map((rename) => rename.to);
	if (noteShowsAnySpeaker(content, speakerFormat, targets, scope)) {
		result.alreadyCurrentNotes++;
		return;
	}
	result.unmatchedNotes++;
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
 * into the shared result. The three ways a note can survive untouched are
 * counted apart, because they call for different advice: it was never
 * attempted and the broad opt-in would rewrite it, it was attempted and
 * already shows these names, or it was attempted and holds no rendered label
 * any more. A failure is logged and counted, never thrown.
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
		if (lines.size === 0 && !allowBroad) {
			// Nothing is read or matched here, so this note must never be
			// reported as carrying no label: its labels are usually intact and
			// the broad opt-in is the answer the caller has to offer.
			result.unscopableNotes++;
			return;
		}
		const scope = lines.size > 0 ? lines : null;
		const rewriteNote = (data: string): string =>
			scope
				? renameSpeakersInNoteLines(data, speakerFormat, renames, scope)
				: renameSpeakersInMarkdown(data, speakerFormat, renames);
		// Skip untouched notes with a cheap read, but perform the rewrite
		// against the content vault.process supplies so a concurrent edit
		// between this read and the write is never clobbered. Either content
		// is the one to judge an untouched note by, so both are carried into
		// the count below rather than assumed identical.
		const current = await app.vault.read(note);
		if (rewriteNote(current) === current) {
			countUntouchedNote(current, speakerFormat, renames, scope, result);
			return;
		}
		let seen = current;
		let changed = false;
		await app.vault.process(note, (data) => {
			seen = data;
			const rewritten = rewriteNote(data);
			changed = rewritten !== data;
			return rewritten;
		});
		if (changed) {
			result.updatedNotes++;
		} else {
			countUntouchedNote(seen, speakerFormat, renames, scope, result);
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
 * a rename. Every recorded note is attempted whatever the transcribing run
 * enabled, because the line-scoped rewrite only touches lines whose timecode
 * link resolves to this audio and only replaces exact rendered speaker
 * fragments, so a body an LLM pass did restructure is a no-op rather than a
 * hazard. The three untouched outcomes are counted apart - never attempted for
 * want of a scope, attempted and already showing these names, attempted and
 * holding no rendered label - because each calls for different words, and only
 * the first has a remedy the caller can offer. A recorded path that no longer
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
 * timecode links (the note exists but carries no line whose link resolves to
 * this audio), so the dialog can offer the broad whole-note rewrite opt-in.
 * An LLM-post-processed note counts like any other, since that pass is the
 * very thing that can strip the timecode links a scoped rewrite needs.
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
