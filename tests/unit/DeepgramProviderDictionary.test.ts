/**
 * Tests that DeepgramProvider forwards the custom dictionary as query params,
 * choosing keyterm for nova-3 and keywords for nova-2 and older, and sends
 * neither when the dictionary is empty. The outgoing request is captured
 * through the shared requestUrl mock (the provider has no injectable client).
 * @module tests/unit/DeepgramProviderDictionary.test
 */

import { DeepgramProvider } from 'src/transcription/providers/DeepgramProvider';
import type { AudioPayload } from 'src/transcription/providers/TranscriptionProvider';
import {
	__setRequestUrlHandler,
	type MockRequestUrlParam,
	type MockRequestUrlResponse,
} from 'obsidian';

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
	return new URL(calls[0].url).searchParams;
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
});
