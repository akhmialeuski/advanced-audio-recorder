/**
 * Pure logic for LLM-generated chapters: building the prompt from timed
 * transcript lines, parsing and validating the model's response, and
 * merging the resulting chapters into a recording's existing marker list.
 * Everything here is free of Obsidian, DOM, and network dependencies so
 * the prompt shape, the tolerant response parser, and the merge semantics
 * are unit tested directly.
 * @module chapters/chapterGeneration
 */

import type { LlmPrompt } from '../transcription/llmPostProcess';
import {
	MARKER_KIND,
	sortMarkers,
	type PlayerMarker,
} from '../markers/markerModel';
import { formatTimecode, parseTimecode } from '../utils/TimeUtils';

/** One transcript line with its start offset, the LLM's raw material. */
export interface TimedLine {
	/** Start offset in seconds from the beginning of the audio. */
	time: number;
	/** The line's text (speaker prefix included when known). */
	text: string;
}

/** One chapter proposed by the LLM, validated and ready to become a marker. */
export interface GeneratedChapter {
	/** Start offset in seconds. */
	time: number;
	/** Short chapter title. */
	title: string;
}

/**
 * Id prefix stamped on every generated chapter marker. Regenerating
 * chapters replaces only markers carrying this prefix, so bookmarks and
 * manually created chapters are never touched by a re-run.
 */
export const AUTO_CHAPTER_ID_PREFIX = 'auto-chapter-';

/** Whether a marker id belongs to a generated (auto) chapter. */
export function isAutoChapterId(id: string): boolean {
	return id.startsWith(AUTO_CHAPTER_ID_PREFIX);
}

/**
 * Two chapter times closer than this are considered the same boundary:
 * duplicates in the LLM output collapse, and a generated chapter this close
 * to a manually created one is dropped rather than doubled.
 */
const DUPLICATE_TIME_TOLERANCE_SECONDS = 1;

/**
 * Slack past the last known transcript time within which a proposed
 * chapter is clamped instead of discarded, absorbing small rounding in
 * the model's output without accepting invented positions.
 */
const MAX_TIME_SLACK_SECONDS = 1;

/** Longest accepted chapter title; longer output is truncated. */
const MAX_TITLE_LENGTH = 120;

/**
 * Base system instruction for the chapter-generation request. The response
 * contract is strict JSON so the output can be validated instead of trusted.
 */
const CHAPTER_SYSTEM_PROMPT =
	'You are an expert editor dividing an audio recording into chapters. ' +
	'You are given its transcript; every line starts with a [h:mm:ss] or ' +
	'[m:ss] timecode marking where that line begins. Identify the major ' +
	'topic changes and return the chapters as a JSON array of objects, ' +
	'each {"time": <chapter start offset in seconds>, "title": "<short ' +
	'title>"}. Rules: derive every time from the timecodes shown (convert ' +
	'them to plain seconds); the first chapter starts at 0; use between 3 ' +
	'and 12 chapters, fewer for short recordings; keep titles concise ' +
	'(under 60 characters) and descriptive. Return ONLY the JSON array ' +
	'with no other text, no code fences, and no comments.';

/**
 * Builds the language clause appended to the system prompt so titles come
 * out in the transcript's language rather than defaulting to English.
 * @param language - Detected/declared language, when known
 */
function titleLanguageClause(language?: string): string {
	return language
		? ` The transcript language is ${language}; write the titles in that same language.`
		: ' Write the titles in the same language as the transcript.';
}

/**
 * Builds the provider-neutral chapter-generation prompt from timed
 * transcript lines. Every line is prefixed with its timecode, rendered at
 * a uniform width against the last line's time so the model sees a
 * consistent format to convert back to seconds.
 * @param lines - Timed transcript lines, ascending by time
 * @param options - Optional language for the title-language clause
 * @returns System + user prompt
 */
export function buildChapterPrompt(
	lines: readonly TimedLine[],
	options: { language?: string } = {},
): LlmPrompt {
	const reference = lines.length
		? Math.max(...lines.map((line) => line.time))
		: 0;
	const body = lines
		.map((line) => `[${formatTimecode(line.time, reference)}] ${line.text}`)
		.join('\n');
	return {
		system: CHAPTER_SYSTEM_PROMPT + titleLanguageClause(options.language),
		user: body,
	};
}

/**
 * Reads a chapter time out of one raw entry: a plain number of seconds, a
 * numeric string, or a "h:mm:ss"/"m:ss" timecode string (models often
 * return the timecode format they were shown despite instructions).
 * @param value - Raw `time` value from the parsed response
 * @returns Seconds, or null when unreadable
 */
