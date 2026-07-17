/**
 * Applies speaker renames to outputs that already exist in the vault: the
 * transcript sidecar files next to the recording (JSON/SRT/VTT/TXT) and
 * every note that links or embeds the recording (found through the
 * metadata cache, so closed notes are covered too). Uses vault.process
 * for atomic note modification, mirroring the link-updater flow.
 * @module speakers/applySpeakerRenames
 */

import type { App, TFile } from 'obsidian';
import { buildTranscriptFilePath } from '../transcription/transcriptOutput';
import type { TranscriptFileFormat } from '../transcription/TranscriptTypes';
import type { SpeakerRename } from './speakerNameModel';
import {
	renameSpeakersInMarkdown,
	renameSpeakersInPlainText,
	renameSpeakersInSubtitles,
	renameSpeakersInTranscriptJson,
} from './transcriptRewrite';

/** Every transcript sidecar format a recording may have next to it. */
const TRANSCRIPT_FILE_FORMATS: readonly TranscriptFileFormat[] = [
	'json',
	'srt',
	'vtt',
	'txt',
];

/** Counts of what a vault-wide rename application actually touched. */
export interface SpeakerRenameApplyResult {
	/** Notes whose rendered transcript was updated. */
	updatedNotes: number;
	/** Transcript sidecar files that were updated. */
	updatedTranscriptFiles: number;
}

/**
 * Rewrites one transcript sidecar file for its format. JSON is parsed and
 * renamed structurally; subtitle and plain-text formats rewrite their
 * speaker prefixes.
 */
function rewriteTranscriptContent(
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
			// Compile-time exhaustiveness: a new format becomes a type error
			// here instead of silently passing through unrewritten.
			const exhaustive: never = format;
			throw new Error(
				`Unsupported transcript file format: ${String(exhaustive)}`,
			);
		}
	}
}

/**
 * Applies speaker renames to the recording's transcript sidecar files and
 * to every note that references the recording. A failure on one file is
 * logged and skipped so the remaining outputs are still updated.
 * @param app - Obsidian App instance
 * @param audioFile - Recording whose outputs are being renamed
 * @param renames - Display-name renames to apply
 * @param speakerFormat - Speaker template notes were rendered with
 * @returns Counts of updated notes and transcript files
 */
export async function applySpeakerRenamesToVault(
	app: App,
	audioFile: TFile,
	renames: readonly SpeakerRename[],
	speakerFormat: string,
): Promise<SpeakerRenameApplyResult> {
	const result: SpeakerRenameApplyResult = {
		updatedNotes: 0,
		updatedTranscriptFiles: 0,
	};
	if (renames.length === 0) {
		return result;
	}

	for (const format of TRANSCRIPT_FILE_FORMATS) {
		const path = buildTranscriptFilePath(audioFile.path, format);
		const file = app.vault.getFileByPath(path);
		if (!file) {
			continue;
		}
		let changed = false;
		await app.vault.process(file, (content) => {
			const rewritten = rewriteTranscriptContent(
				format,
				content,
				renames,
			);
			changed = rewritten !== content;
			return rewritten;
		});
		if (changed) {
			result.updatedTranscriptFiles++;
		}
	}

	// Notes are found through resolvedLinks so closed notes are covered;
	// the rename touches only rendered speaker fragments, so a note that
	// merely links the audio without a transcript comes back unchanged.
	const referencingPaths = Object.entries(app.metadataCache.resolvedLinks)
		.filter(([, links]) => audioFile.path in links)
		.map(([notePath]) => notePath);
	for (const notePath of referencingPaths) {
		const note = app.vault.getFileByPath(notePath);
		if (!note) {
			continue;
		}
		let changed = false;
		await app.vault.process(note, (content) => {
			const rewritten = renameSpeakersInMarkdown(
				content,
				speakerFormat,
				renames,
			);
			changed = rewritten !== content;
			return rewritten;
		});
		if (changed) {
			result.updatedNotes++;
		}
	}
	return result;
}
