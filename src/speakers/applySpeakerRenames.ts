/**
 * Vault-side orchestration for the manual speaker rename. It discovers a
 * recording's transcript outputs (the sidecar files next to it and the notes
 * that reference it), reads the current speaker roster out of them so the
 * dialog needs no stored state, and applies renames scoped to the recording:
 * a note is rewritten only on the lines whose timecode link resolves to this
 * audio. A transcript without such links cannot be scoped, so a broad rewrite
 * of the whole note is offered only after the caller confirms. Each output is
 * rewritten independently, so one failure is logged and skipped rather than
 * aborting the rest.
 * @module speakers/applySpeakerRenames
 */

import { parseLinktext } from 'obsidian';
import type { App, TFile } from 'obsidian';
import { PLUGIN_LOG_PREFIX } from '../constants';
import { buildTranscriptFilePath } from '../transcription/transcriptOutput';
import type { TranscriptFileFormat } from '../transcription/TranscriptTypes';
import { isAudioFile } from '../utils/audioFile';
import { directoryOf } from '../utils/paths';
import type { SpeakerRename } from './speakerRename';
import {
	extractJsonSpeakers,
	extractNoteSpeakers,
	extractPlainTextSpeakers,
	extractSubtitleSpeakers,
	renameSpeakersInMarkdown,
	renameSpeakersInNoteLines,
	renameSpeakersInPlainText,
	renameSpeakersInSubtitles,
	renameSpeakersInTranscriptJson,
	type NoteSpeakerTemplates,
} from './transcriptRewrite';

/** Every transcript sidecar format a recording may have next to it. */
const TRANSCRIPT_FILE_FORMATS: readonly TranscriptFileFormat[] = [
	'json',
	'srt',
	'vtt',
	'txt',
];

/** A transcript sidecar file discovered next to a recording. */
interface TranscriptSidecar {
	file: TFile;
	format: TranscriptFileFormat;
}

/** Counts of what a vault-wide rename application actually touched. */
export interface SpeakerRenameApplyResult {
	/** Notes whose rendered transcript was updated. */
	updatedNotes: number;
	/** Transcript sidecar files that were updated. */
	updatedTranscriptFiles: number;
	/** Outputs whose rewrite threw and were skipped. */
	failed: number;
}

