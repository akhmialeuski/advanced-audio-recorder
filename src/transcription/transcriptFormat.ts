/**
 * Rendering a transcript to Markdown (with configurable per-part
 * templates and clickable timecode links) and to the standard transcript
 * file formats (JSON, SRT, WebVTT, plain text). All functions are pure;
 * timecode links are produced by an injected callback so the formatter
 * stays free of Obsidian and DOM dependencies.
 * @module transcription/transcriptFormat
 */

import { formatTimecode } from '../utils/TimeUtils';
import type { Transcript, TranscriptSegment } from './TranscriptTypes';

/**
 * Options controlling the Markdown rendering. The three format fragments
 * let the user decide exactly how the timestamp, speaker, and text are
 * laid out; empty fragments are dropped and surrounding whitespace is
 * collapsed.
 */
export interface TranscriptMarkdownOptions {
	/** Whether to render timestamps at all. */
	includeTimestamps: boolean;
	/** Whether timestamps are clickable links into the player. */
	timestampLinks: boolean;
	/** Whether to render speaker labels. */
	includeSpeakers: boolean;
	/** Merge consecutive segments from the same speaker into one line. */
	mergeConsecutiveSpeaker: boolean;
	/** How a timestamp is wrapped; `{time}` is the (possibly linked) code. */
	timestampFormat: string;
	/** How a speaker is wrapped; `{speaker}` is the label. */
	speakerFormat: string;
	/** Arrangement of the three parts; tokens `{timestamp}`/`{speaker}`/`{text}`. */
	lineFormat: string;
}

/** Sensible default Markdown rendering options. */
export const DEFAULT_TRANSCRIPT_MARKDOWN_OPTIONS: TranscriptMarkdownOptions = {
	includeTimestamps: true,
	timestampLinks: true,
	includeSpeakers: true,
	mergeConsecutiveSpeaker: true,
	timestampFormat: '[{time}]',
	speakerFormat: '**{speaker}**',
	lineFormat: '{timestamp} {speaker} {text}',
};

/**
 * Builds a timecode link/label for a position in the audio.
 * Implementations turn seconds into a vault link with a `#t=` subpath;
 * tests pass a plain stub.
 */
export type TimecodeLinkBuilder = (seconds: number, label: string) => string;

/** A speaker-grouped run of text for rendering one Markdown line. */
interface RenderRow {
	start: number;
	speaker?: string;
	text: string;
}

/**
 * Groups segments into render rows, optionally merging consecutive
 * same-speaker segments so a speaker turn becomes a single line.
 * @param segments - Transcript segments (assumed time-sorted)
 * @param merge - Whether to merge consecutive same-speaker segments
 */
function toRenderRows(
	segments: readonly TranscriptSegment[],
	merge: boolean,
): RenderRow[] {
	const rows: RenderRow[] = [];
	for (const segment of segments) {
		const previous = rows[rows.length - 1];
		if (
			merge &&
			previous &&
			// Only merge a genuine speaker turn: without diarization every
			// segment has an undefined speaker, and merging them all would
			// collapse the transcript into one line and lose timestamps.
			segment.speaker !== undefined &&
			previous.speaker === segment.speaker &&
			segment.text.length > 0
		) {
			previous.text = `${previous.text} ${segment.text}`.trim();
			continue;
		}
		rows.push({
			start: segment.start,
			speaker: segment.speaker,
			text: segment.text,
		});
	}
	return rows;
}

/**
 * Substitutes named tokens in a template, then collapses repeated
 * whitespace and trims. `{token}` occurrences with an empty value
 * disappear cleanly.
 * @param template - Template string with `{name}` tokens
 * @param values - Token replacements
 */
function applyTemplate(
	template: string,
	values: Record<string, string>,
): string {
	const substituted = template.replace(
		/\{(\w+)\}/g,
		(_match, name: string) =>
			Object.prototype.hasOwnProperty.call(values, name)
				? values[name]
				: '',
	);
	return substituted.replace(/[ \t]{2,}/g, ' ').trim();
}

