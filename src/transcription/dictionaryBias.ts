/**
 * Plans how the custom transcription dictionary is applied for the selected
 * engine, honoring each provider's biasing mechanism and hard request limits.
 * Support is not uniform and is not even uniform within one engine: Deepgram
 * Nova-3 biases with keyterm prompting (at most {@link DEEPGRAM_KEYTERM_LIMIT}
 * terms and {@link DEEPGRAM_KEYTERM_TOKEN_LIMIT} tokens in aggregate), Nova-2
 * and older bias with keyword boosting (at most {@link DEEPGRAM_KEYWORDS_LIMIT}
 * terms), Deepgram's hosted Whisper models support neither, and the Whisper
 * prompt used by the OpenAI API and local whisper.cpp is bounded by a
 * ~{@link WHISPER_PROMPT_TOKEN_LIMIT} token window. This module is the single
 * place those rules live, so the service applies exactly the terms it tells the
 * user about and no provider silently drops, over-sends, or over-tokenizes
 * terms in a way the engine would reject.
 * @module transcription/dictionaryBias
 */

import { TRANSCRIPTION_PROVIDER_IDS } from '../constants';
import type { TranscriptionProviderId } from '../settings/settingsSchema';
import { effectiveDictionary } from './providers/capabilities';

/**
 * Deepgram accepts at most this many keyterms in a single pre-recorded request
 * (Nova-3 keyterm prompting). Entries beyond it make the request invalid.
 */
export const DEEPGRAM_KEYTERM_LIMIT = 100;

/**
 * Deepgram also rejects a Nova-3 request whose keyterms exceed this many tokens
 * in aggregate, independently of the entry count: a handful of long multi-word
 * terms can breach it well before {@link DEEPGRAM_KEYTERM_LIMIT} entries.
 */
export const DEEPGRAM_KEYTERM_TOKEN_LIMIT = 500;

/**
 * Deepgram accepts at most this many keywords in a single pre-recorded request
 * (Nova-2 and older keyword boosting). This mirrors the keyterm entry limit but
 * is a distinct provider limit, so it is named separately.
 */
export const DEEPGRAM_KEYWORDS_LIMIT = 100;

/**
 * Whisper (the OpenAI API and local whisper.cpp) only considers the last ~224
 * tokens of the prompt, so terms beyond that window are silently ignored. The
 * dictionary prompt is bounded to this many tokens.
 */
export const WHISPER_PROMPT_TOKEN_LIMIT = 224;

/** Separator used to join dictionary terms into a single prompt string. */
export const DICTIONARY_JOIN_SEPARATOR = ', ';

/** Reused encoder for the UTF-8 byte count behind {@link tokenUpperBound}. */
const UTF8_ENCODER = new TextEncoder();

/** How a Deepgram model biases recognition, or null when it cannot bias. */
export type DeepgramBiasMechanism = 'keyterm' | 'keywords' | null;

/**
 * Why some dictionary terms were left out of a run, when any were. The two
 * Deepgram entry caps are distinct reasons rather than one shared
 * "term-limit": they are separate provider limits on separate mechanisms
 * (Nova-3 keyterm prompting vs. Nova-2-and-older keyword boosting), so one
 * reason would have to name a single constant and would misreport the other
 * cap the moment the two values diverge.
 */
export type DictionaryOmissionReason =
	| 'model-unsupported'
	| 'keyterm-limit'
	| 'keywords-limit'
	| 'keyterm-token-budget'
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
 * A safe upper bound on the number of tokens {@link text} produces in the
 * byte-level BPE tokenizers Whisper and Deepgram use. Such a tokenizer starts
 * from the raw UTF-8 bytes and only ever merges them, so a text can never
 * tokenize into more tokens than it has bytes; the byte count therefore never
 * undershoots the real token count. A four-characters-per-token average would
 * undershoot for short abbreviations, punctuation-heavy terms, and non-Latin
 * scripts (a Cyrillic character is two bytes and often more than one token),
 * which would mark a glossary as fitting a window it actually overflows. This
 * deliberately over-estimates for plain Latin text instead: the only cost is
 * that a few extra terms are reported as omitted, which the user is told about,
 * rather than silently dropped or rejected by the engine.
 * @param text - The text to measure
 * @returns Byte length of the UTF-8 encoding, an upper bound on the token count
 */
export function tokenUpperBound(text: string): number {
	return UTF8_ENCODER.encode(text).length;
}

