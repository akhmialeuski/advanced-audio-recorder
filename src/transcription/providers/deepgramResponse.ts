/**
 * Pure mapping of a Deepgram pre-recorded `/v1/listen` response into the
 * plugin's transcript segment model. Prefers `results.utterances` (clean
 * per-turn segments with speakers); falls back to grouping
 * `alternatives[0].words` by speaker, then to the flat transcript.
 * Tolerant of missing or malformed fields so a surprising response
 * degrades to "best available" rather than throwing.
 * @module transcription/providers/deepgramResponse
 */

import type {
	TranscriptSegment,
	TranscriptWord,
	TranscriptionUsage,
} from '../TranscriptTypes';
import type { WhisperResult } from './whisperResponse';
import { isRecord, num } from './responseUtils';

/**
 * Reads the billed audio duration from Deepgram's `metadata.duration`
 * (seconds), when present and finite, so the run's actual cost can be
 * computed.
 */
function deepgramUsage(
	body: Record<string, unknown>,
): TranscriptionUsage | undefined {
	if (!isRecord(body.metadata)) {
		return undefined;
	}
	const duration = body.metadata.duration;
	if (
		typeof duration !== 'number' ||
		!Number.isFinite(duration) ||
		duration < 0
	) {
		return undefined;
	}
	return { audioSeconds: duration };
}

/** Formats a Deepgram speaker index (0-based) as a label, when present. */
function speakerLabel(value: unknown, diarize: boolean): string | undefined {
	if (!diarize || typeof value !== 'number' || !Number.isFinite(value)) {
		return undefined;
	}
	return `Speaker ${String(value + 1)}`;
}

/** Maps Deepgram word entries (prefers `punctuated_word`) to words. */
function mapWords(value: unknown): TranscriptWord[] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}
	const words: TranscriptWord[] = [];
	for (const entry of value) {
		if (!isRecord(entry)) {
			continue;
		}
		const text = entry.punctuated_word ?? entry.word;
		if (typeof text !== 'string') {
			continue;
		}
		words.push({
			text: text.trim(),
			start: num(entry.start),
			end: num(entry.end, num(entry.start)),
		});
	}
	return words.length > 0 ? words : undefined;
}

/** Builds a segment from a Deepgram utterance object. */
function utteranceSegment(
	entry: unknown,
	diarize: boolean,
): TranscriptSegment | null {
	if (!isRecord(entry)) {
		return null;
	}
	const text =
		typeof entry.transcript === 'string' ? entry.transcript.trim() : '';
	if (text === '') {
		return null;
	}
	const speaker = speakerLabel(entry.speaker, diarize);
	const words = mapWords(entry.words);
	return {
		start: num(entry.start),
		end: num(entry.end, num(entry.start)),
		text,
		...(speaker ? { speaker } : {}),
		...(words ? { words } : {}),
	};
}

/**
 * Groups a flat word list into segments, starting a new segment whenever
 * the speaker changes (used only when no utterances are present).
 */
function groupWordsBySpeaker(
	value: unknown,
	diarize: boolean,
): TranscriptSegment[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const segments: TranscriptSegment[] = [];
	let current: TranscriptSegment | null = null;
	let currentSpeaker: unknown;
	for (const entry of value) {
		if (!isRecord(entry)) {
			continue;
		}
		const text = entry.punctuated_word ?? entry.word;
		if (typeof text !== 'string' || text.trim() === '') {
			continue;
		}
		const speaker = speakerLabel(entry.speaker, diarize);
		const start = num(entry.start);
		const end = num(entry.end, start);
		if (!current || (diarize && entry.speaker !== currentSpeaker)) {
			current = {
				start,
				end,
				text: text.trim(),
				...(speaker ? { speaker } : {}),
			};
			currentSpeaker = entry.speaker;
			segments.push(current);
		} else {
			current.text += ` ${text.trim()}`;
			current.end = end;
		}
	}
	return segments;
}

/**
 * Maps a Deepgram response to a WhisperResult.
 * @param body - Parsed JSON response body
 * @param diarize - Whether diarization was requested (gates speaker labels)
 */
export function mapDeepgramResponse(
	body: unknown,
	diarize: boolean,
): WhisperResult {
	if (!isRecord(body) || !isRecord(body.results)) {
		return { segments: [] };
	}
	const results = body.results;
	const usage = deepgramUsage(body);

	const channels = results.channels;
	const channel0 =
		Array.isArray(channels) && isRecord(channels[0])
			? channels[0]
			: undefined;
	const language =
		channel0 && typeof channel0.detected_language === 'string'
			? channel0.detected_language
			: undefined;

	if (Array.isArray(results.utterances) && results.utterances.length > 0) {
		const segments: TranscriptSegment[] = [];
		for (const entry of results.utterances) {
			const segment = utteranceSegment(entry, diarize);
			if (segment) {
				segments.push(segment);
			}
		}
		if (segments.length > 0) {
			return { language, segments, ...(usage ? { usage } : {}) };
		}
	}

	const alternatives = channel0?.alternatives;
	const alt =
		Array.isArray(alternatives) && isRecord(alternatives[0])
			? alternatives[0]
			: undefined;
	if (alt) {
		// Without utterances, preserve speakers by grouping words when
		// diarizing; otherwise the smart-formatted flat transcript is best.
		if (diarize) {
			const grouped = groupWordsBySpeaker(alt.words, true);
			if (grouped.length > 0) {
				return {
					language,
					segments: grouped,
					...(usage ? { usage } : {}),
				};
			}
		}
		const text =
			typeof alt.transcript === 'string' ? alt.transcript.trim() : '';
		if (text !== '') {
			return {
				language,
				segments: [{ start: 0, end: 0, text }],
				...(usage ? { usage } : {}),
			};
		}
	}

	return { language, segments: [], ...(usage ? { usage } : {}) };
}
