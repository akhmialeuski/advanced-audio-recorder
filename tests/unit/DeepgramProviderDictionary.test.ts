/**
 * Tests that DeepgramProvider forwards the custom dictionary as query params,
 * choosing keyterm for nova-3 and keywords for nova-2 and older, and sends
 * neither when the dictionary is empty. The outgoing request is captured
 * through the shared requestUrl mock (the provider has no injectable client).
 * @module tests/unit/DeepgramProviderDictionary.test
 */

import { DeepgramProvider } from 'src/transcription/providers/DeepgramProvider';
import { at } from '../helpers/assertions';
import type { AudioPayload } from 'src/transcription/providers/TranscriptionProvider';
import {
	DEEPGRAM_KEYTERM_LIMIT,
	DEEPGRAM_KEYTERM_TOKEN_LIMIT,
	DEEPGRAM_KEYWORDS_LIMIT,
	tokenUpperBound,
} from 'src/transcription/dictionaryBias';
// Mock-only surface: these exist on the test double, not on Obsidian's
// API, so they are imported from the mock by path. Jest maps 'obsidian'
// to the same module, so both imports share one instance.
import {
	__setRequestUrlHandler,
	type MockRequestUrlParam,
	type MockRequestUrlResponse,
} from '../mocks/obsidian';

const BASE_URL = 'https://deepgram.example';

function payload(): AudioPayload {
	return {
		data: new ArrayBuffer(8),
		contentType: 'audio/wav',
		filename: 'rec.wav',
		offsetSeconds: 0,
	};
}

/** Records every request and returns one valid utterance. */
function capture(): MockRequestUrlParam[] {
	const calls: MockRequestUrlParam[] = [];
	__setRequestUrlHandler((param): MockRequestUrlResponse => {
		calls.push(param);
		return {
			status: 200,
			headers: {},
			text: JSON.stringify({
				results: {
					utterances: [{ transcript: 'hello', start: 0, end: 1 }],
				},
			}),
		};
	});
	return calls;
}

function queryOf(calls: MockRequestUrlParam[]): URLSearchParams {
	return new URL(at(calls, 0).url).searchParams;
}

afterEach(() => {
	__setRequestUrlHandler(null);
});

describe('DeepgramProvider dictionary biasing', () => {
	it('sends each term as a keyterm param on nova-3', async () => {
		const calls = capture();
		const provider = new DeepgramProvider({
			baseUrl: BASE_URL,
			apiKey: 'k',
			model: 'nova-3',
		});

		await provider.transcribe(payload(), {
			diarize: false,
			wordTimestamps: false,
			dictionary: ['Kubernetes', 'gRPC'],
		});

		const params = queryOf(calls);
		expect(params.getAll('keyterm')).toEqual(['Kubernetes', 'gRPC']);
		expect(params.getAll('keywords')).toEqual([]);
	});

	it('sends each term as a keywords param on nova-2 and older', async () => {
		const calls = capture();
		const provider = new DeepgramProvider({
			baseUrl: BASE_URL,
			apiKey: 'k',
			model: 'nova-2',
		});

		await provider.transcribe(payload(), {
			diarize: false,
			wordTimestamps: false,
			dictionary: ['Kubernetes', 'gRPC'],
		});

		const params = queryOf(calls);
		expect(params.getAll('keywords')).toEqual(['Kubernetes', 'gRPC']);
		expect(params.getAll('keyterm')).toEqual([]);
	});

	it('sends no biasing param when the dictionary is empty', async () => {
		const calls = capture();
		const provider = new DeepgramProvider({
			baseUrl: BASE_URL,
			apiKey: 'k',
			model: 'nova-3',
		});

		await provider.transcribe(payload(), {
			diarize: false,
			wordTimestamps: false,
		});

		const params = queryOf(calls);
		expect(params.has('keyterm')).toBe(false);
		expect(params.has('keywords')).toBe(false);
	});

	it('sends neither param for a hosted Whisper model that cannot bias', async () => {
		const calls = capture();
		const provider = new DeepgramProvider({
			baseUrl: BASE_URL,
			apiKey: 'k',
			model: 'whisper-medium',
		});

		await provider.transcribe(payload(), {
			diarize: false,
			wordTimestamps: false,
			dictionary: ['Kubernetes', 'gRPC'],
		});

		const params = queryOf(calls);
		expect(params.has('keyterm')).toBe(false);
		expect(params.has('keywords')).toBe(false);
	});

	it('trims keyterms to the entry and token limits on nova-3', async () => {
		const calls = capture();
		const provider = new DeepgramProvider({
			baseUrl: BASE_URL,
			apiKey: 'k',
			model: 'nova-3',
		});

		const dictionary = Array.from(
			{ length: 200 },
			(_v, i) => `term-${String(i)}`,
		);
		await provider.transcribe(payload(), {
			diarize: false,
			wordTimestamps: false,
			dictionary,
		});

		// The provider trims defensively even when handed a longer list: at most
		// 100 keyterms and no more than the aggregate token budget Deepgram allows.
		const keyterms = queryOf(calls).getAll('keyterm');
		expect(keyterms.length).toBeGreaterThan(0);
		expect(keyterms.length).toBeLessThanOrEqual(DEEPGRAM_KEYTERM_LIMIT);
		const aggregate = keyterms.reduce(
			(sum, term) => sum + tokenUpperBound(term),
			0,
		);
		expect(aggregate).toBeLessThanOrEqual(DEEPGRAM_KEYTERM_TOKEN_LIMIT);
	});

	it('caps keywords at the provider limit on nova-2', async () => {
		const calls = capture();
		const provider = new DeepgramProvider({
			baseUrl: BASE_URL,
			apiKey: 'k',
			model: 'nova-2',
		});

		const dictionary = Array.from(
			{ length: DEEPGRAM_KEYWORDS_LIMIT + 30 },
			(_v, i) => `term-${String(i)}`,
		);
		await provider.transcribe(payload(), {
			diarize: false,
			wordTimestamps: false,
			dictionary,
		});

		expect(queryOf(calls).getAll('keywords')).toHaveLength(
			DEEPGRAM_KEYWORDS_LIMIT,
		);
	});
});
