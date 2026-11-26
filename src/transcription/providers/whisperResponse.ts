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
import { billedSeconds, isRecord, num } from './responseUtils';

/** Parsed result of one transcription request. */
export interface WhisperResult {
	language?: string | undefined;
	segments: TranscriptSegment[];
	/** Billing-relevant usage the provider reported, when any. */
	usage?: TranscriptionUsage;
	/**
	 * The rewritten text a request carrying a rewrite instruction answered
	 * with, line breaks kept. Absent from every other request.
	 */
	rewritten?: string;
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
			// A missing end is taken from the word's own start, so the
			// interval degenerates instead of pointing backwards as a zero
			// would. Same rule as the segment below.
			end: num(entry.end, num(entry.start)),
		});
	}
	return words.length > 0 ? words : undefined;
}

/**
 * Maps one segment entry.
 * @param entry - The entry as the response holds it
 * @returns The segment, or null for an entry that carries no text
 */
function mapSegment(entry: unknown): TranscriptSegment | null {
	if (!isRecord(entry)) {
		return null;
	}
	const text = typeof entry.text === 'string' ? entry.text.trim() : '';
	if (text === '') {
		return null;
	}
	// Speaker label: OpenAI-compatible endpoints use `speaker`, Mistral
	// Voxtral and Together use `speaker_id`. Both name the same thing.
	const speakerValue = entry.speaker ?? entry.speaker_id;
	const speaker = typeof speakerValue === 'string' ? speakerValue : undefined;
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
 * Maps a segment array, skipping entries that carry no text.
 * @param value - The array as the response holds it
 * @returns The segments, empty when there is no array or nothing in it
 */
function mapSegments(value: unknown): TranscriptSegment[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value
		.map(mapSegment)
		.filter((segment): segment is TranscriptSegment => segment !== null);
}

/**
 * The segments a response is read from. Some diarizing hosts keep the plain
 * Whisper segments as they are and answer the speakers in a list of their
 * own, `speaker_segments`, cut at speaker turns (Together does). That list is
 * the diarized transcript, so it is the one taken whenever the plain segments
 * name no speaker and it does.
 * @param body - Parsed JSON response body
 * @returns The segments, empty when the response carries none
 */
function responseSegments(body: Record<string, unknown>): TranscriptSegment[] {
	const plain = mapSegments(body.segments);
	const bySpeaker = mapSegments(body.speaker_segments);
	const labelled = (segments: TranscriptSegment[]): boolean =>
		segments.some((segment) => segment.speaker !== undefined);
	return !labelled(plain) && labelled(bySpeaker) ? bySpeaker : plain;
}

/**
 * Maps a Whisper `verbose_json` response, or a compatible shape such as the one
 * Mistral Voxtral or a diarizing host answers with, to a WhisperResult. Falls back to a single
 * segment built from the top-level `text` when no segment array is present.
 * @param body - Parsed JSON response body
 */
export function mapWhisperResponse(body: unknown): WhisperResult {
	if (!isRecord(body)) {
		return { segments: [] };
	}
	const language =
		typeof body.language === 'string' ? body.language : undefined;
	// Billed audio duration, carried out so the run's actual cost can be
	// computed. OpenAI's verbose_json reports it as a top-level `duration`,
	// Mistral Voxtral as `usage.prompt_audio_seconds`. Both name the same
	// number, so both are read here rather than in a near-copy of this mapper.
	const usage =
		billedSeconds(body.duration) ??
		billedSeconds(
			isRecord(body.usage) ? body.usage.prompt_audio_seconds : undefined,
		);

	const segments = responseSegments(body);
	if (segments.length > 0) {
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
