/**
 * Pure mapping of an AssemblyAI answer into the plugin's transcript segment
 * model. The answer arrives in two bodies: the transcript itself, which names
 * the language and the billed duration, and its sentences, which are the
 * segments. Tolerant of missing or malformed fields so a surprising response
 * degrades to "best available" rather than throwing.
 * @module transcription/providers/assemblyAiResponse
 */

import { MS_PER_SECOND } from '../../constants';
import type { TranscriptSegment, TranscriptWord } from '../TranscriptTypes';
import type { WhisperResult } from './whisperResponse';
import { billedSeconds, isRecord, num } from './responseUtils';

/** A speaker AssemblyAI names with one capital letter, `A` being the first. */
const LETTER_SPEAKER = /^[A-Z]$/;

/** Character code just below `A`, so `A` becomes speaker 1. */
const BEFORE_LETTER_A = 64;

/**
 * AssemblyAI's speaker name as the label the rest of the plugin uses. The
 * letters become the numbers Deepgram's labels carry, so renaming speakers
 * and the sidecar read both engines the same way.
 * @param value - The `speaker` field of a sentence
 * @param diarize - Whether speaker labels were requested
 * @returns The label, or undefined when there is none to give
 */
function speakerLabel(value: unknown, diarize: boolean): string | undefined {
	if (!diarize || typeof value !== 'string' || value === '') {
		return undefined;
	}
	return LETTER_SPEAKER.test(value)
		? `Speaker ${String(value.charCodeAt(0) - BEFORE_LETTER_A)}`
		: `Speaker ${value}`;
}

/**
 * Maps the words of a sentence, whose times are in milliseconds.
 * @param value - The `words` field of a sentence
 * @returns The words in seconds, or undefined when there are none
 */
function mapWords(value: unknown): TranscriptWord[] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}
	const words: TranscriptWord[] = [];
	for (const entry of value) {
		if (!isRecord(entry) || typeof entry.text !== 'string') {
			continue;
		}
		const start = num(entry.start) / MS_PER_SECOND;
		words.push({
			text: entry.text.trim(),
			start,
			end: num(entry.end, num(entry.start)) / MS_PER_SECOND,
		});
	}
	return words.length > 0 ? words : undefined;
}

/**
 * The text a field carries, trimmed, or '' when it carries none.
 * @param value - A field that should hold text
 * @returns The trimmed text
 */
function textOf(value: unknown): string {
	return typeof value === 'string' ? value.trim() : '';
}

/**
 * Builds a segment from one sentence, whose times are in milliseconds.
 * @param entry - One entry of the `sentences` array
 * @param diarize - Whether speaker labels were requested
 * @returns The segment, or null for an entry with no text
 */
function sentenceSegment(
	entry: unknown,
	diarize: boolean,
): TranscriptSegment | null {
	const text = isRecord(entry) ? textOf(entry.text) : '';
	if (!isRecord(entry) || text === '') {
		return null;
	}
	const speaker = speakerLabel(entry.speaker, diarize);
	const words = mapWords(entry.words);
	return {
		start: num(entry.start) / MS_PER_SECOND,
		end: num(entry.end, num(entry.start)) / MS_PER_SECOND,
		text,
		...(speaker ? { speaker } : {}),
		...(words ? { words } : {}),
	};
}

/**
 * Maps a completed AssemblyAI transcript and its sentences to a WhisperResult.
 * Falls back to one segment built from the transcript's flat `text` when the
 * sentences carry nothing.
 * @param transcript - Parsed body of `GET /v2/transcript/{id}`
 * @param sentences - Parsed body of `GET /v2/transcript/{id}/sentences`
 * @param diarize - Whether diarization was requested (gates speaker labels)
 * @returns Language, timed segments and the billed duration
 */
export function mapAssemblyAiResponse(
	transcript: unknown,
	sentences: unknown,
	diarize: boolean,
): WhisperResult {
	const body = isRecord(transcript) ? transcript : {};
	const entries: unknown = isRecord(sentences)
		? sentences.sentences
		: undefined;
	const segments = (Array.isArray(entries) ? entries : [])
		.map((entry) => sentenceSegment(entry, diarize))
		.filter((segment): segment is TranscriptSegment => segment !== null);
	const flatText = textOf(body.text);
	if (segments.length === 0 && flatText !== '') {
		segments.push({ start: 0, end: 0, text: flatText });
	}
	// `audio_duration` is the billed audio, in seconds.
	const usage = billedSeconds(body.audio_duration);
	return {
		language:
			typeof body.language_code === 'string'
				? body.language_code
				: undefined,
		segments,
		...(usage ? { usage } : {}),
	};
}
