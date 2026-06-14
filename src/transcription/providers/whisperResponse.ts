/**
 * Pure mapping of an OpenAI-compatible Whisper `verbose_json` response
 * into the plugin's transcript segment model. Tolerant of missing or
 * malformed fields so a surprising provider response degrades to "best
 * available" rather than throwing.
 * @module transcription/providers/whisperResponse
 */

import type { TranscriptSegment, TranscriptWord } from '../TranscriptTypes';

/** Parsed result of one transcription request. */
export interface WhisperResult {
	language?: string;
	segments: TranscriptSegment[];
}

/**
 * Coerces an unknown value to a finite number, or returns the fallback.
 */
function num(value: unknown, fallback = 0): number {
	return typeof value === 'number' && Number.isFinite(value)
		? value
		: fallback;
}

/**
 * Maps word entries (OpenAI uses `word`, some providers use `text`).
 */
function mapWords(value: unknown): TranscriptWord[] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}
	const words: TranscriptWord[] = [];
	for (const entry of value) {
		if (typeof entry !== 'object' || entry === null) {
			continue;
		}
		const record = entry as Record<string, unknown>;
		const text = record.word ?? record.text;
		if (typeof text !== 'string') {
			continue;
		}
		words.push({
			text: text.trim(),
			start: num(record.start),
			end: num(record.end),
		});
	}
	return words.length > 0 ? words : undefined;
}

/**
 * Maps a Whisper `verbose_json` response (or a compatible shape) to a
 * WhisperResult. Falls back to a single segment built from the top-level
 * `text` when no segment array is present.
 * @param body - Parsed JSON response body
 */
export function mapWhisperResponse(body: unknown): WhisperResult {
	if (typeof body !== 'object' || body === null) {
		return { segments: [] };
	}
	const record = body as Record<string, unknown>;
	const language =
		typeof record.language === 'string' ? record.language : undefined;

	const rawSegments = record.segments;
	if (Array.isArray(rawSegments) && rawSegments.length > 0) {
		const segments: TranscriptSegment[] = [];
		for (const entry of rawSegments) {
			if (typeof entry !== 'object' || entry === null) {
				continue;
			}
			const seg = entry as Record<string, unknown>;
			const text = typeof seg.text === 'string' ? seg.text.trim() : '';
			if (text === '') {
				continue;
			}
			const speaker =
				typeof seg.speaker === 'string' ? seg.speaker : undefined;
			const words = mapWords(seg.words);
			segments.push({
				start: num(seg.start),
				end: num(seg.end, num(seg.start)),
				text,
				...(speaker ? { speaker } : {}),
				...(words ? { words } : {}),
			});
		}
		return { language, segments };
	}

	// No segment array: fall back to the flat transcript text.
	const text = typeof record.text === 'string' ? record.text.trim() : '';
	return {
		language,
		segments: text === '' ? [] : [{ start: 0, end: 0, text }],
	};
}
