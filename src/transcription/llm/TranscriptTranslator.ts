/**
 * Translates a transcript segment by segment, so the translation keeps the
 * recording's own timeline and can be written as subtitles.
 *
 * Translating the rendered Markdown would have been less code and would have
 * produced a block of prose with no way back to the timings: SubRip and WebVTT
 * are built from segments, and a line the model merged or dropped cannot be
 * put back on a clock. So the pass runs over the segments instead, one
 * `number|speaker|text` line each, and the answer is mapped back onto them by
 * that number. Start, end, and speaker never leave this module, which is what
 * makes "the timecodes match the original" true by construction rather than by
 * the model's good behaviour.
 * @module transcription/llm/TranscriptTranslator
 */

import {
	PLUGIN_LOG_PREFIX,
	TRANSLATION_CHUNK_TOKEN_SHARE,
} from '../../constants';
import type { AudioRecorderSettings } from '../../settings/settingsSchema';
import { resolveLlmPrompt } from '../../settings/profileResolution';
import { tokenUpperBound } from '../dictionaryBias';
import { buildPostProcessPrompt } from '../llmPostProcess';
import type { Transcript, TranscriptSegment } from '../TranscriptTypes';
import type { LlmProvider } from './LlmProvider';
import { runLlmStep, type LlmCostSink } from './llmStep';

/** Field separator of one wire line: number, speaker, text. */
const FIELD_SEPARATOR = '|';

/** A translated transcript and the language it was written in. */
export interface TranslationResult {
	/** The translated transcript; same timings, same speakers. */
	transcript: Transcript;
	/** The language it was translated into; never empty. */
	language: string;
}

/** What one translation pass needs. */
export interface TranslationRequest {
	/** The transcript to translate; never modified. */
	transcript: Transcript;
	/** The run's settings, which carry the prompt and the target language. */
	settings: AudioRecorderSettings;
	/** The provider that writes the translation. */
	llm: LlmProvider;
	/** Output-token ceiling of the configured model. */
	maxTokens: number;
	/** Where to report the cost of each call. */
	costSink?: LlmCostSink | undefined;
	/** Aborts the calls when the run is cancelled. */
	signal?: AbortSignal | undefined;
}

/**
 * Encodes one segment as a wire line. The index is the segment's position, so
 * a line that comes back can be placed without trusting anything else in it.
 * @param segment - The segment to encode
 * @param index - Its position in the transcript
 * @returns One wire line
 */
function encodeLine(segment: TranscriptSegment, index: number): string {
	return [
		String(index),
		segment.speaker ?? '',
		segment.text.replace(/\r?\n/g, ' '),
	].join(FIELD_SEPARATOR);
}

/** One segment of a chunk, with the number the wire lines call it by. */
interface ChunkEntry {
	/** The segment's position in the transcript. */
	index: number;
	/** The segment itself. */
	segment: TranscriptSegment;
}

/**
 * The stretch of the recording a chunk covers, in seconds.
 *
 * Measured across the chunk rather than from the beginning of the recording.
 * The end offset of the last segment is how far into the recording the chunk
 * reaches, not how much of it the chunk holds, and sizing every chunk by that
 * charged the estimate for the whole recording again at each one: four chunks
 * of a one-hour transcript came to two and a half hours of material.
 * @param chunk - The segments one call carries
 * @returns The seconds the chunk covers, or null for a chunk with nothing in it
 */
function spanOf(chunk: readonly ChunkEntry[]): number | null {
	let start = Number.POSITIVE_INFINITY;
	let end = Number.NEGATIVE_INFINITY;
	for (const { segment } of chunk) {
		start = Math.min(start, segment.start);
		end = Math.max(end, segment.end);
	}
	return end === Number.NEGATIVE_INFINITY ? null : Math.max(0, end - start);
}

/**
 * Reads the translated text out of one answered line. The speaker field is
 * parsed only to be skipped: the original is re-attached either way, so a
 * model that rewrote it cannot change who said what.
 * @param line - One line of the model's answer
 * @returns The segment index and its translated text, or null when the line
 *   is not one of ours
 */
function decodeLine(line: string): { index: number; text: string } | null {
	const parts = line.split(FIELD_SEPARATOR);
	if (parts.length < 3) {
		return null;
	}
	const index = Number.parseInt((parts[0] ?? '').trim(), 10);
	if (!Number.isInteger(index) || index < 0) {
		return null;
	}
	// Everything after the second separator is the text, so a translation
	// that happens to contain the separator survives intact.
	return { index, text: parts.slice(2).join(FIELD_SEPARATOR).trim() };
}

/**
 * Translates one transcript through a language model.
 */
export class TranscriptTranslator {
	/**
	 * @param request - The transcript, the provider, and how to account it
	 */
	constructor(private readonly request: TranslationRequest) {}

	/**
	 * Returns the transcript translated into the configured language. Every
	 * segment keeps its start, end, speaker, and word timings; only the text
	 * changes, and a segment the model failed to answer for keeps its own.
	 * @returns The translated transcript and the language it is in
	 */
	async translate(): Promise<TranslationResult> {
		const translated = new Map<number, string>();
		for (const chunk of this.chunks()) {
			for (const [index, text] of await this.translateChunk(chunk)) {
				translated.set(index, text);
			}
		}
		const language = this.targetLanguage();
		return {
			language,
			transcript: {
				...this.request.transcript,
				language,
				segments: this.request.transcript.segments.map(
					(segment, index) => ({
						...segment,
						text: translated.get(index) ?? segment.text,
					}),
				),
			},
		};
	}