/**
 * The longest prefix of {@link terms} whose aggregate token upper bound stays
 * within {@link tokenBudget} and whose length stays within {@link maxCount}.
 * When {@link withSeparators} is true the join separator between terms counts
 * toward the budget, because the Whisper prompt is one joined string; when
 * false each term is measured on its own, because Deepgram sends each keyterm as
 * a separate query param. UTF-8 byte length is additive, so the running sum
 * equals the byte length of the joined prompt exactly.
 * @param terms - Parsed dictionary terms, in priority order
 * @param tokenBudget - Aggregate token upper bound the prefix must stay within
 * @param withSeparators - Whether the inter-term separator counts toward the budget
 * @param maxCount - Maximum number of terms to keep (defaults to no count limit)
 * @returns The prefix of terms that fits both bounds
 */
function termsWithinBudget(
	terms: string[],
	tokenBudget: number,
	withSeparators: boolean,
	maxCount = Number.POSITIVE_INFINITY,
): string[] {
	const separatorTokens = withSeparators
		? tokenUpperBound(DICTIONARY_JOIN_SEPARATOR)
		: 0;
	const applied: string[] = [];
	let tokens = 0;
	for (const term of terms) {
		if (applied.length >= maxCount) {
			break;
		}
		const next =
			tokens +
			(applied.length ? separatorTokens : 0) +
			tokenUpperBound(term);
		if (next > tokenBudget) {
			break;
		}
		applied.push(term);
		tokens = next;
	}
	return applied;
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
	return termsWithinBudget(terms, WHISPER_PROMPT_TOKEN_LIMIT, true);
}

/**
 * The leading dictionary terms that fit Deepgram's Nova-3 keyterm limits: at
 * most {@link DEEPGRAM_KEYTERM_LIMIT} entries and {@link DEEPGRAM_KEYTERM_TOKEN_LIMIT}
 * tokens in aggregate. Keyterms are separate query params, so the separator does
 * not count toward the token budget. Idempotent for defensive re-application.
 * @param terms - Parsed dictionary terms, in priority order
 * @returns The prefix of terms that fits both keyterm limits
 */
export function termsWithinDeepgramKeyterm(terms: string[]): string[] {
	return termsWithinBudget(
		terms,
		DEEPGRAM_KEYTERM_TOKEN_LIMIT,
		false,
		DEEPGRAM_KEYTERM_LIMIT,
	);
}

/**
 * Plans the dictionary biasing for a run: which terms are sent to the provider
 * and which are dropped because the engine cannot bias or a request limit is
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
		if (mechanism === 'keyterm') {
			const applied = termsWithinDeepgramKeyterm(gated);
			if (applied.length < gated.length) {
				return {
					applied,
					omitted: gated.slice(applied.length),
					// Stopping at the entry cap means the count bound bit; stopping
					// earlier means the aggregate token budget did.
					reason:
						applied.length >= DEEPGRAM_KEYTERM_LIMIT
							? 'keyterm-limit'
							: 'keyterm-token-budget',
				};
			}
			return { applied, omitted: [] };
		}
		// Nova-2 and older keyword boosting: bounded by entry count only.
		if (gated.length > DEEPGRAM_KEYWORDS_LIMIT) {
			return {
				applied: gated.slice(0, DEEPGRAM_KEYWORDS_LIMIT),
				omitted: gated.slice(DEEPGRAM_KEYWORDS_LIMIT),
				reason: 'keywords-limit',
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
		case 'keyterm-limit':
			return (
				`Custom dictionary: only the first ${plan.applied.length} of ${total} ` +
				`terms were sent (Deepgram accepts at most ${DEEPGRAM_KEYTERM_LIMIT} keyterms per request).`
			);
		case 'keywords-limit':
			return (
				`Custom dictionary: only the first ${plan.applied.length} of ${total} ` +
				`terms were sent (this Deepgram model accepts at most ${DEEPGRAM_KEYWORDS_LIMIT} keywords per request).`
			);
		case 'keyterm-token-budget':
			return (
				`Custom dictionary: only the first ${plan.applied.length} of ${total} ` +
				`terms were sent (Deepgram limits keyterms to ${DEEPGRAM_KEYTERM_TOKEN_LIMIT} tokens in total). ` +
				'Shorten or remove long multi-word terms.'
			);
		case 'prompt-window':
			return (
				`Custom dictionary: only ${plan.applied.length} of ${total} terms fit ` +
				'the transcription prompt; the rest were left out. Shorten the dictionary.'
			);
	}
}
