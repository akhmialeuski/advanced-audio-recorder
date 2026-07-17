/**
 * Tests the dictionary biasing planner: the single place that decides which
 * terms each engine actually sends and which are dropped. It covers Deepgram's
 * per-model mechanism (keyterm for Nova-3, keywords for Nova-2 and older, none
 * for the hosted Whisper models), the Deepgram keyterm count limit, and the
 * Whisper prompt token window shared by the OpenAI API and local whisper.cpp.
 * @module tests/unit/dictionaryBias.test
 */

import {
	DEEPGRAM_KEYTERM_LIMIT,
	WHISPER_PROMPT_TOKEN_LIMIT,
	deepgramBiasMechanism,
	describeDictionaryOmission,
	estimateTokens,
	planDictionaryBias,
	termsWithinWhisperPrompt,
} from 'src/transcription/dictionaryBias';
import { TRANSCRIPTION_PROVIDER_IDS } from 'src/constants';

/** Builds n unique terms, wide enough to blow past the prompt window. */
function manyTerms(n: number): string[] {
	return Array.from({ length: n }, (_v, i) => `Kubernetes-${String(i)}`);
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

describe('estimateTokens', () => {
	it('rounds up on the four-characters-per-token heuristic', () => {
		expect(estimateTokens('')).toBe(0);
		expect(estimateTokens('abcd')).toBe(1);
		expect(estimateTokens('abcde')).toBe(2);
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
		expect(estimateTokens(applied.join(', '))).toBeLessThanOrEqual(
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

	it('caps Deepgram Nova-3 keyterms at the provider limit', () => {
		const input = manyTerms(DEEPGRAM_KEYTERM_LIMIT + 25);
		const plan = planDictionaryBias(
			TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
			'nova-3',
			input,
		);
		expect(plan.applied).toHaveLength(DEEPGRAM_KEYTERM_LIMIT);
		expect(plan.omitted).toHaveLength(25);
		expect(plan.reason).toBe('term-limit');
	});

	it('does not cap Deepgram keywords models by term count', () => {
		const input = manyTerms(DEEPGRAM_KEYTERM_LIMIT + 25);
		const plan = planDictionaryBias(
			TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
			'nova-2',
			input,
		);
		expect(plan.applied).toEqual(input);
		expect(plan.omitted).toEqual([]);
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
		expect(estimateTokens(plan.applied.join(', '))).toBeLessThanOrEqual(
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
			reason: 'term-limit',
		});
		expect(message).toContain(String(DEEPGRAM_KEYTERM_LIMIT));
		expect(message).toContain(String(DEEPGRAM_KEYTERM_LIMIT + 5));
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