	/**
	 * Splits the transcript into runs of segments whose wire lines fit the
	 * model's output ceiling. A translation is about as long as its input, so
	 * the budget is a share of the ceiling rather than all of it: the answer
	 * has to fit as well as the question, and a language that spells the same
	 * meaning longer must not run the answer off the end.
	 * @returns Runs of segment indices, in order
	 */
	private chunks(): number[][] {
		const budget = Math.max(
			1,
			Math.floor(this.request.maxTokens * TRANSLATION_CHUNK_TOKEN_SHARE),
		);
		const chunks: number[][] = [];
		let current: number[] = [];
		let used = 0;
		this.request.transcript.segments.forEach((segment, index) => {
			const cost = tokenUpperBound(encodeLine(segment, index));
			if (current.length > 0 && used + cost > budget) {
				chunks.push(current);
				current = [];
				used = 0;
			}
			current.push(index);
			used += cost;
		});
		if (current.length > 0) {
			chunks.push(current);
		}
		return chunks;
	}

	/**
	 * Translates one run of segments, asking again for whatever the answer
	 * left out. A second gap leaves those segments in their own language: a
	 * partly translated transcript with correct timings is worth more than one
	 * whose lines have slipped against the clock.
	 *
	 * The second call asks only for the lines still missing and keeps what the
	 * first one answered. Repeating the whole run and taking the new answer
	 * instead threw away work the user had already paid for: a first call that
	 * came back with ninety-five of a hundred lines followed by a second that
	 * came back with five left ninety-five segments untranslated that were
	 * already translated.
	 * @param indices - Segment indices to translate
	 * @returns The translated text of each segment the answer covered
	 */
	private async translateChunk(
		indices: readonly number[],
	): Promise<Map<number, string>> {
		const wanted = new Set(indices);
		// Extra lines are dropped by the wanted check, and a missing one
		// leaves the count short; either way the run is not trustworthy.
		const answered = await this.askFor(indices);
		if (answered.size === wanted.size) {
			return answered;
		}
		this.warnMismatch(answered.size, wanted.size, true);
		for (const [index, text] of await this.askFor(
			indices.filter((index) => !answered.has(index)),
		)) {
			answered.set(index, text);
		}
		if (answered.size !== wanted.size) {
			this.warnMismatch(answered.size, wanted.size, false);
		}
		return answered;
	}

	/**
	 * Says an answer did not line up, and what happens to those segments next.
	 * @param answered - Lines the model came back with
	 * @param wanted - Lines the run asked for
	 * @param retrying - Whether the run is about to ask a second time
	 */
	private warnMismatch(
		answered: number,
		wanted: number,
		retrying: boolean,
	): void {
		console.warn(
			`${PLUGIN_LOG_PREFIX} The translation answered ${String(answered)} of ${String(wanted)} lines;` +
				(retrying
					? ' asking again.'
					: ' keeping the original text for the rest.'),
		);
	}

	/**
	 * Sends one run of segments and reads back what the model answered for
	 * them. Lines naming a segment this run did not ask about are ignored, so
	 * a model that invents an index cannot overwrite another chunk's work.
	 * @param indices - Segment indices to translate
	 * @returns The translated text of each segment the answer covered
	 */
	private async askFor(
		indices: readonly number[],
	): Promise<Map<number, string>> {
		const wanted = new Set(indices);
		const chunk = this.resolve(indices);
		const text = await runLlmStep({
			step: 'postProcess',
			llm: this.request.llm,
			prompt: buildPostProcessPrompt(
				chunk
					.map(({ index, segment }) => encodeLine(segment, index))
					.join('\n'),
				{
					task: 'translate',
					translatePrompt: resolveLlmPrompt(
						this.request.settings,
						'translate',
					),
					targetLanguage: this.targetLanguage(),
				},
			),
			maxTokens: this.request.maxTokens,
			settings: this.request.settings,
			// The stretch these segments cover is what the call reads, so the
			// estimate is sized by it exactly as a whole-transcript pass is.
			durationSeconds: spanOf(chunk),
			costSink: this.request.costSink,
			signal: this.request.signal,
		});
		const answered = new Map<number, string>();
		for (const line of text.split('\n')) {
			const parsed = decodeLine(line);
			if (parsed && wanted.has(parsed.index) && parsed.text.length > 0) {
				answered.set(parsed.index, parsed.text);
			}
		}
		return answered;
	}

	/**
	 * Pairs each index with the segment it names, dropping any the transcript
	 * does not have.
	 *
	 * The two travel together rather than being matched up by position later:
	 * a filtered list renumbers itself, so pairing after the filter would put
	 * a dropped segment's number on its neighbour and land that neighbour's
	 * translation on the wrong line.
	 * @param indices - Segment indices to translate
	 * @returns The segments this run can ask about, each with its own number
	 */
	private resolve(indices: readonly number[]): ChunkEntry[] {
		const segments = this.request.transcript.segments;
		return indices
			.map((index) => ({ index, segment: segments[index] }))
			.filter(
				(entry): entry is ChunkEntry => entry.segment !== undefined,
			);
	}

	/** The language to translate into, defaulting to English. */
	private targetLanguage(): string {
		return (
			this.request.settings.llmTranslateTargetLanguage.trim() || 'English'
		);
	}
}