function readChapterTime(value: unknown): number | null {
	if (typeof value === 'number' && Number.isFinite(value)) {
		return value;
	}
	if (typeof value === 'string') {
		return parseTimecode(value);
	}
	return null;
}

/**
 * Extracts the JSON array text from a raw LLM response, tolerating code
 * fences and surrounding prose: the substring from the first `[` to the
 * last `]` is taken, which covers "Here are the chapters: [...]" replies.
 * @param output - Raw model output
 * @returns Candidate JSON text, or null when no array brackets exist
 */
function extractJsonArrayText(output: string): string | null {
	const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(output);
	const candidate = fenced?.[1] ?? output;
	const start = candidate.indexOf('[');
	const end = candidate.lastIndexOf(']');
	if (start === -1 || end <= start) {
		return null;
	}
	return candidate.slice(start, end + 1);
}

/**
 * Parses and validates an LLM chapter response. This is the trust
 * boundary for model output: entries that are not objects, carry an
 * unreadable time, or have an empty title are dropped; negative times are
 * clamped to 0; times past the known end of the transcript are clamped
 * within a small slack and discarded beyond it (the model may not invent
 * positions); titles are truncated to a sane length; the result is sorted
 * and near-duplicate boundaries collapse to the first occurrence. An
 * unparseable response yields an empty list rather than a throw, so the
 * caller reports "no usable chapters" instead of a raw JSON error.
 * @param output - Raw model output
 * @param maxTimeSeconds - Last known transcript time, or null when unknown
 * @returns Valid chapters sorted by time ascending
 */
export function parseChapterResponse(
	output: string,
	maxTimeSeconds: number | null,
): GeneratedChapter[] {
	const jsonText = extractJsonArrayText(output);
	if (jsonText === null) {
		return [];
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(jsonText);
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) {
		return [];
	}
	const candidates: GeneratedChapter[] = [];
	for (const entry of parsed) {
		if (typeof entry !== 'object' || entry === null) {
			continue;
		}
		const record = entry as Record<string, unknown>;
		const time = readChapterTime(record.time);
		const rawTitle = record.title;
		if (time === null || typeof rawTitle !== 'string') {
			continue;
		}
		const title = rawTitle.trim().slice(0, MAX_TITLE_LENGTH);
		if (!title) {
			continue;
		}
		let clamped = Math.max(0, time);
		if (maxTimeSeconds !== null) {
			if (clamped > maxTimeSeconds + MAX_TIME_SLACK_SECONDS) {
				continue;
			}
			clamped = Math.min(clamped, maxTimeSeconds);
		}
		candidates.push({ time: clamped, title });
	}
	candidates.sort((a, b) => a.time - b.time);
	const result: GeneratedChapter[] = [];
	for (const candidate of candidates) {
		const previous = result[result.length - 1];
		if (
			previous &&
			candidate.time - previous.time < DUPLICATE_TIME_TOLERANCE_SECONDS
		) {
			continue;
		}
		result.push(candidate);
	}
	return result;
}

/**
 * Merges generated chapters into a recording's marker list. Previously
 * generated chapters (recognized by their id prefix) are replaced;
 * bookmarks and manually created chapters are kept untouched, and a
 * generated chapter landing within the duplicate tolerance of a kept
 * chapter is dropped so a boundary the user already marked is not doubled.
 * @param existing - The recording's current markers
 * @param generated - Validated chapters from the LLM
 * @param createId - Id generator for the new markers (unprefixed part)
 * @returns New, time-sorted marker list
 */
export function applyGeneratedChapters(
	existing: readonly PlayerMarker[],
	generated: readonly GeneratedChapter[],
	createId: () => string,
): PlayerMarker[] {
	const kept = existing.filter((marker) => !isAutoChapterId(marker.id));
	const keptChapterTimes = kept
		.filter((marker) => marker.kind === MARKER_KIND.chapter)
		.map((marker) => marker.time);
	const added: PlayerMarker[] = [];
	for (const chapter of generated) {
		const collides = keptChapterTimes.some(
			(time) =>
				Math.abs(time - chapter.time) <
				DUPLICATE_TIME_TOLERANCE_SECONDS,
		);
		if (collides) {
			continue;
		}
		added.push({
			id: `${AUTO_CHAPTER_ID_PREFIX}${createId()}`,
			time: chapter.time,
			label: chapter.title,
			kind: MARKER_KIND.chapter,
		});
	}
	return sortMarkers([...kept, ...added]);
}
