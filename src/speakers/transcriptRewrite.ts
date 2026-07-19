/**
 * Pure rewriting and reading of speaker names inside already-written
 * transcript outputs: note Markdown (rendered speaker fragments), SRT/VTT
 * subtitle bodies, plain-text transcripts, and transcript JSON sidecars. Note
 * rewriting is line-scoped, so only the lines that belong to a given
 * recording (identified by the caller through their timecode link) are
 * touched, which keeps a second transcript in the same note untouched. All
 * replacements within one document happen simultaneously, so swapping two
 * names (A -> B while B -> A) can never chain. No DOM or I/O; unit tested
 * directly.
 * @module speakers/transcriptRewrite
 */

import { renderSpeakerFragment } from '../transcription/transcriptFormat';
import type { SpeakerRename } from './speakerRename';

/** Escapes a literal string for embedding in a RegExp. */
function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Builds a longest-first alternation of the given keys, so a name that is a
 * prefix of another ("Anna" / "Anna Lee") can never shadow the longer match.
 */
function alternation(keys: Iterable<string>): string {
	return [...keys]
		.sort((a, b) => b.length - a.length)
		.map(escapeRegExp)
		.join('|');
}

/** Builds the simultaneous from -> to lookup, dropping no-op renames. */
function renameMap(renames: readonly SpeakerRename[]): Map<string, string> {
	const map = new Map<string, string>();
	for (const rename of renames) {
		if (rename.from && rename.from !== rename.to) {
			map.set(rename.from, rename.to);
		}
	}
	return map;
}

/**
 * Maps each rename onto its fully rendered speaker fragment (the speaker
 * template applied to the name, e.g. `**Speaker 1**`), so ordinary prose is
 * only touched when it looks exactly like a rendered speaker label.
 */
function fragmentMap(
	speakerFormat: string,
	renames: readonly SpeakerRename[],
): Map<string, string> {
	const fragments = new Map<string, string>();
	for (const [from, to] of renameMap(renames)) {
		const fromFragment = renderSpeakerFragment(speakerFormat, from);
		const toFragment = renderSpeakerFragment(speakerFormat, to);
		if (fromFragment && fromFragment !== toFragment) {
			fragments.set(fromFragment, toFragment);
		}
	}
	return fragments;
}

/**
 * Rewrites rendered speaker fragments in note Markdown, but only on the lines
 * the caller marks as belonging to this recording (the lines whose timecode
 * link resolves to the audio). A second transcript in the same note, and any
 * prose that merely looks like a speaker label, is left untouched.
 * @param content - Note Markdown
 * @param speakerFormat - Speaker template the transcript was rendered with
 * @param renames - Display-name renames to apply
 * @param audioLines - Zero-based indices of lines that belong to the audio
 * @returns The rewritten content (unchanged when nothing matched)
 */
export function renameSpeakersInNoteLines(
	content: string,
	speakerFormat: string,
	renames: readonly SpeakerRename[],
	audioLines: ReadonlySet<number>,
): string {
	const fragments = fragmentMap(speakerFormat, renames);
	if (fragments.size === 0 || audioLines.size === 0) {
		return content;
	}
	const regex = new RegExp(alternation(fragments.keys()), 'g');
	const lines = content.split('\n');
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		if (line !== undefined && audioLines.has(index)) {
			lines[index] = line.replace(
				regex,
				(match) => fragments.get(match) ?? match,
			);
		}
	}
	return lines.join('\n');
}

/**
 * Rewrites rendered speaker fragments across the whole note, used only after
 * the user confirms a rename on a transcript that carries no timecode links
 * and therefore cannot be scoped to a single recording.
 * @param content - Note Markdown
 * @param speakerFormat - Speaker template the transcript was rendered with
 * @param renames - Display-name renames to apply
 * @returns The rewritten content (unchanged when nothing matched)
 */