/**
 * Renders a transcript to Markdown lines using the configured templates.
 * Each speaker turn (or segment) becomes one line.
 * @param transcript - Source transcript
 * @param options - Rendering options
 * @param linkBuilder - Builds clickable timecode links (when enabled)
 * @returns Markdown string (lines separated by blank lines)
 */
export function formatTranscriptMarkdown(
	transcript: Transcript,
	options: TranscriptMarkdownOptions,
	linkBuilder: TimecodeLinkBuilder,
): string {
	const rows = toRenderRows(
		transcript.segments,
		options.mergeConsecutiveSpeaker,
	);
	const lines = rows.map((row) => {
		const timestamp = options.includeTimestamps
			? applyTemplate(options.timestampFormat, {
					time: renderTimecode(
						row.start,
						options.timestampLinks,
						linkBuilder,
					),
				})
			: '';
		const speaker =
			options.includeSpeakers && row.speaker
				? applyTemplate(options.speakerFormat, { speaker: row.speaker })
				: '';
		return applyTemplate(options.lineFormat, {
			timestamp,
			speaker,
			text: row.text,
		});
	});
	return lines.join('\n\n');
}

/**
 * Renders one timecode as either a clickable link or a plain label.
 */
function renderTimecode(
	seconds: number,
	asLink: boolean,
	linkBuilder: TimecodeLinkBuilder,
): string {
	const label = formatTimecode(seconds);
	return asLink ? linkBuilder(seconds, label) : label;
}

/**
 * Serializes a transcript to the requested file format.
 * @param transcript - Source transcript
 * @param format - Target file format
 */
export function serializeTranscriptFile(
	transcript: Transcript,
	format: 'json' | 'srt' | 'vtt' | 'txt',
): string {
	switch (format) {
		case 'json':
			return JSON.stringify(transcript, null, 2);
		case 'srt':
			return toSrt(transcript);
		case 'vtt':
			return toVtt(transcript);
		case 'txt':
			return toPlainTextFile(transcript);
	}
}

/**
 * Formats seconds as a subtitle timestamp `HH:MM:SS,mmm` (SRT) or
 * `HH:MM:SS.mmm` (VTT).
 */
function formatSubtitleTime(seconds: number, millisSep: string): string {
	const clamped = Math.max(0, seconds);
	const hours = Math.floor(clamped / 3600);
	const minutes = Math.floor((clamped % 3600) / 60);
	const secs = Math.floor(clamped % 60);
	const millis = Math.round((clamped - Math.floor(clamped)) * 1000);
	const pad = (value: number, width = 2): string =>
		String(value).padStart(width, '0');
	return `${pad(hours)}:${pad(minutes)}:${pad(secs)}${millisSep}${pad(millis, 3)}`;
}

/**
 * Renders the speaker prefix used in subtitle/plain-text bodies.
 */
function speakerPrefix(segment: TranscriptSegment): string {
	return segment.speaker ? `${segment.speaker}: ` : '';
}

/**
 * Serializes to SubRip (.srt).
 */
function toSrt(transcript: Transcript): string {
	return transcript.segments
		.map((segment, index) => {
			const start = formatSubtitleTime(segment.start, ',');
			const end = formatSubtitleTime(segment.end, ',');
			return `${String(index + 1)}\n${start} --> ${end}\n${speakerPrefix(segment)}${segment.text}`;
		})
		.join('\n\n');
}

/**
 * Serializes to WebVTT (.vtt).
 */
function toVtt(transcript: Transcript): string {
	const cues = transcript.segments
		.map((segment) => {
			const start = formatSubtitleTime(segment.start, '.');
			const end = formatSubtitleTime(segment.end, '.');
			return `${start} --> ${end}\n${speakerPrefix(segment)}${segment.text}`;
		})
		.join('\n\n');
	return `WEBVTT\n\n${cues}`;
}

/**
 * Serializes to a readable plain-text transcript.
 */
function toPlainTextFile(transcript: Transcript): string {
	return transcript.segments
		.map((segment) => {
			const time = formatTimecode(segment.start);
			return `[${time}] ${speakerPrefix(segment)}${segment.text}`;
		})
		.join('\n');
}
