/**
 * The recordings a note refers to, read from the metadata cache: what the
 * palette, the command line, the context menus and the recording panel all
 * take as "the recordings of this note", so they list the same files in the
 * same order.
 * @module obsidian/noteRecordings
 */

import { getLinkpath } from 'obsidian';
import type { App, TFile } from 'obsidian';
import { isAudioFile } from '../utils/audioFile';

/**
 * Every recording a note links or embeds, in the order the note mentions
 * them, each once: its properties first, as they head the note, then its
 * body. A transcript links its recording on every line, which is why
 * repeats are folded rather than listed.
 * @param app - Obsidian App
 * @param note - The note to read
 * @returns The recordings, in document order
 */
export function recordingsInNote(app: App, note: TFile): TFile[] {
	const cache = app.metadataCache.getFileCache(note);
	const references = [
		// A property such as `audio: "[[standup.webm]]"` links the recording
		// as surely as an embed does; it carries no position, and comes first.
		...(cache?.frontmatterLinks ?? []),
		...[...(cache?.links ?? []), ...(cache?.embeds ?? [])].sort(
			(a, b) => a.position.start.offset - b.position.start.offset,
		),
	];
	const recordings = new Map<string, TFile>();
	// A transcript links its recording once per line, each a different
	// moment of the same file, so each link path is resolved only once.
	const resolved = new Map<string, TFile | null>();
	for (const reference of references) {
		const linkpath = getLinkpath(reference.link);
		let file = resolved.get(linkpath);
		if (file === undefined) {
			file = app.metadataCache.getFirstLinkpathDest(linkpath, note.path);
			resolved.set(linkpath, file);
		}
		if (file && isAudioFile(file) && !recordings.has(file.path)) {
			recordings.set(file.path, file);
		}
	}
	return [...recordings.values()];
}