export function renameSpeakersInMarkdown(
	content: string,
	speakerFormat: string,
	renames: readonly SpeakerRename[],
): string {
	const fragments = fragmentMap(speakerFormat, renames);
	if (fragments.size === 0) {
		return content;
	}
	const regex = new RegExp(alternation(fragments.keys()), 'g');
	return content.replace(regex, (match) => fragments.get(match) ?? match);
}

/**
 * Rewrites `Speaker: ` prefixes in SRT/VTT subtitle bodies. The prefix is
 * anchored to the start of a cue text line, matching how the serializer
 * writes it, so speaker names inside spoken text are left alone.
 * @param content - SRT or VTT file content
 * @param renames - Display-name renames to apply
 * @returns The rewritten content (unchanged when nothing matched)
 */
export function renameSpeakersInSubtitles(
	content: string,
	renames: readonly SpeakerRename[],
): string {
	const map = renameMap(renames);
	if (map.size === 0) {
		return content;
	}
	const regex = new RegExp(`^(${alternation(map.keys())}): `, 'gm');
	return content.replace(
		regex,
		(_match, name: string) => `${map.get(name) ?? name}: `,
	);
}

/**
 * Rewrites `[time] Speaker: ` prefixes in plain-text transcripts, anchored to
 * the timecode that starts each line so names inside spoken text are left
 * alone.
 * @param content - Plain-text transcript content
 * @param renames - Display-name renames to apply
 * @returns The rewritten content (unchanged when nothing matched)
 */
export function renameSpeakersInPlainText(
	content: string,
	renames: readonly SpeakerRename[],
): string {
	const map = renameMap(renames);
	if (map.size === 0) {
		return content;
	}
	const regex = new RegExp(
		`^(\\[[^\\]\\n]*\\] )(${alternation(map.keys())}): `,
		'gm',
	);
	return content.replace(
		regex,
		(_match, prefix: string, name: string) =>
			`${prefix}${map.get(name) ?? name}: `,
	);
}

/**
 * Rewrites the speaker fields of a transcript JSON sidecar, renaming each
 * segment's speaker and re-deriving the speaker list. The document is
 * re-serialized with the same indentation the writer uses.
 * @param raw - Raw JSON sidecar content
 * @param renames - Display-name renames to apply
 * @returns The rewritten JSON, or null when the content is not a
 * transcript-shaped JSON document
 */
export function renameSpeakersInTranscriptJson(
	raw: string,
	renames: readonly SpeakerRename[],
): string | null {
	const map = renameMap(renames);
	const document = parseTranscriptJson(raw);
	if (!document) {
		return null;
	}
	if (map.size === 0) {
		return raw;
	}
	// Entries are handled defensively (a sidecar can be hand-edited): only
	// object segments with a mapped string speaker are rewritten, everything
	// else passes through untouched.
	const segments = (document.segments as unknown[]).map((entry) => {
		if (typeof entry !== 'object' || entry === null) {
			return entry;
		}
		const record = entry as Record<string, unknown>;
		const speaker = record.speaker;
		if (typeof speaker === 'string' && map.has(speaker)) {
			return { ...record, speaker: map.get(speaker) };
		}
		return entry;
	});
	// Preserve the original key layout: only segments (and, when present, the
	// derived speaker list) change.
	const output: Record<string, unknown> = {
		...document,
		segments,
		...(Array.isArray(document.speakers)
			? { speakers: distinctSegmentSpeakers(segments) }
			: {}),
	};
	return JSON.stringify(output, null, 2);
}

/** The render templates a note's transcript lines were produced with. */
export interface NoteSpeakerTemplates {
	/** Arrangement of `{timestamp}`, `{speaker}`, and `{text}` on each line. */
	lineFormat: string;
	/** Speaker template with a `{speaker}` token. */
	speakerFormat: string;
	/** Whether a timestamp fragment was written on each line. */
	includeTimestamps: boolean;
}

/**
 * ASCII sentinels standing in for the render tokens while rebuilding the line.
 * They carry no whitespace, so they survive the collapse and trim, and are
 * distinctive enough not to occur inside a real line template.
 */
const RENDER_TOKEN = {
	timestamp: '@@aar-render-timestamp@@',
	speaker: '@@aar-render-speaker@@',
	text: '@@aar-render-text@@',
} as const;

