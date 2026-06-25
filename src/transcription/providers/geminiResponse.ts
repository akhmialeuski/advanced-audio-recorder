/**
 * Pure mapping of a Gemini `generateContent` response into the plugin's
 * transcript segment model. Gemini is asked for structured JSON (segments with
 * a start, optional end, optional speaker, and text), which it returns as the
 * text of the response part; this module extracts and parses it. Tolerant of
 * missing or malformed fields so a surprising response degrades to "best
 * available" rather than throwing.
 * @module transcription/providers/geminiResponse
 */

import type { TranscriptSegment } from '../TranscriptTypes';
import type { WhisperResult } from './whisperResponse';
import { isRecord } from './responseUtils';

/** Multiplier between adjacent sexagesimal timecode fields (60). */
const SECONDS_PER_MINUTE = 60;

/** Minimum/maximum field count for a "MM:SS" or "HH:MM:SS" timecode. */
const MIN_TIMECODE_PARTS = 2;
const MAX_TIMECODE_PARTS = 3;

/**
 * Parses a timecode to seconds. Accepts a finite number (already seconds) or a
 * "HH:MM:SS"/"MM:SS" string — a defensive fallback in case the model emits a
 * string despite the numeric schema. Returns `fallback` for anything else.
 * @param value - Raw timecode value
 * @param fallback - Returned when `value` cannot be parsed
 */
export function parseTimecode(value: unknown, fallback = 0): number {
	if (typeof value === 'number' && Number.isFinite(value)) {
		return value;
	}
	if (typeof value === 'string') {
		const parts = value.trim().split(':');
		if (
			parts.length >= MIN_TIMECODE_PARTS &&
			parts.length <= MAX_TIMECODE_PARTS
		) {
			let seconds = 0;
			for (const part of parts) {
				const field = Number(part);
				if (!Number.isFinite(field)) {
					return fallback;
				}
				seconds = seconds * SECONDS_PER_MINUTE + field;
			}
			return seconds;
		}
		const direct = Number(value);
		if (Number.isFinite(direct)) {
			return direct;
		}
	}
	return fallback;
}

/** Concatenates the text parts of the first candidate, or '' when absent. */
function candidateText(body: unknown): string {
	if (!isRecord(body) || !Array.isArray(body.candidates)) {
		return '';
	}
	const first: unknown = body.candidates[0];
	if (
		!isRecord(first) ||
		!isRecord(first.content) ||
		!Array.isArray(first.content.parts)
	) {
		return '';
	}
	const parts: string[] = [];
	for (const part of first.content.parts) {
		if (isRecord(part) && typeof part.text === 'string') {
			parts.push(part.text);
		}
	}
	return parts.join('');
}

/**
 * Maps a Gemini response to a WhisperResult.
 * @param body - Parsed JSON response body
 * @param diarize - Whether diarization was requested (gates speaker labels)
 */
export function mapGeminiResponse(
	body: unknown,
	diarize: boolean,
): WhisperResult {
	const text = candidateText(body);
	if (text.trim() === '') {
		return { segments: [] };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return { segments: [] };
	}
	if (!isRecord(parsed) || !Array.isArray(parsed.segments)) {
		return { segments: [] };
	}
	const language =
		typeof parsed.language === 'string' ? parsed.language : undefined;
	const segments: TranscriptSegment[] = [];
	for (const entry of parsed.segments) {
		if (!isRecord(entry)) {
			continue;
		}
		const segText = typeof entry.text === 'string' ? entry.text.trim() : '';
		if (segText === '') {
			continue;
		}
		const start = parseTimecode(entry.start);
		const end = parseTimecode(entry.end, start);
		const speaker =
			diarize &&
			typeof entry.speaker === 'string' &&
			entry.speaker.trim() !== ''
				? entry.speaker.trim()
				: undefined;
		segments.push({
			start,
			end,
			text: segText,
			...(speaker ? { speaker } : {}),
		});
	}
	return { language, segments };
}
