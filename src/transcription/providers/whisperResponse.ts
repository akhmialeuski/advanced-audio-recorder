/**
 * Pure mapping of an OpenAI-compatible Whisper `verbose_json` response
 * into the plugin's transcript segment model. Tolerant of missing or
 * malformed fields so a surprising provider response degrades to "best
 * available" rather than throwing.
 * @module transcription/providers/whisperResponse
 */

import type {
	TranscriptSegment,
	TranscriptWord,
	TranscriptionUsage,
} from '../TranscriptTypes';
import { isRecord, num } from './responseUtils';

/** Parsed result of one transcription request. */
export interface WhisperResult {
	language?: string | undefined;
	segments: TranscriptSegment[];
	/** Billing-relevant usage the provider reported, when any. */
	usage?: TranscriptionUsage;
}

/**
 * Reads the billed audio duration a `verbose_json` response carries at
 * the top level, when present and finite.
 */
function billedSeconds(value: unknown): TranscriptionUsage | undefined {
	if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
		return undefined;
	}
	return { audioSeconds: value };
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
		if (!isRecord(entry)) {
			continue;
		}
		const text = entry.word ?? entry.text;
		if (typeof text !== 'string') {
			continue;
		}
		words.push({
			text: text.trim(),
			start: num(entry.start),
			end: num(entry.end),
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
	if (!isRecord(body)) {
		return { segments: [] };
	}
	const language =
		typeof body.language === 'string' ? body.language : undefined;
	// OpenAI's verbose_json reports the billed audio duration in seconds;
	// carry it out so the run's actual cost can be computed.
	const usage = billedSeconds(body.duration);

	const rawSegments = body.segments;
	if (Array.isArray(rawSegments) && rawSegments.length > 0) {
		const segments: TranscriptSegment[] = [];
		for (const entry of rawSegments) {
			if (!isRecord(entry)) {
				continue;
			}
			const text =
				typeof entry.text === 'string' ? entry.text.trim() : '';
			if (text === '') {
				continue;
			}
			const speaker =
				typeof entry.speaker === 'string' ? entry.speaker : undefined;
			const words = mapWords(entry.words);
			segments.push({
				start: num(entry.start),
				end: num(entry.end, num(entry.start)),
				text,
				...(speaker ? { speaker } : {}),
				...(words ? { words } : {}),
			});
		}
		return { language, segments, ...(usage ? { usage } : {}) };
	}

	// No segment array: fall back to the flat transcript text.
	const text = typeof body.text === 'string' ? body.text.trim() : '';
	return {
		language,
		segments: text === '' ? [] : [{ start: 0, end: 0, text }],
		...(usage ? { usage } : {}),
	};
}
