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
 * Shortest chapter the validator accepts on a full-length recording.
 * Generated chapters closer than the enforced gap to the previous kept one
 * are dropped, so the model cannot produce a run of one- or two-second
 * chapters. Scaled down for very short recordings by
 * {@link minChapterSecondsFor} so a short clip is not over-constrained.
 */
export const MIN_CHAPTER_SECONDS = 20;

/**
 * The minimum spacing enforced between generated chapters for a recording of
 * the given length. It is {@link MIN_CHAPTER_SECONDS} on a normal recording,
 * relaxed for a short one (never more than a sixth of the length) so a brief
 * clip can still have a few chapters, and it falls back to the near-duplicate
 * tolerance when the length is unknown.
 * @param durationSeconds - Recording length, or null when unknown
 * @returns Minimum seconds between two kept chapters
 */
export function minChapterSecondsFor(durationSeconds: number | null): number {
	if (!durationSeconds || durationSeconds <= 0) {
		return DUPLICATE_TIME_TOLERANCE_SECONDS;
	}
	return Math.max(
		DUPLICATE_TIME_TOLERANCE_SECONDS,
		Math.min(MIN_CHAPTER_SECONDS, durationSeconds / 6),
	);
}

/**
 * Base system instruction for the chapter-generation request. The response
 * contract is strict JSON so the output can be validated instead of trusted.
 */
const CHAPTER_SYSTEM_PROMPT =
	'You are an expert editor that divides an audio recording into chapters. ' +
	'You receive the transcript as timestamped lines; each line begins with a ' +
	'[h:mm:ss] or [m:ss] timecode that marks the moment that line is spoken. ' +
	'A chapter is a contiguous span of the recording about one topic. A ' +
	'chapter STARTS at the timecode of the first line where that topic begins, ' +
	'and it ENDS where the next chapter starts; the final chapter ends at the ' +
	'end of the recording. Determine the starts like this: read the transcript ' +
	'in order and, whenever the subject clearly shifts to a new topic, begin a ' +
	'new chapter at the timecode of the line that opens it. Convert each ' +
	'timecode to whole seconds, where the part before the colon is minutes: ' +
	'[0:45] is 45, [12:25] is 745 (not 12), and [1:03:00] is 3780. Rules you ' +
	'must obey: the first chapter starts at 0; the start times strictly ' +
	'increase; every start equals the timecode of a real transcript line; the ' +
	'chapters are spread across the whole recording, never bunched at the ' +
	'start; each chapter is a substantial span, never only a few seconds long; ' +
	'use between 3 and 12 chapters, fewer for a short recording; titles are ' +
	'concise (under 60 characters) and describe the topic. Output: return ONLY ' +
	'a JSON array and nothing else, with no prose, no code fences, and no ' +
	'comments; each element is exactly {"time": <start in whole seconds>, ' +
	'"title": "<title>"}.';

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
 * Builds the user-supplied guidance clause appended to the base prompt so a
 * chapter profile can steer HOW the recording is divided. The base rules and
 * the JSON contract stay fixed and precede this, so guidance can shape the
 * chaptering without being able to break the response format. Empty or
 * whitespace-only guidance appends nothing.
 * @param guidance - Selected profile's guidance text, when any
 */
function chapterGuidanceClause(guidance?: string): string {
	const text = guidance?.trim();
	return text
		? ` Additional guidance on how to divide this recording into chapters: ${text}`
		: '';
}

/**
 * Builds the clause that grounds the model in the recording's real length,
 * so it spreads chapters across the whole timeline and keeps each one at
 * least the enforced minimum long rather than bunching several into the
 * opening seconds. Appended only when the duration is known.
 * @param durationSeconds - Recording length, when known
 */
function recordingLengthClause(durationSeconds?: number): string {
	if (!durationSeconds || durationSeconds <= 0) {
		return '';
	}
	const total = Math.round(durationSeconds);
	const minGap = Math.round(minChapterSecondsFor(durationSeconds));
	return (
		` The recording is ${formatTimecode(total)} long (${String(total)} ` +
		`seconds); place chapters across this whole span and make each at ` +
		`least about ${String(minGap)} seconds long.`
	);
}