/** Splits a structural line on the render-token sentinels, keeping them. */
const RENDER_TOKEN_SPLIT = /(@@aar-render-(?:timestamp|speaker|text)@@)/;

/** Escapes a literal template fragment, matching whitespace runs loosely. */
function literalToPattern(literal: string): string {
	return literal
		.split(/\s+/)
		.map((part) => escapeRegExp(part))
		.join('\\s+');
}

/** Splits a speaker template into the text around its `{speaker}` token. */
function speakerDelimiters(
	speakerFormat: string,
): { before: string; after: string } | null {
	const token = '{speaker}';
	const index = speakerFormat.indexOf(token);
	if (index < 0) {
		return null;
	}
	return {
		before: speakerFormat.slice(0, index),
		after: speakerFormat.slice(index + token.length),
	};
}

/**
 * Builds a per-line regex that captures the speaker name exactly where the
 * line template renders it, reconstructed from the same templates that wrote
 * the note. The timestamp and text slots become bounded wildcards and the
 * speaker slot a lazy capture, so the speaker is read from its rendered
 * position rather than by guessing at delimiters, which fixes both one-sided
 * speaker templates (`{speaker}:`) and lookalike bold text elsewhere on the
 * line. Returns null when the speaker cannot be located reliably: no
 * `{speaker}` token at all, or a right boundary that is only whitespace or the
 * line end, where a multi-word label like `Speaker 1` cannot be delimited (the
 * dialog then reports rather than guessing a partial name).
 * @param templates - The line, speaker, and timestamp render settings
 */
export function buildNoteLineSpeakerExtractor(
	templates: NoteSpeakerTemplates,
): RegExp | null {
	const delimiters = speakerDelimiters(templates.speakerFormat);
	if (!delimiters) {
		return null;
	}
	// Rebuild the rendered line structurally: drop the timestamp token when it
	// is not written, then apply the same whitespace collapse and trim
	// formatTranscriptMarkdown does, so the pattern matches the line as
	// rendered even when a leading empty token removed its separator.
	const structural = templates.lineFormat
		.replace(
			/\{timestamp\}/g,
			templates.includeTimestamps ? RENDER_TOKEN.timestamp : '',
		)
		.replace(/\{speaker\}/g, RENDER_TOKEN.speaker)
		.replace(/\{text\}/g, RENDER_TOKEN.text)
		.replace(/[ \t]{2,}/g, ' ')
		.trim();
	const speakerAt = structural.indexOf(RENDER_TOKEN.speaker);
	if (speakerAt < 0) {
		return null;
	}
	// The name is delimited on the right by the speaker template's own trailing
	// text plus the line literal up to the next token. If that is only
	// whitespace (or the line end), a multi-word label cannot be bounded.
	const afterSpeaker = structural.slice(
		speakerAt + RENDER_TOKEN.speaker.length,
	);
	const followingLiteral = afterSpeaker.split(RENDER_TOKEN_SPLIT)[0] ?? '';
	if (`${delimiters.after}${followingLiteral}`.trim() === '') {
		return null;
	}
	const speakerPattern = `${literalToPattern(
		delimiters.before,
	)}(.+?)${literalToPattern(delimiters.after)}`;
	let pattern = '^';
	for (const part of structural.split(RENDER_TOKEN_SPLIT)) {
		if (part === RENDER_TOKEN.timestamp) {
			pattern += '.*?';
		} else if (part === RENDER_TOKEN.speaker) {
			pattern += speakerPattern;
		} else if (part === RENDER_TOKEN.text) {
			pattern += '.*';
		} else if (part) {
			pattern += literalToPattern(part);
		}
	}
	pattern += '$';
	return new RegExp(pattern);
}

