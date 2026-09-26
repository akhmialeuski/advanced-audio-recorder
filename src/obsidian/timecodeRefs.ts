/**
 * Shared scanner for a note's timecode references: every link or embed whose
 * `#t=` subpath resolves to a given audio file, with its line span and parsed
 * seconds. The single implementation keeps every consumer (speaker renaming
 * scopes note lines by it, chapter generation reads line times from it, the
 * transcript split finds the recording a selected line belongs to) agreeing on
 * what counts as "a line that belongs to this recording". The builder of those
 * links lives here too, so what is written and what is read back share one
 * definition of a timecode link.
 * @module obsidian/timecodeRefs
 */

import { parseLinktext } from 'obsidian';
import type { App, TFile } from 'obsidian';
import { parseTimecodeSubpath } from '../player/timecodeLinks';
import type { TimecodeLinkBuilder } from '../transcription/transcriptFormat';

/** One link/embed of a note whose `#t=` subpath resolves to the audio. */
export interface AudioTimecodeRef {
	/** Zero-based first line of the reference. */
	startLine: number;
	/** Zero-based last line of the reference. */
	endLine: number;
	/** Seconds parsed from the subpath, or null when its value is invalid. */
	seconds: number | null;
}

/** A timecode reference together with the file it resolves to. */
interface ResolvedTimecodeRef extends AudioTimecodeRef {
	/** The file the link resolves to. */
	dest: TFile;
	/** Zero-based column the reference starts at on its first line. */
	startCol: number;
	/** Zero-based column just past the reference on its last line. */
	endCol: number;
}

/**
 * Every link and embed of a note that carries a `#t=` subpath and resolves to
 * a file, in the metadata cache's order. A plain link (no `#t=` subpath) is
 * deliberately excluded, so a note that only embeds the player yields none.
 * @param app - Obsidian App
 * @param note - Note to inspect
 */
function resolvedTimecodeRefs(app: App, note: TFile): ResolvedTimecodeRef[] {
	const refs: ResolvedTimecodeRef[] = [];
	const cache = app.metadataCache.getFileCache(note);
	if (!cache) {
		return refs;
	}
	for (const ref of [...(cache.links ?? []), ...(cache.embeds ?? [])]) {
		const { path, subpath } = parseLinktext(ref.link);
		if (!subpath.replace(/^#/, '').startsWith('t=')) {
			continue;
		}
		const dest = app.metadataCache.getFirstLinkpathDest(path, note.path);
		if (!dest) {
			continue;
		}
		refs.push({
			dest,
			startLine: ref.position.start.line,
			endLine: ref.position.end.line,
			startCol: ref.position.start.col,
			endCol: ref.position.end.col,
			seconds: parseTimecodeSubpath(subpath),
		});
	}
	return refs;
}

/**
 * Collects the timecode references of a note that resolve to a recording.
 * A plain embed of the audio (no `#t=` subpath) is deliberately excluded,
 * so a note that only embeds the player yields no references.
 * @param app - Obsidian App
 * @param note - Note to inspect
 * @param audioPath - Vault path of the audio file
 */
export function audioTimecodeRefs(
	app: App,
	note: TFile,
	audioPath: string,
): AudioTimecodeRef[] {
	return resolvedTimecodeRefs(app, note)
		.filter((ref) => ref.dest.path === audioPath)
		.map(({ startLine, endLine, seconds }) => ({
			startLine,
			endLine,
			seconds,
		}));
}

/** The timecode link a single note line starts a transcript row with. */
export interface LineTimecodeRef {
	/** The file the link resolves to. */
	file: TFile;
	/** Seconds the link points at. */
	seconds: number;
	/** Column the link starts at. */
	startCol: number;
	/** Column just past the link. */
	endCol: number;
}

/**
 * The first timecode link on one line of a note that resolves to a file and
 * carries a valid time: what ties a rendered transcript line to the recording
 * it transcribes. A link spanning several lines is not a transcript row's
 * timestamp and is ignored.
 * @param app - Obsidian App
 * @param note - Note the line belongs to
 * @param line - Zero-based line number
 * @returns The link, or null when the line carries none
 */
export function lineTimecodeRef(
	app: App,
	note: TFile,
	line: number,
): LineTimecodeRef | null {
	const ref = resolvedTimecodeRefs(app, note)
		.filter(
			(candidate) =>
				candidate.startLine === line &&
				candidate.endLine === line &&
				candidate.seconds !== null,
		)
		.sort((a, b) => a.startCol - b.startCol)[0];
	if (!ref || ref.seconds === null) {
		return null;
	}
	return {
		file: ref.dest,
		seconds: ref.seconds,
		startCol: ref.startCol,
		endCol: ref.endCol,
	};
}

/**
 * Builds the timecode links a transcript is rendered with: vault links with a
 * `#t=` subpath (handled by the enhanced player) that honor the vault's
 * link-format preference.
 * @param app - Obsidian App
 * @param file - The recording the links point into
 * @param notePath - Vault path of the note the links are written into
 */
export function timecodeLinkBuilder(
	app: App,
	file: TFile,
	notePath: string,
): TimecodeLinkBuilder {
	return (seconds: number, label: string) =>
		app.fileManager.generateMarkdownLink(
			file,
			notePath,
			`#t=${String(Math.floor(seconds))}`,
			label,
		);
}
