/**
 * Plans how the custom transcription dictionary is applied for the selected
 * engine, honoring each provider's biasing mechanism and hard request limits.
 * Support is not uniform and is not even uniform within one engine: Deepgram
 * Nova-3 biases with keyterm prompting (at most {@link DEEPGRAM_KEYTERM_LIMIT}
 * terms), Nova-2 and older bias with keyword boosting, Deepgram's hosted
 * Whisper models support neither, and the Whisper prompt used by the OpenAI API
 * and local whisper.cpp is bounded by a ~{@link WHISPER_PROMPT_TOKEN_LIMIT}
 * token window. This module is the single place those rules live, so the
 * service applies exactly the terms it tells the user about and no provider
 * silently drops or over-sends terms.
 * @module transcription/dictionaryBias
 */

import { TRANSCRIPTION_PROVIDER_IDS } from '../constants';
import type { TranscriptionProviderId } from '../settings/settingsSchema';
import { effectiveDictionary } from './providers/capabilities';

/**
 * Deepgram accepts at most this many keyterms in a single pre-recorded
 * request (Nova-3 keyterm prompting). Terms beyond it make the request invalid.
 */
export const DEEPGRAM_KEYTERM_LIMIT = 100;

/**
 * Whisper (the OpenAI API and local whisper.cpp) only considers the last
 * ~224 tokens of the prompt, so terms beyond that window are silently ignored.
 * The dictionary prompt is bounded to this many estimated tokens.
 */
export const WHISPER_PROMPT_TOKEN_LIMIT = 224;

/**
 * Average characters per token for the ~4-chars-per-token heuristic. Whisper's
 * byte-level BPE tokenizer has no local implementation here, so the estimate
 * intentionally rounds up to never undershoot the real count.
 */
const CHARS_PER_TOKEN = 4;

/** Separator used to join dictionary terms into a single prompt string. */
export const DICTIONARY_JOIN_SEPARATOR = ', ';

/** How a Deepgram model biases recognition, or null when it cannot bias. */
export type DeepgramBiasMechanism = 'keyterm' | 'keywords' | null;

/** Why some dictionary terms were left out of a run, when any were. */
export type DictionaryOmissionReason =
	| 'model-unsupported'
	| 'term-limit'
	| 'prompt-window';

/** The terms actually applied for a run and any that were left out. */
export interface DictionaryBiasPlan {
	/** Terms sent to the provider, already within its mechanism and limits. */
	applied: string[];
	/** Terms dropped because the engine or its limit could not carry them. */
	omitted: string[];
	/** Why terms were dropped; set only when {@link omitted} is non-empty. */
	reason?: DictionaryOmissionReason;
}

/**
 * Deepgram's biasing mechanism for a model id. Nova-3 uses keyterm prompting;
 * Nova-2, Nova, Enhanced, and Base use keyword boosting; the hosted Whisper
 * models support neither, so they cannot bias at all.
 * @param model - Deepgram model id (e.g. "nova-3", "nova-2-meeting", "whisper")
 * @returns The query param to send terms under, or null when the model cannot bias
 */
export function deepgramBiasMechanism(model: string): DeepgramBiasMechanism {
	if (model.startsWith('nova-3')) {
		return 'keyterm';
	}
	// Hosted Whisper on Deepgram accepts neither keyterm nor keywords, so a
	// dictionary would be silently ignored (or reject the request).
	if (model.startsWith('whisper')) {
		return null;
	}
	// Nova-2 and older (Nova, Enhanced, Base) use keyword boosting.
	return 'keywords';
}

/**
 * Rough token estimate for a prompt string using the ~4-chars-per-token
 * heuristic, rounded up so the estimate never undershoots the real count.
 * @param text - The prompt text to measure
 * @returns Estimated token count
 */
