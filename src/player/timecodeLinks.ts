/**
 * Pure helpers for resolving audio embeds and timecode links. Kept free
 * of DOM and Obsidian-runtime dependencies so the parsing logic can be
 * unit tested in isolation.
 * @module player/timecodeLinks
 */

import { parseTimecode } from '../utils/TimeUtils';

/**
 * Result of splitting a link target into its path and timecode offset.
 */
export interface AudioLinkTarget {
	/** Link path with the subpath stripped. */
	linkPath: string;
	/** Seconds parsed from a `#t=` subpath, or null when absent/invalid. */
	startSeconds: number | null;
}

/**
 * Splits an embed/link target into its link path and the timecode
 * seconds carried by a `#t=` subpath, when present.
 * @param src - Raw link target (e.g. "rec.webm#t=1:30")
 * @returns Link path and parsed start offset (null when absent)
 */
export function parseAudioLinkTarget(src: string): AudioLinkTarget {
	const hashIndex = src.indexOf('#');
	if (hashIndex < 0) {
		return { linkPath: src, startSeconds: null };
	}
	const linkPath = src.slice(0, hashIndex);
	const subpath = src.slice(hashIndex + 1);
	if (!subpath.startsWith('t=')) {
		return { linkPath, startSeconds: null };
	}
	return { linkPath, startSeconds: parseTimecode(subpath.slice(2)) };
}

/**
 * Returns the target of the wikilink under a cursor position in a line of
 * source text, or null when the cursor is not inside one. Live Preview renders
 * internal links without a `data-href`, so a click there is resolved from the
 * editor source instead of the DOM. The alias (the `|label` part) is dropped,
 * so `[[rec.mp4#t=30|0:30]]` yields `rec.mp4#t=30`.
 * @param lineText - Full source text of the clicked line
 * @param cursorCh - Character index of the cursor within the line
 * @returns Link target with its `#t=` subpath, or null when none is at cursor
 */
export function wikiLinkTargetAtCursor(
	lineText: string,
	cursorCh: number,
): string | null {
	// Internal links: [[target]] or ![[target]], with an optional |alias
	const internalLinkRegex = /!?\[\[(.*?)(?:\|.*?)?\]\]/g;
	let match: RegExpExecArray | null;
	while ((match = internalLinkRegex.exec(lineText)) !== null) {
		const start = match.index;
		const end = start + match[0].length;
		if (match[1] !== undefined && cursorCh >= start && cursorCh <= end) {
			return match[1];
		}
	}
	return null;
}

/**
 * Parses the timecode seconds from an embed subpath, when present.
 * Obsidian's embed registry passes the subpath (the part after `#`)
 * separately from the link path, so this complements parseAudioLinkTarget
 * for the registry path. A leading `#` is tolerated.
 * @param subpath - Embed subpath (e.g. "t=1:30" or "#t=1:30")
 * @returns Seconds parsed from a `t=` subpath, or null when absent/invalid
 */
export function parseTimecodeSubpath(subpath: string): number | null {
	const cleaned = subpath.startsWith('#') ? subpath.slice(1) : subpath;
	if (!cleaned.startsWith('t=')) {
		return null;
	}
	return parseTimecode(cleaned.slice(2));
}

export { isAudioFile } from '../utils/audioFile';