/** Escapes a literal string for embedding in a RegExp. */
function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Whether a parsed link subpath is a timecode subpath (`#t=<seconds>`). */
function isTimecodeSubpath(subpath: string): boolean {
	return subpath.replace(/^#/, '').startsWith('t=');
}

/**
 * Returns the zero-based line indices of a note that belong to a recording,
 * meaning a link or embed on that line resolves to the audio through a
 * timecode subpath. The player embed itself (no timecode) is deliberately
 * excluded, so a note that only embeds the recording yields no lines.
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
	const cache = app.metadataCache.getFileCache(note);
	if (!cache) {
		return lines;
	}
	const refs = [...(cache.links ?? []), ...(cache.embeds ?? [])];
	for (const ref of refs) {
		const { path, subpath } = parseLinktext(ref.link);
		if (!isTimecodeSubpath(subpath)) {
			continue;
		}
		const dest = app.metadataCache.getFirstLinkpathDest(path, note.path);
		if (dest?.path !== audioPath) {
			continue;
		}
		for (
			let line = ref.position.start.line;
			line <= ref.position.end.line;
			line++
		) {
			lines.add(line);
		}
	}
	return lines;
}

/**
 * Finds the notes that reference a recording (through the metadata cache, so
 * closed notes are covered too).
 * @param app - Obsidian App
 * @param audioPath - Vault path of the audio file
 */
function findReferencingNotes(app: App, audioPath: string): TFile[] {
	const notes: TFile[] = [];
	for (const [notePath, links] of Object.entries(
		app.metadataCache.resolvedLinks,
	)) {
		if (audioPath in links) {
			const note = app.vault.getFileByPath(notePath);
			if (note) {
				notes.push(note);
			}
		}
	}
	return notes;
}

/**
 * Finds the transcript sidecar files a recording actually has next to it,
 * matching the canonical name and the `_<n>` collision suffix the writer uses,
 * so a transcript written to a deduplicated path is still found. A `_<n>`
 * candidate that is instead a sibling recording's own canonical sidecar
 * (`rec_1.srt` next to `rec_1.wav`) is excluded, so renaming `rec.wav` never
 * reads or rewrites another recording's transcript.
 * @param app - Obsidian App
 * @param audioFile - Recording whose sidecars are sought
 */
function findTranscriptSidecarFiles(
	app: App,
	audioFile: TFile,
): TranscriptSidecar[] {
	const files = app.vault.getFiles();
	const dir = directoryOf(audioFile.path);
	// Other recordings sharing the directory own their own canonical sidecars;
	// those paths must not be attributed to this recording as collisions.
	const siblingAudio = files.filter(
		(file) =>
			file.path !== audioFile.path &&
			directoryOf(file.path) === dir &&
			isAudioFile(file),
	);
	const sidecars: TranscriptSidecar[] = [];
	for (const format of TRANSCRIPT_FILE_FORMATS) {
		const canonical = buildTranscriptFilePath(audioFile.path, format);
		const canonicalName = canonical.slice(dir ? dir.length + 1 : 0);
		const dot = canonicalName.lastIndexOf('.');
		const stem = canonicalName.slice(0, dot);
		const ext = canonicalName.slice(dot + 1);
		const pattern = new RegExp(
			`^${escapeRegExp(stem)}(_\\d+)?\\.${escapeRegExp(ext)}$`,
		);
		const ownedByOthers = new Set(
			siblingAudio.map((file) =>
				buildTranscriptFilePath(file.path, format),
			),
		);
		for (const file of files) {
			if (
				directoryOf(file.path) === dir &&
				pattern.test(file.name) &&
				!ownedByOthers.has(file.path)
			) {
				sidecars.push({ file, format });
			}
		}
	}
	return sidecars;
}

/** Reads the speaker names out of one sidecar file's content by format. */
function speakersFromSidecar(
	format: TranscriptFileFormat,
	content: string,
): string[] {
	switch (format) {
		case 'json':
			return extractJsonSpeakers(content) ?? [];
		case 'srt':
		case 'vtt':
			return extractSubtitleSpeakers(content);
		case 'txt':
			return extractPlainTextSpeakers(content);
		default: {
			const exhaustive: never = format;
			throw new Error(
				`Unsupported transcript file format: ${String(exhaustive)}`,
			);
		}
	}
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

/** What the rename dialog needs to know about a recording's transcript. */
export interface AudioTranscriptInspection {
	/** Distinct speaker display names currently in the outputs, in order. */
	roster: string[];
	/**
	 * Whether some referencing note carries the transcript but no timecode
	 * links to scope by, so renaming it would rewrite every matching label in
	 * that note. The dialog surfaces this so the user opts in.
	 */
	hasUnscopableNote: boolean;
}

/**
 * Reads a recording's current speaker roster out of its existing transcript
 * outputs, with no stored state: the sidecar files next to it and the notes
 * that reference it, scoped to this audio's lines when the transcript carries
 * timecode links and read whole otherwise. Also reports whether any note is
 * unscopable, so the dialog can warn before a broad rewrite.
 * @param app - Obsidian App
 * @param audioFile - Recording whose transcript is inspected
 * @param templates - Render templates the notes were written with, used to
 *   locate speaker labels by the same shape they were rendered in
 */
export async function inspectAudioTranscript(
	app: App,
	audioFile: TFile,
	templates: NoteSpeakerTemplates,
): Promise<AudioTranscriptInspection> {
	const seen = new Set<string>();
	const roster: string[] = [];
	let hasUnscopableNote = false;
	const add = (names: readonly string[]): void => {
		for (const name of names) {
			if (!seen.has(name)) {
				seen.add(name);
				roster.push(name);
			}
		}
	};
	for (const { file, format } of findTranscriptSidecarFiles(app, audioFile)) {
		try {
			add(speakersFromSidecar(format, await app.vault.read(file)));
		} catch (error) {
			console.warn(
				`${PLUGIN_LOG_PREFIX} Failed to read speakers from ${file.path}:`,
				error,
			);
		}
	}
	for (const note of findReferencingNotes(app, audioFile.path)) {
		try {
			const lines = audioLineIndices(app, note, audioFile.path);
			const content = await app.vault.read(note);
			// With timecode links, read only this audio's lines; without them
			// the note cannot be scoped, so read the whole note.
			const scoped = lines.size > 0 ? lines : null;
			const names = extractNoteSpeakers(content, templates, scoped);
			add(names);
			if (scoped === null && names.length > 0) {
				hasUnscopableNote = true;
			}
		} catch (error) {
			console.warn(
				`${PLUGIN_LOG_PREFIX} Failed to read speakers from ${note.path}:`,
				error,
			);
		}
	}
	return { roster, hasUnscopableNote };
}

/**
 * Applies speaker renames to a recording's transcript sidecar files and to the
 * notes that reference it. Notes are rewritten only on the lines that resolve
 * to this audio; a note without such links is rewritten whole only when
 * `allowBroad` is set (the caller having confirmed). A failure on one output
 * is logged and counted, not thrown, so the remaining outputs still update.
 * @param app - Obsidian App
 * @param audioFile - Recording whose outputs are renamed
 * @param renames - Display-name renames to apply
 * @param speakerFormat - Speaker template notes were rendered with
 * @param options - `allowBroad` permits whole-note rewrites for untimecoded
 *   transcripts
 * @returns Counts of updated notes and files, and failures
 */
export async function applySpeakerRenamesToVault(
	app: App,
	audioFile: TFile,
	renames: readonly SpeakerRename[],
	speakerFormat: string,
	options: { allowBroad: boolean },
): Promise<SpeakerRenameApplyResult> {
	const result: SpeakerRenameApplyResult = {
		updatedNotes: 0,
		updatedTranscriptFiles: 0,
		failed: 0,
	};
	if (renames.length === 0) {
		return result;
	}

	for (const { file, format } of findTranscriptSidecarFiles(app, audioFile)) {
		try {
			// Skip untouched files with a cheap read, but perform the rewrite
			// against the content vault.process supplies so a concurrent edit
			// between this read and the write is never clobbered.
			const current = await app.vault.read(file);
			if (rewriteSidecar(format, current, renames) === current) {
				continue;
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

	for (const note of findReferencingNotes(app, audioFile.path)) {
		try {
			const lines = audioLineIndices(app, note, audioFile.path);
			const rewriteNote = (data: string): string => {
				if (lines.size > 0) {
					return renameSpeakersInNoteLines(
						data,
						speakerFormat,
						renames,
						lines,
					);
				}
				if (options.allowBroad) {
					return renameSpeakersInMarkdown(
						data,
						speakerFormat,
						renames,
					);
				}
				return data;
			};
			const current = await app.vault.read(note);
			if (rewriteNote(current) === current) {
				continue;
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
	return result;
}
