/**
 * Tests the dictionary biasing planner: the single place that decides which
 * terms each engine actually sends and which are dropped. It covers Deepgram's
 * per-model mechanism (keyterm for Nova-3, keywords for Nova-2 and older, none
 * for the hosted Whisper models), the Deepgram keyterm entry and aggregate
 * token limits, the Deepgram keywords entry limit, and the Whisper prompt token
 * window shared by the OpenAI API and local whisper.cpp.
 * @module tests/unit/dictionaryBias.test
 */

import {
	DEEPGRAM_KEYTERM_LIMIT,
	DEEPGRAM_KEYTERM_TOKEN_LIMIT,
	DEEPGRAM_KEYWORDS_LIMIT,
	WHISPER_PROMPT_TOKEN_LIMIT,
	deepgramBiasMechanism,
	describeDictionaryOmission,
	termsWithinWhisperPrompt,
	tokenUpperBound,
} from 'src/transcription/dictionaryBias';
import { planDictionaryBias } from 'src/transcription/providers/engines';
import { TRANSCRIPTION_PROVIDER_IDS } from 'src/constants';

/** Builds n unique terms, wide enough to blow past the prompt window. */
function manyTerms(n: number): string[] {
	return Array.from({ length: n }, (_v, i) => `Kubernetes-${String(i)}`);
}

/** Builds n very short terms so an entry count limit bites before a token one. */
function shortTerms(n: number): string[] {
	return Array.from({ length: n }, (_v, i) => `t${String(i)}`);
}

/** Builds n long multi-word terms so the keyterm token budget bites first. */
function longTerms(n: number): string[] {
	return Array.from(
		{ length: n },
		(_v, i) => `Distributed systems consensus protocol term ${String(i)}`,
	);
}

describe('deepgramBiasMechanism', () => {
	it('uses keyterm for the Nova-3 family', () => {
		expect(deepgramBiasMechanism('nova-3')).toBe('keyterm');
		expect(deepgramBiasMechanism('nova-3-general')).toBe('keyterm');
		expect(deepgramBiasMechanism('nova-3-medical')).toBe('keyterm');
	});

	it('uses keywords for Nova-2, Nova, Enhanced, and Base', () => {
		expect(deepgramBiasMechanism('nova-2')).toBe('keywords');
		expect(deepgramBiasMechanism('nova-2-meeting')).toBe('keywords');
		expect(deepgramBiasMechanism('nova')).toBe('keywords');
		expect(deepgramBiasMechanism('enhanced-phonecall')).toBe('keywords');
		expect(deepgramBiasMechanism('base')).toBe('keywords');
	});

	it('reports no mechanism for the hosted Whisper models', () => {
		expect(deepgramBiasMechanism('whisper')).toBeNull();
		expect(deepgramBiasMechanism('whisper-medium')).toBeNull();
	});
});

describe('tokenUpperBound', () => {
	it('counts UTF-8 bytes so it never undershoots the real token count', () => {
		expect(tokenUpperBound('')).toBe(0);
		expect(tokenUpperBound('abcd')).toBe(4);
	});

	it('counts multi-byte scripts by byte length, not character count', () => {
		// Each Cyrillic code point is two UTF-8 bytes, so a four-character term
		// is eight bytes; a chars/4 average would have reported just one token.
		expect(tokenUpperBound('тест')).toBe(8);
	});
});

describe('termsWithinWhisperPrompt', () => {
	it('keeps a short list intact', () => {
		expect(termsWithinWhisperPrompt(['Kubernetes', 'gRPC'])).toEqual([
			'Kubernetes',
			'gRPC',
		]);
	});

	it('stops before the joined prompt exceeds the token window', () => {
		const applied = termsWithinWhisperPrompt(manyTerms(400));
		expect(applied.length).toBeLessThan(400);
		expect(tokenUpperBound(applied.join(', '))).toBeLessThanOrEqual(
			WHISPER_PROMPT_TOKEN_LIMIT,
		);
	});

	it('bounds a non-Latin dictionary by its real byte length', () => {
		// Cyrillic terms cost about two bytes per character, so a modest count
		// still overflows the 224-token window; the chars/4 average undershot it.
		const terms = Array.from(
			{ length: 80 },
			(_v, i) => `Термин${String(i)}`,
		);
		const applied = termsWithinWhisperPrompt(terms);
		expect(applied.length).toBeLessThan(terms.length);
		expect(tokenUpperBound(applied.join(', '))).toBeLessThanOrEqual(
			WHISPER_PROMPT_TOKEN_LIMIT,
		);
	});
});

