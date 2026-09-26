/**
 * Rendering a transcript to Markdown (with configurable per-part
 * templates and clickable timecode links) and to the standard transcript
 * file formats (JSON, SRT, WebVTT, plain text). All functions are pure;
 * timecode links are produced by an injected callback so the formatter
 * stays free of Obsidian and DOM dependencies.
 * @module transcription/transcriptFormat
 */

import type { AudioRecorderSettings } from '../settings/settingsSchema';
import { escapeRegExp } from '../utils/regex';
import { formatTimecode } from '../utils/TimeUtils';
import {
	type Transcript,
	TranscriptFileFormat,
	type TranscriptSegment,
} from './TranscriptTypes';

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
	// No surrounding brackets by default: with timestamp links on (the
	// default) the link already delimits the timecode, and wrapping a
	// wikilink in '[...]' would produce fragile nested brackets ('[[[...]]]').
	timestampFormat: '{time}',
	speakerFormat: '**{speaker}**',
	lineFormat: '{timestamp} {speaker} {text}',
};

/** The settings the in-note transcript rendering is configured by. */
export type TranscriptMarkdownSettings = Pick<
	AudioRecorderSettings,
	| 'transcriptIncludeTimestamps'
	| 'transcriptTimestampLinks'
	| 'transcriptIncludeSpeakers'
	| 'transcriptMergeConsecutiveSpeaker'
	| 'transcriptTimestampFormat'
	| 'transcriptSpeakerFormat'
	| 'transcriptLineFormat'
>;

/**
 * Builds the Markdown rendering options from the plugin settings.
 * @param settings - Current plugin settings
 */
export function transcriptMarkdownOptions(
	settings: TranscriptMarkdownSettings,
): TranscriptMarkdownOptions {
	return {
		...DEFAULT_TRANSCRIPT_MARKDOWN_OPTIONS,
		includeTimestamps: settings.transcriptIncludeTimestamps,
		timestampLinks: settings.transcriptTimestampLinks,
		includeSpeakers: settings.transcriptIncludeSpeakers,
		mergeConsecutiveSpeaker: settings.transcriptMergeConsecutiveSpeaker,
		timestampFormat: settings.transcriptTimestampFormat,
		speakerFormat: settings.transcriptSpeakerFormat,
		lineFormat: settings.transcriptLineFormat,
	};
}

/**
 * Builds a timecode link/label for a position in the audio.
 * Implementations turn seconds into a vault link with a `#t=` subpath;
 * tests pass a plain stub.
 */
export type TimecodeLinkBuilder = (seconds: number, label: string) => string;

/** A speaker-grouped run of text for rendering one Markdown line. */
interface RenderRow {
	start: number;
	speaker?: string | undefined;
	text: string;
}

/**
 * Whether a segment continues the render row of the given speaker when
 * consecutive same-speaker segments are merged. Exported so a reader locating
 * the segments behind a rendered line groups them exactly as the renderer did.
 * @param rowSpeaker - Speaker of the row being built
 * @param segment - The next segment
 */
export function continuesSpeakerRow(
	rowSpeaker: string | undefined,
	segment: TranscriptSegment,
): boolean {
	// Only merge a genuine speaker turn: without diarization every segment has
	// an undefined speaker, and merging them all would collapse the transcript
	// into one line and lose timestamps.
	return (
		segment.speaker !== undefined &&
		rowSpeaker === segment.speaker &&
		segment.text.length > 0
	);
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
			continuesSpeakerRow(previous.speaker, segment)
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
				? (values[name] ?? '')
				: '',
	);
	return substituted.replace(/[ \t]{2,}/g, ' ').trim();
}

/**
 * Neutralizes Obsidian wikilink/transclusion syntax in transcript content
 * before it is written into a note. Left raw, a `[[...]]` or `![[...]]` in
 * transcribed text would render as an unintended link or embed; escaping
 * the brackets keeps the literal text without linking.
 * @param text - Raw transcript text or speaker label
 */
function neutralizeWikilinks(text: string): string {
	return text.replace(/\[\[/g, '\\[\\[').replace(/\]\]/g, '\\]\\]');
}

/**
 * Reverses {@link neutralizeWikilinks}: turns text read back from a rendered
 * note line into the transcript text it was rendered from, so a segment
 * rebuilt from the note never carries the escaping twice.
 * @param text - Text as it appears in the note
 */
export function restoreWikilinks(text: string): string {
	return text.replace(/\\\[\\\[/g, '[[').replace(/\\\]\\\]/g, ']]');
}

/**
 * Renders the speaker fragment exactly as {@link formatTranscriptMarkdown}
 * does: the speaker template applied to the wikilink-neutralized label.
 * Exported so the rename flow can locate previously rendered speaker
 * fragments in a note and rewrite them without re-rendering the whole
 * transcript.
 * @param speakerFormat - Speaker template with a `{speaker}` token
 * @param speaker - Speaker display name
 */
