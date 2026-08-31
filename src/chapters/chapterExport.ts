/**
 * The three ways a recording's markers leave the plugin.
 *
 * Markers exist only in the player's own list, which is no use in a video
 * description, a podcast host, or another player. These are the three
 * representations that are actually accepted out there: a timecoded list for a
 * description box, a cue sheet for players and audio editors, and a Markdown
 * outline whose timecodes are clickable inside the vault.
 *
 * Every function here is pure, so the formatting is unit tested against the
 * awkward cases: a recording over an hour, a chapter of zero length, a title
 * with a quotation mark in it.
 * @module chapters/chapterExport
 */

import { chapters, MARKER_KIND } from '../markers/markerModel';
import type { PlayerMarker } from '../markers/markerModel';
import { formatTimecode } from '../utils/TimeUtils';
import type { TimecodeLinkBuilder } from '../transcription/transcriptFormat';

/** Seconds in a minute, for the cue sheet's own time format. */
const SECONDS_PER_MINUTE = 60;

/** Frames per second in a cue sheet's MM:SS:FF timestamp. */
const CUE_FRAMES_PER_SECOND = 75;

/** What a cue sheet says about the recording it describes. */
export interface CueSheetMeta {
	/** Name of the audio file the sheet points at. */
	fileName: string;
	/** Title of the recording as a whole. */
	title: string;
	/** Who the recording is credited to; omitted when unknown. */
	performer?: string;
}

/**
 * A timecode in the form a description box takes: `0:00` under a minute,
 * `1:02:03` over an hour. The reference is the last marker, so every line of
 * one export is the same width and the list reads as a column.
 * @param seconds - Offset into the recording
 * @param reference - The longest offset in the same export
 * @returns The timecode
 */
function stamp(seconds: number, reference: number): string {
	return formatTimecode(Math.max(0, seconds), reference);
}

/** The longest offset among the markers, which sets the timecode width. */
function longest(markers: readonly PlayerMarker[]): number {
	return markers.reduce((max, marker) => Math.max(max, marker.time), 0);
}

/**
 * The markers to export, in time order. Both kinds go out: a bookmark is a
 * point the user marked, and a description box makes no distinction.
 * @param markers - The recording's markers
 * @returns The markers, time-sorted
 */
function exportable(markers: readonly PlayerMarker[]): PlayerMarker[] {
	return [...markers].sort((a, b) => a.time - b.time);
}

/**
 * The timecoded list a video description takes: one line per marker, the
 * timecode first and the name after it.
 *
 * A note on the marker is appended after a dash, because that is where the
 * detail the user wrote about the moment belongs and a description box has
 * nowhere else to put it.
 * @param markers - The recording's markers
 * @returns The list, one marker per line; empty for a recording with none
 */
export function formatChapterList(markers: readonly PlayerMarker[]): string {
	const sorted = exportable(markers);
	const reference = longest(sorted);
	return sorted
		.map((marker) => {
			const line = `${stamp(marker.time, reference)} ${marker.label}`;
			return marker.note ? `${line} - ${marker.note}` : line;
		})
		.join('\n');
}

/**
 * A cue sheet timestamp, which counts in minutes, seconds, and 1/75th-second
 * frames and has no hours field at all: an hour and two minutes is 62:00:00.
 * @param seconds - Offset into the recording
 * @returns The MM:SS:FF timestamp
 */
function cueTime(seconds: number): string {
	const safe = Math.max(0, seconds);
	const minutes = Math.floor(safe / SECONDS_PER_MINUTE);
	const remainder = safe - minutes * SECONDS_PER_MINUTE;
	const wholeSeconds = Math.floor(remainder);
	const frames = Math.round(
		(remainder - wholeSeconds) * CUE_FRAMES_PER_SECOND,
	);
	// Rounding can land on 75 frames, which is the next second rather than a
	// frame number that exists.
	const carry = frames === CUE_FRAMES_PER_SECOND ? 1 : 0;
	return [
		minutes + Math.floor((wholeSeconds + carry) / SECONDS_PER_MINUTE),
		(wholeSeconds + carry) % SECONDS_PER_MINUTE,
		carry ? 0 : frames,
	]
		.map((part) => String(part).padStart(2, '0'))
		.join(':');
}

/**
 * Quotes a value for a cue sheet field. The format has no escape, so a
 * quotation mark inside a title is dropped rather than left to end the field
 * early and make the rest of the line unreadable.
 * @param value - The text to quote
 * @returns The quoted value
 */
function cueQuoted(value: string): string {
	return `"${value.replace(/"/g, '')}"`;
}

/**
 * The cue sheet for a recording: one TRACK per marker, each with its title
 * and its start.
 *
 * Only chapters go in. A cue sheet describes a division of the recording into
 * playable tracks, and a bookmark is a point rather than a division; putting
 * one in would claim a track boundary the user never drew.
 * @param markers - The recording's markers
 * @param meta - What the sheet says about the recording as a whole
 * @returns The cue sheet; a header alone for a recording with no chapters
 */
export function formatCueSheet(
	markers: readonly PlayerMarker[],
	meta: CueSheetMeta,
): string {
	const lines: string[] = [];
	if (meta.performer) {
		lines.push(`PERFORMER ${cueQuoted(meta.performer)}`);
	}
	lines.push(`TITLE ${cueQuoted(meta.title)}`);
	lines.push(`FILE ${cueQuoted(meta.fileName)} WAVE`);
	exportable(chapters(markers)).forEach((chapter, index) => {
		lines.push(`  TRACK ${String(index + 1).padStart(2, '0')} AUDIO`);
		lines.push(`    TITLE ${cueQuoted(chapter.label)}`);
		lines.push(`    INDEX 01 ${cueTime(chapter.time)}`);
	});
	return `${lines.join('\n')}\n`;
}

/**
 * The Markdown outline: one bullet per marker whose timecode is a link into
 * the recording, so clicking it moves playback there.
 *
 * The link is built by the caller's own builder, the same one transcripts use,
 * which is what makes the timecode work rather than merely look like a link.
 * @param markers - The recording's markers
 * @param linkBuilder - Builds a link to an offset with a label
 * @returns The outline, one marker per line; empty for a recording with none
 */
export function formatChapterOutline(
	markers: readonly PlayerMarker[],
	linkBuilder: TimecodeLinkBuilder,
): string {
	const sorted = exportable(markers);
	const reference = longest(sorted);
	return sorted
		.map((marker) => {
			const link = linkBuilder(
				marker.time,
				stamp(marker.time, reference),
			);
			const kind =
				marker.kind === MARKER_KIND.chapter
					? marker.label
					: `${marker.label} (bookmark)`;
			const line = `- ${link} ${kind}`;
			return marker.note ? `${line} - ${marker.note}` : line;
		})
		.join('\n');
}
