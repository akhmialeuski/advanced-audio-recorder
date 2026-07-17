/**
 * Pure rewriting of speaker names inside already-written transcript
 * outputs: note Markdown (rendered speaker fragments), SRT/VTT subtitle
 * bodies, plain-text transcripts, and transcript JSON sidecars. All
 * replacements within one document happen simultaneously, so swapping two
 * names (A -> B while B -> A) can never chain one rename through another.
 * No DOM or I/O - everything here is unit tested directly.
 * @module speakers/transcriptRewrite
 */

import { renderSpeakerFragment } from '../transcription/transcriptFormat';
import type { SpeakerRename } from './speakerNameModel';

/** Escapes a literal string for embedding in a RegExp. */
function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Builds a longest-first alternation of the mapped keys, so a name that
 * is a prefix of another ("Anna" / "Anna Lee") can never shadow the
 * longer match.
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
 * Rewrites rendered speaker fragments in note Markdown. Each rename is
 * matched as the fully rendered fragment (the speaker template applied to
 * the old name, e.g. `**Speaker 1**`), so ordinary prose mentioning a
 * name is only touched when it looks exactly like a rendered speaker
 * label.
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
	const fragments = new Map<string, string>();
	for (const rename of renameMap(renames)) {
		const [from, to] = rename;
		const fromFragment = renderSpeakerFragment(speakerFormat, from);
		const toFragment = renderSpeakerFragment(speakerFormat, to);
		if (fromFragment && fromFragment !== toFragment) {
			fragments.set(fromFragment, toFragment);
		}
	}
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
 * Rewrites `[time] Speaker: ` prefixes in plain-text transcripts, anchored
 * to the timecode that starts each line so names inside spoken text are
 * left alone.
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
	if (map.size === 0) {
		return raw;
	}
	const document = parsed as Record<string, unknown>;
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
	const speakers: string[] = [];
	const seen = new Set<string>();
	for (const entry of segments) {
		if (typeof entry !== 'object' || entry === null) {
			continue;
		}
		const speaker = (entry as Record<string, unknown>).speaker;
		if (typeof speaker === 'string' && !seen.has(speaker)) {
			seen.add(speaker);
			speakers.push(speaker);
		}
	}
	// Preserve the original key layout: only segments (and, when present,
	// the derived speaker list) change.
	const output: Record<string, unknown> = {
		...document,
		segments,
		...(Array.isArray(document.speakers) ? { speakers } : {}),
	};
	return JSON.stringify(output, null, 2);
}