describe('planDictionaryBias', () => {
	const terms = ['Kubernetes', 'gRPC'];

	it('drops everything for an empty dictionary', () => {
		const plan = planDictionaryBias(
			TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
			'nova-3',
			[],
		);
		expect(plan.applied).toEqual([]);
		expect(plan.omitted).toEqual([]);
	});

	it('passes terms through for Deepgram Nova-3 within the limit', () => {
		const plan = planDictionaryBias(
			TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
			'nova-3',
			terms,
		);
		expect(plan.applied).toEqual(terms);
		expect(plan.omitted).toEqual([]);
		expect(plan.reason).toBeUndefined();
	});

	it('caps Deepgram Nova-3 keyterms at the entry limit', () => {
		// Short terms stay well under the aggregate token budget, so the entry
		// count is the bound that bites.
		const input = shortTerms(DEEPGRAM_KEYTERM_LIMIT + 25);
		const plan = planDictionaryBias(
			TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
			'nova-3',
			input,
		);
		expect(plan.applied).toHaveLength(DEEPGRAM_KEYTERM_LIMIT);
		expect(plan.omitted).toHaveLength(25);
		expect(plan.reason).toBe('keyterm-limit');
	});

	it('caps Deepgram Nova-3 keyterms at the aggregate token budget', () => {
		// A few dozen long multi-word terms breach the 500-token aggregate well
		// before the 100-entry count, so the token budget is the binding limit.
		const input = longTerms(60);
		const plan = planDictionaryBias(
			TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
			'nova-3',
			input,
		);
		expect(plan.applied.length).toBeGreaterThan(0);
		expect(plan.applied.length).toBeLessThan(DEEPGRAM_KEYTERM_LIMIT);
		expect(plan.omitted.length).toBeGreaterThan(0);
		expect(plan.reason).toBe('keyterm-token-budget');
		const aggregate = plan.applied.reduce(
			(sum, term) => sum + tokenUpperBound(term),
			0,
		);
		expect(aggregate).toBeLessThanOrEqual(DEEPGRAM_KEYTERM_TOKEN_LIMIT);
	});

	it('passes a short list through for a Deepgram keywords model', () => {
		const input = manyTerms(DEEPGRAM_KEYWORDS_LIMIT - 1);
		const plan = planDictionaryBias(
			TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
			'nova-2',
			input,
		);

		expect(plan.applied).toEqual(input);
		expect(plan.omitted).toEqual([]);
		expect(plan).not.toHaveProperty('reason');
	});

	it('caps Deepgram keywords models at the entry limit', () => {
		const input = manyTerms(DEEPGRAM_KEYWORDS_LIMIT + 25);
		const plan = planDictionaryBias(
			TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
			'nova-2',
			input,
		);
		expect(plan.applied).toHaveLength(DEEPGRAM_KEYWORDS_LIMIT);
		expect(plan.omitted).toHaveLength(25);
		expect(plan.reason).toBe('keywords-limit');
	});

	it('drops the whole dictionary for a Deepgram Whisper model', () => {
		const plan = planDictionaryBias(
			TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
			'whisper-medium',
			terms,
		);
		expect(plan.applied).toEqual([]);
		expect(plan.omitted).toEqual(terms);
		expect(plan.reason).toBe('model-unsupported');
	});

	it('bounds the Whisper API dictionary to the prompt window', () => {
		const input = manyTerms(400);
		const plan = planDictionaryBias(
			TRANSCRIPTION_PROVIDER_IDS.WHISPER_API,
			'nova-3',
			input,
		);
		expect(plan.applied.length).toBeLessThan(input.length);
		expect(plan.omitted.length).toBeGreaterThan(0);
		expect(plan.reason).toBe('prompt-window');
		expect(plan.applied.length + plan.omitted.length).toBe(input.length);
	});

	it('bounds local whisper.cpp the same way as the Whisper API', () => {
		const input = manyTerms(400);
		const plan = planDictionaryBias(
			TRANSCRIPTION_PROVIDER_IDS.LOCAL_WHISPER,
			'nova-3',
			input,
		);
		expect(plan.reason).toBe('prompt-window');
		expect(tokenUpperBound(plan.applied.join(', '))).toBeLessThanOrEqual(
			WHISPER_PROMPT_TOKEN_LIMIT,
		);
	});

	it('sends every term for Gemini (no hard cap)', () => {
		const input = manyTerms(400);
		const plan = planDictionaryBias(
			TRANSCRIPTION_PROVIDER_IDS.GEMINI,
			'nova-3',
			input,
		);
		expect(plan.applied).toEqual(input);
		expect(plan.omitted).toEqual([]);
	});
});

describe('describeDictionaryOmission', () => {
	it('is null when nothing was dropped', () => {
		expect(
			describeDictionaryOmission({ applied: ['a'], omitted: [] }),
		).toBeNull();
	});

	it('names the Deepgram model when biasing is unsupported', () => {
		const message = describeDictionaryOmission({
			applied: [],
			omitted: ['a', 'b'],
			reason: 'model-unsupported',
		});
		expect(message).toContain('Deepgram model');
	});

	it('reports the applied and total counts for the keyterm limit', () => {
		const message = describeDictionaryOmission({
			applied: manyTerms(DEEPGRAM_KEYTERM_LIMIT),
			omitted: manyTerms(5),
			reason: 'keyterm-limit',
		});
		expect(message).toContain(String(DEEPGRAM_KEYTERM_LIMIT));
		expect(message).toContain(String(DEEPGRAM_KEYTERM_LIMIT + 5));
		expect(message).toContain('keyterms');
	});

	it('names the keywords limit for keyword-boosting models', () => {
		// The two Deepgram entry caps are separate provider limits on separate
		// mechanisms. This message must quote the keywords cap, not the keyterm
		// one, even while the two constants happen to hold the same value.
		const message = describeDictionaryOmission({
			applied: manyTerms(DEEPGRAM_KEYWORDS_LIMIT),
			omitted: manyTerms(5),
			reason: 'keywords-limit',
		});
		expect(message).toContain(String(DEEPGRAM_KEYWORDS_LIMIT));
		expect(message).toContain(String(DEEPGRAM_KEYWORDS_LIMIT + 5));
		expect(message).toContain('keywords');
	});

	it('names the keyterm token budget when long terms did not fit', () => {
		const message = describeDictionaryOmission({
			applied: ['a'],
			omitted: ['b'],
			reason: 'keyterm-token-budget',
		});
		expect(message).toContain(String(DEEPGRAM_KEYTERM_TOKEN_LIMIT));
	});

	it('explains the prompt window when terms did not fit', () => {
		const message = describeDictionaryOmission({
			applied: ['a'],
			omitted: ['b'],
			reason: 'prompt-window',
		});
		expect(message).toContain('prompt');
	});
});
