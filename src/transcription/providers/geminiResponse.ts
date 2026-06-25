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
import { parseTimecode } from '../../utils/TimeUtils';
import type { WhisperResult } from './whisperResponse';
import { geminiCandidateText } from './geminiShared';
import { isRecord } from './responseUtils';

/**
 * Coerces a raw timecode value to seconds. Accepts a finite number (already
 * seconds) or a "HH:MM:SS"/"MM:SS"/bare-seconds string — a defensive fallback
 * in case the model emits a string despite the numeric schema — delegating the
 * string case to the shared timecode parser. Returns `fallback` for anything
 * else.
 * @param value - Raw timecode value
 * @param fallback - Returned when `value` cannot be parsed
 * @returns Seconds as a number
 */
export function timecodeToSeconds(value: unknown, fallback = 0): number {
	if (typeof value === 'number' && Number.isFinite(value)) {
		return value;
	}
	if (typeof value === 'string') {
		const seconds = parseTimecode(value);
		if (seconds !== null) {
			return seconds;
		}
	}
	return fallback;
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
	const text = geminiCandidateText(body);
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
		const start = timecodeToSeconds(entry.start);
		const end = timecodeToSeconds(entry.end, start);
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
