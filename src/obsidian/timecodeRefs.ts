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

/** A timecode link resolved to the file it points into. */
interface ResolvedTimecodeLink {
	/** The file the link resolves to. */
	file: TFile;
	/** Seconds the link points at, or null when its value is invalid. */
	seconds: number | null;
}

/** The timecode link a single note line starts a transcript row with. */
export interface LineTimecodeRef extends ResolvedTimecodeLink {
	/** Seconds the link points at. */
	seconds: number;
}

/**
 * Resolves one link target to the file it points into and the time its `#t=`
 * subpath carries.
 * @param app - Obsidian App
 * @param note - Note the link is written in
 * @param link - Link target without its alias, e.g. `rec.m4a#t=12`
 * @returns The reference, or null when the link carries no `#t=` subpath or
 *   resolves to no file
 */
function resolveTimecodeLink(
	app: App,
	note: TFile,
	link: string,
): ResolvedTimecodeLink | null {
	const { path, subpath } = parseLinktext(link);
	if (!subpath.replace(/^#/, '').startsWith('t=')) {
		return null;
	}
	const file = app.metadataCache.getFirstLinkpathDest(path, note.path);
	return file ? { file, seconds: parseTimecodeSubpath(subpath) } : null;
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
	const refs: AudioTimecodeRef[] = [];
	const cache = app.metadataCache.getFileCache(note);
	if (!cache) {
		return refs;
	}
	for (const ref of [...(cache.links ?? []), ...(cache.embeds ?? [])]) {
		const resolved = resolveTimecodeLink(app, note, ref.link);
		if (resolved?.file.path !== audioPath) {
			continue;
		}
		refs.push({
			startLine: ref.position.start.line,
			endLine: ref.position.end.line,
			seconds: resolved.seconds,
		});
	}
	return refs;
}

/**
 * A wikilink or a Markdown link in note source, either of them possibly an
 * embed, with its target captured: `[[target|alias]]` in group 1,
 * `[label](<target>)` in group 2, and `[label](target)` in group 3, where
 * Obsidian URL-encodes the target.
 */
const SOURCE_LINK_PATTERN =
	/!?\[\[([^\]|\n]+)(?:\|[^\]\n]*)?\]\]|!?\[[^\]\n]*\]\((?:<([^>\n]+)>|([^)\s]+))\)/g;

/**
 * Decodes the target of a Markdown link the way the metadata cache reads it.
 * A malformed escape is left as written, since that is what the link says.
 * @param target - The target between the parentheses
 */
function decodeLinkTarget(target: string): string {
	try {
		return decodeURI(target);
	} catch {
		return target;
	}
}

/**
 * The first timecode link in one line of note source that resolves to a file
 * and carries a valid time: what ties a rendered transcript line to the
 * recording it transcribes. Read from the line's own text rather than from
 * the metadata cache, whose line positions trail the editor until the note is
 * saved and parsed again, so a line edited a moment ago, or moved by lines
 * inserted above it, is never matched with a neighbour's link.
 * @param app - Obsidian App
 * @param note - Note the line belongs to
 * @param lineText - The line as the editor holds it
 * @returns The link, or null when the line carries none
 */
export function lineTimecodeRef(
	app: App,
	note: TFile,
	lineText: string,
): LineTimecodeRef | null {
	for (const match of lineText.matchAll(SOURCE_LINK_PATTERN)) {
		const [, wikiTarget, bracketedTarget, encodedTarget] = match;
		const link =
			wikiTarget ??
			bracketedTarget ??
			decodeLinkTarget(String(encodedTarget));
		const ref = resolveTimecodeLink(app, note, link);
		if (ref && ref.seconds !== null) {
			return { file: ref.file, seconds: ref.seconds };
		}
	}
	return null;
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