/**
 * Collects the distinct speaker names rendered on the note lines that belong
 * to a recording, so the rename dialog can list the current speakers without
 * any stored roster. Each line is parsed once with the reconstructed line
 * pattern, so only the speaker slot is read and lookalike text elsewhere on
 * the line is ignored. Passing null for the line set scans the whole note,
 * used for a transcript without timecode links that cannot be scoped. Empty
 * when the speaker cannot be located reliably for the given templates.
 * @param content - Note Markdown
 * @param templates - The templates the transcript was rendered with
 * @param audioLines - Zero-based indices of lines that belong to the audio, or
 *   null to scan every line
 * @returns Distinct speaker names in first-seen order
 */
export function extractNoteSpeakers(
	content: string,
	templates: NoteSpeakerTemplates,
	audioLines: ReadonlySet<number> | null,
): string[] {
	const extractor = buildNoteLineSpeakerExtractor(templates);
	if (!extractor) {
		return [];
	}
	const speakers = new OrderedSet();
	const lines = content.split('\n');
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		if (
			line === undefined ||
			(audioLines !== null && !audioLines.has(index))
		) {
			continue;
		}
		const name = extractor.exec(line)?.[1]?.trim();
		if (name) {
			speakers.add(name);
		}
	}
	return speakers.values();
}

/**
 * Collects the distinct speaker names from an SRT/VTT subtitle body by reading
 * the `Speaker: ` prefix off each cue text line (the line after a `-->` timing
 * line).
 * @param content - SRT or VTT file content
 * @returns Distinct speaker names in first-seen order
 */
export function extractSubtitleSpeakers(content: string): string[] {
	const speakers = new OrderedSet();
	const lines = content.split('\n');
	for (let index = 0; index < lines.length; index++) {
		if (!(lines[index] ?? '').includes(' --> ')) {
			continue;
		}
		const match = /^([^:\n]+): /.exec(lines[index + 1] ?? '');
		if (match?.[1]) {
			speakers.add(match[1]);
		}
	}
	return speakers.values();
}

/**
 * Collects the distinct speaker names from a plain-text transcript by reading
 * the `[time] Speaker: ` prefix off each line.
 * @param content - Plain-text transcript content
 * @returns Distinct speaker names in first-seen order
 */
export function extractPlainTextSpeakers(content: string): string[] {
	const speakers = new OrderedSet();
	for (const line of content.split('\n')) {
		const match = /^\[[^\]\n]*\] ([^:\n]+): /.exec(line);
		if (match?.[1]) {
			speakers.add(match[1]);
		}
	}
	return speakers.values();
}

/**
 * Collects the distinct speaker names from a transcript JSON sidecar, or null
 * when the content is not a transcript-shaped document.
 * @param raw - Raw JSON sidecar content
 * @returns Distinct speaker names, or null when not a transcript JSON
 */
export function extractJsonSpeakers(raw: string): string[] | null {
	const document = parseTranscriptJson(raw);
	if (!document) {
		return null;
	}
	return distinctSegmentSpeakers(document.segments as unknown[]);
}

/**
 * Parses raw JSON and returns it only when it is a transcript-shaped document
 * (an object with a `segments` array), otherwise null.
 */
function parseTranscriptJson(raw: string): Record<string, unknown> | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (
		typeof parsed !== 'object' ||
		parsed === null ||
		!Array.isArray((parsed as { segments?: unknown }).segments)
	) {
		return null;
	}
	return parsed as Record<string, unknown>;
}

/** Distinct string speakers across segments, in first-seen order. */
function distinctSegmentSpeakers(segments: readonly unknown[]): string[] {
	const speakers = new OrderedSet();
	for (const entry of segments) {
		if (typeof entry !== 'object' || entry === null) {
			continue;
		}
		const speaker = (entry as Record<string, unknown>).speaker;
		if (typeof speaker === 'string') {
			speakers.add(speaker);
		}
	}
	return speakers.values();
}

/** Small insertion-ordered de-duplicating string collector. */
class OrderedSet {
	private readonly seen = new Set<string>();
	private readonly order: string[] = [];
	add(value: string): void {
		if (!this.seen.has(value)) {
			this.seen.add(value);
			this.order.push(value);
		}
	}
	values(): string[] {
		return [...this.order];
	}
}