export function estimateTokens(text: string): number {
	return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * The leading dictionary terms that fit inside the Whisper prompt window,
 * measured against the same comma join the providers send. Terms are added in
 * priority order until the next one would exceed the window; the rest are left
 * out. Idempotent, so a provider can re-apply it defensively on an already
 * bounded list without changing the result.
 * @param terms - Parsed dictionary terms, in priority order
 * @returns The prefix of terms that fits the prompt window
 */
export function termsWithinWhisperPrompt(terms: string[]): string[] {
	const applied: string[] = [];
	for (const term of terms) {
		const candidate = [...applied, term].join(DICTIONARY_JOIN_SEPARATOR);
		if (estimateTokens(candidate) > WHISPER_PROMPT_TOKEN_LIMIT) {
			break;
		}
		applied.push(term);
	}
	return applied;
}

/**
 * Plans the dictionary biasing for a run: which terms are sent to the provider
 * and which are dropped because the engine cannot bias or its request limit is
 * exceeded. The provider-level capability gate is applied first (a future
 * engine that cannot bias at all), then the per-model Deepgram rules and the
 * Whisper prompt window.
 * @param engineId - Selected transcription engine id
 * @param deepgramModel - Configured Deepgram model id (consulted only for Deepgram)
 * @param terms - The user's parsed, de-duplicated dictionary terms
 * @returns The applied and omitted terms, with the reason when any were dropped
 */
export function planDictionaryBias(
	engineId: TranscriptionProviderId,
	deepgramModel: string,
	terms: string[],
): DictionaryBiasPlan {
	// A future engine with supportsDictionary=false drops everything here.
	const gated = effectiveDictionary(engineId, terms);
	if (!gated.length) {
		return { applied: [], omitted: [] };
	}

	if (engineId === TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM) {
		const mechanism = deepgramBiasMechanism(deepgramModel);
		if (mechanism === null) {
			return { applied: [], omitted: gated, reason: 'model-unsupported' };
		}
		if (mechanism === 'keyterm' && gated.length > DEEPGRAM_KEYTERM_LIMIT) {
			return {
				applied: gated.slice(0, DEEPGRAM_KEYTERM_LIMIT),
				omitted: gated.slice(DEEPGRAM_KEYTERM_LIMIT),
				reason: 'term-limit',
			};
		}
		return { applied: gated, omitted: [] };
	}

	if (
		engineId === TRANSCRIPTION_PROVIDER_IDS.WHISPER_API ||
		engineId === TRANSCRIPTION_PROVIDER_IDS.LOCAL_WHISPER
	) {
		const applied = termsWithinWhisperPrompt(gated);
		if (applied.length < gated.length) {
			return {
				applied,
				omitted: gated.slice(applied.length),
				reason: 'prompt-window',
			};
		}
		return { applied, omitted: [] };
	}

	// Gemini folds terms into a large instruction context with no hard cap.
	return { applied: gated, omitted: [] };
}

/**
 * A user-facing explanation of the dropped terms, or null when every term was
 * applied. Kept next to the plan so the message and the cap can never diverge.
 * @param plan - The biasing plan produced by {@link planDictionaryBias}
 * @returns A sentence to show as a notice, or null when nothing was dropped
 */
export function describeDictionaryOmission(
	plan: DictionaryBiasPlan,
): string | null {
	if (!plan.omitted.length || !plan.reason) {
		return null;
	}
	const total = plan.applied.length + plan.omitted.length;
	switch (plan.reason) {
		case 'model-unsupported':
			return (
				'Custom dictionary was not applied: the selected Deepgram model ' +
				'does not support biasing. Choose a Nova model to bias recognition.'
			);
		case 'term-limit':
			return (
				`Custom dictionary: only the first ${plan.applied.length} of ${total} ` +
				`terms were sent (Deepgram accepts at most ${DEEPGRAM_KEYTERM_LIMIT} keyterms).`
			);
		case 'prompt-window':
			return (
				`Custom dictionary: only ${plan.applied.length} of ${total} terms fit ` +
				'the transcription prompt; the rest were left out. Shorten the dictionary.'
			);
	}
}
