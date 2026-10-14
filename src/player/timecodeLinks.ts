/**
 * Pure helpers for resolving audio embeds and timecode links. Kept free
 * of DOM dependencies so the parsing logic can be unit tested in
 * isolation; the one piece of Obsidian they use, `parseLinktext`, is a
 * pure function too, and it is what decides where the path ends so a
 * link is split here exactly as Obsidian splits it when it resolves one.
 * @module player/timecodeLinks
 */

import { parseLinktext } from 'obsidian';
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
	const { path, subpath } = parseLinktext(src);
	return { linkPath: path, startSeconds: parseTimecodeSubpath(subpath) };
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
	if (!hasTimecodeSubpath(subpath)) {
		return null;
	}
	return parseTimecode(subpath.replace(/^#/, '').slice(2));
}

/**
 * Whether a subpath names a moment in a recording (`t=...`), whether or not
 * the time after it is readable. A malformed time is still a timestamp link
 * in intent, which is what the callers deciding how to treat a link need.
 * A leading `#` is tolerated.
 * @param subpath - Link subpath (e.g. "#t=1:30" or "t=abc")
 * @returns True when the subpath is a `t=` timecode
 */
export function hasTimecodeSubpath(subpath: string): boolean {
	return subpath.replace(/^#/, '').startsWith('t=');
}

export { isAudioFile } from '../utils/audioFile';
