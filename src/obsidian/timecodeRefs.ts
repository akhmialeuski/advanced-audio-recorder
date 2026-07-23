/**
 * Shared scanner for a note's timecode references: every link or embed whose
 * `#t=` subpath resolves to a given audio file, with its line span and parsed
 * seconds. The single implementation keeps every consumer (speaker renaming
 * scopes note lines by it, chapter generation reads line times from it)
 * agreeing on what counts as "a line that belongs to this recording".
 * @module obsidian/timecodeRefs
 */

import { parseLinktext } from 'obsidian';
import type { App, TFile } from 'obsidian';
import { parseTimecodeSubpath } from '../player/timecodeLinks';

/** One link/embed of a note whose `#t=` subpath resolves to the audio. */
export interface AudioTimecodeRef {
	/** Zero-based first line of the reference. */
	startLine: number;
	/** Zero-based last line of the reference. */
	endLine: number;
	/** Seconds parsed from the subpath, or null when its value is invalid. */
	seconds: number | null;
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
		const { path, subpath } = parseLinktext(ref.link);
		if (!subpath.replace(/^#/, '').startsWith('t=')) {
			continue;
		}
		const dest = app.metadataCache.getFirstLinkpathDest(path, note.path);
		if (dest?.path !== audioPath) {
			continue;
		}
		refs.push({
			startLine: ref.position.start.line,
			endLine: ref.position.end.line,
			seconds: parseTimecodeSubpath(subpath),
		});
	}
	return refs;
}