export function renderSpeakerFragment(
	speakerFormat: string,
	speaker: string,
): string {
	return applyTemplate(speakerFormat, {
		speaker: neutralizeWikilinks(speaker),
	});
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
				? applyTemplate(options.speakerFormat, {
						speaker: neutralizeWikilinks(row.speaker),
					})
				: '';
		return applyTemplate(options.lineFormat, {
			timestamp,
			speaker,
			text: neutralizeWikilinks(row.text),
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
 * Where the parts of one rendered transcript line sit, as read back by
 * {@link parseTranscriptLine}.
 */
export interface ParsedTranscriptLine {
	/**
	 * The speaker text the line shows (wikilink-neutralized, exactly as
	 * rendered), or undefined when it shows none.
	 */
	speaker: string | undefined;
	/** Offset in the line where the spoken text starts. */
	textStart: number;
	/** Offset in the line just past the spoken text. */
	textEnd: number;
}

/**
 * A timecode as {@link renderTimecode} writes it: a wikilink, a Markdown link,
 * or the bare label, which is what the timestamp template's `{time}` holds.
 */
const RENDERED_TIME_PATTERN =
	'(?:!?\\[\\[[^\\]\\n]*\\]\\]|\\[[^\\]\\n]*\\]\\([^)\\n]*\\)|\\d+(?::\\d{2}){1,2})';

/**
 * Turns a template into a pattern: each `{token}` becomes the pattern given for
 * it (an unknown token rendered as nothing, so it matches nothing), literal
 * text is matched as written, and literal whitespace matches any run of spaces
 * including none - {@link applyTemplate} collapses and trims whitespace around
 * the fragments that came out empty, so the written line may carry less of it
 * than the template does.
 * @param template - Template with `{token}` placeholders
 * @param tokens - Pattern per token name
 */
function templatePattern(
	template: string,
	tokens: Record<string, string>,
): string {
	const literal = (text: string): string =>
		text
			.split(/[ \t]+/)
			.map(escapeRegExp)
			.join('[ \\t]*');
	// A Map, so a token named like an Object.prototype member is unknown.
	const lookup = new Map(Object.entries(tokens));
	let pattern = '';
	let last = 0;
	for (const match of template.matchAll(/\{(\w+)\}/g)) {
		pattern += literal(template.slice(last, match.index));
		pattern += lookup.get(String(match[1])) ?? '';
		last = match.index + match[0].length;
	}
	return pattern + literal(template.slice(last));
}

/**
 * Whether a template wraps its `{speaker}` token in literal characters (as
 * `**{speaker}**` or `{speaker}:` do). Only then can a speaker nobody listed be
 * told from the text beside it; a bare `{speaker}` is recognized by name alone.
 * @param speakerFormat - Speaker template
 */
function delimitsSpeaker(speakerFormat: string): boolean {
	return speakerFormat.replace(/\{speaker\}/g, '').trim().length > 0;
}

/**
 * Reads one Markdown line written by {@link formatTranscriptMarkdown} back into
 * its parts, using the same templates the line was written with: which speaker
 * it shows and where its spoken text sits. The inverse lives next to the
 * renderer so the two can never drift apart. Speakers are recognized by the
 * names given (longest first, so "Anna" never shadows "Anna Lee") and, when
 * the speaker template delimits its name, by that shape as well.
 * @param line - One rendered transcript line
 * @param options - The templates the line was written with
 * @param speakers - Speaker names the transcript is known to show
 * @returns The parts, or null when the line does not have the templates' shape
 *   or carries no text
 */
export function parseTranscriptLine(
	line: string,
	options: TranscriptMarkdownOptions,
	speakers: readonly string[],
): ParsedTranscriptLine | null {
	// Every row the renderer writes carries its timestamp, so a line without
	// one is not a transcript row, however much of it would pass as text.
	const timestamp = options.includeTimestamps
		? `(?:${templatePattern(options.timestampFormat, { time: RENDERED_TIME_PATTERN })})`
		: '';
	const names = [...new Set(speakers.filter((name) => name.length > 0))]
		.map(neutralizeWikilinks)
		.sort((a, b) => b.length - a.length)
		.map(escapeRegExp);
	if (delimitsSpeaker(options.speakerFormat)) {
		names.push('[^\\n]+?');
	}
	const speaker =
		options.includeSpeakers && names.length > 0
			? `(?:${templatePattern(options.speakerFormat, {
					speaker: `(?<speaker>${names.join('|')})`,
				})})?`
			: '';
	const pattern = templatePattern(options.lineFormat, {
		timestamp,
		speaker,
		text: '(?<text>.*?)',
	});
	const match = new RegExp(`^[ \\t]*${pattern}[ \\t]*$`, 'd').exec(line);
	const span = match?.indices?.groups?.text;
	if (!match || !span || span[0] === span[1]) {
		return null;
	}
	return {
		speaker: match.groups?.speaker,
		textStart: span[0],
		textEnd: span[1],
	};
}

/**
 * Serializes a transcript to the requested file format.
 * @param transcript - Source transcript
 * @param format - Target file format
 */
export function serializeTranscriptFile(
	transcript: Transcript,
	format: TranscriptFileFormat,
): string {
	switch (format) {
		case TranscriptFileFormat.Json:
			return JSON.stringify(transcript, null, 2);
		case TranscriptFileFormat.Srt:
			return toSrt(transcript);
		case TranscriptFileFormat.Vtt:
			return toVtt(transcript);
		case TranscriptFileFormat.Txt:
			return toPlainTextFile(transcript);
		default: {
			// Compile-time exhaustiveness: a new format becomes a type error
			// here instead of silently serializing to undefined at runtime.
			const exhaustive: never = format;
			throw new Error(
				`Unsupported transcript file format: ${String(exhaustive)}`,
			);
		}
	}
}

/**
 * Formats seconds as a subtitle timestamp `HH:MM:SS,mmm` (SRT) or
 * `HH:MM:SS.mmm` (VTT).
 */
function formatSubtitleTime(seconds: number, millisSep: string): string {
	// Decompose from a single rounded millisecond total so rounding can never
	// leave the millis field at 1000 (which a separate floor of seconds would
	// produce, e.g. 12.9996 -> "00:00:12,1000").
	const totalMillis = Math.round(Math.max(0, seconds) * 1000);
	const millis = totalMillis % 1000;
	const totalSecs = Math.floor(totalMillis / 1000);
	const hours = Math.floor(totalSecs / 3600);
	const minutes = Math.floor((totalSecs % 3600) / 60);
	const secs = totalSecs % 60;
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