/**
 * Builds the provider-neutral chapter-generation prompt from timed
 * transcript lines. Every line is prefixed with its timecode, rendered at
 * a uniform width against the last line's time so the model sees a
 * consistent format to convert back to seconds.
 * @param lines - Timed transcript lines, ascending by time
 * @param options - Optional language for the title-language clause, optional
 *   user guidance for how to divide the chapters, and the recording length
 *   used to keep chapters spread out and long enough
 * @returns System + user prompt
 */
export function buildChapterPrompt(
	lines: readonly TimedLine[],
	options: {
		language?: string;
		guidance?: string;
		durationSeconds?: number;
	} = {},
): LlmPrompt {
	const reference = lines.length
		? Math.max(...lines.map((line) => line.time))
		: 0;
	const body = lines
		.map((line) => `[${formatTimecode(line.time, reference)}] ${line.text}`)
		.join('\n');
	return {
		system:
			CHAPTER_SYSTEM_PROMPT +
			recordingLengthClause(options.durationSeconds) +
			chapterGuidanceClause(options.guidance) +
			titleLanguageClause(options.language),
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
 * Snaps a time to the nearest value in `times`, so a chapter start lands on a
 * real transcript line rather than a position the model invented between
 * lines. Returns the time unchanged when no snap targets are given.
 * @param time - Proposed chapter start in seconds
 * @param times - Sorted transcript line start times to snap to
 * @returns The nearest line time, or the input when `times` is empty
 */
function snapToNearestTime(time: number, times: readonly number[]): number {
	if (times.length === 0) {
		return time;
	}
	let best = times[0] as number;
	let bestDelta = Math.abs(time - best);
	for (const candidate of times) {
		const delta = Math.abs(time - candidate);
		if (delta < bestDelta) {
			best = candidate;
			bestDelta = delta;
		}
	}
	return best;
}

/**
 * Parses and validates an LLM chapter response. This is the trust
 * boundary for model output: entries that are not objects, carry an
 * unreadable time, or have an empty title are dropped; negative times are
 * clamped to 0; times past the known end of the recording are clamped
 * within a small slack and discarded beyond it (the model may not invent
 * positions); every accepted start is snapped to the nearest real transcript
 * line so boundaries are grounded in the transcript, not the model's
 * arithmetic; titles are truncated to a sane length; the result is sorted and
 * boundaries closer than the minimum gap collapse to the first occurrence. An
 * unparseable response yields an empty list rather than a throw, so the
 * caller reports "no usable chapters" instead of a raw JSON error.
 *
 * The minimum-gap check is the real guard on chapter length: after the model
 * output is bounded and sorted, a chapter closer than `minGapSeconds` to the
 * previous kept one is dropped, so a model that bunches several chapters into
 * a few seconds cannot produce a run of one-second chapters. It defaults to
 * the near-duplicate tolerance so existing callers keep collapsing only true
 * duplicates.
 * @param output - Raw model output
 * @param maxTimeSeconds - Recording length bound, or null when unknown
 * @param minGapSeconds - Minimum spacing between two kept chapters
 * @param snapTimes - Real transcript line start times to snap starts onto
 * @returns Valid chapters sorted by time ascending
 */
export function parseChapterResponse(
	output: string,
	maxTimeSeconds: number | null,
	minGapSeconds: number = DUPLICATE_TIME_TOLERANCE_SECONDS,
	snapTimes: readonly number[] = [],
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
		// Ground the start on a real transcript line instead of trusting the
		// model's exact number, which is often between lines or slightly off.
		candidates.push({ time: snapToNearestTime(clamped, snapTimes), title });
	}
	candidates.sort((a, b) => a.time - b.time);
	const gap = Math.max(DUPLICATE_TIME_TOLERANCE_SECONDS, minGapSeconds);
	const result: GeneratedChapter[] = [];
	for (const candidate of candidates) {
		const previous = result[result.length - 1];
		if (previous && candidate.time - previous.time < gap) {
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
