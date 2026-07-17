/**
 * Tests that WhisperApiProvider forwards the custom dictionary as the OpenAI
 * `prompt` multipart field, comma-joined, and omits it when empty. The provider
 * builds a raw multipart body, so the outgoing request is captured through the
 * shared requestUrl mock and decoded back to text to inspect the field.
 * @module tests/unit/WhisperApiProviderDictionary.test
 */

import { WhisperApiProvider } from 'src/transcription/providers/WhisperApiProvider';
import type { AudioPayload } from 'src/transcription/providers/TranscriptionProvider';
import {
	__setRequestUrlHandler,
	type MockRequestUrlParam,
	type MockRequestUrlResponse,
} from 'obsidian';

const BASE_URL = 'https://whisper.example';

function payload(): AudioPayload {
	return {
		data: new ArrayBuffer(8),
		contentType: 'audio/wav',
		filename: 'rec.wav',
		offsetSeconds: 0,
	};
}

/** Records every request and returns a minimal transcript. */
function capture(): MockRequestUrlParam[] {
	const calls: MockRequestUrlParam[] = [];
	__setRequestUrlHandler((param): MockRequestUrlResponse => {
		calls.push(param);
		return {
			status: 200,
			headers: {},
			text: JSON.stringify({ text: 'hi' }),
		};
	});
	return calls;
}

function bodyText(calls: MockRequestUrlParam[]): string {
	return new TextDecoder().decode(calls[0].body as ArrayBuffer);
}

function provider(): WhisperApiProvider {
	return new WhisperApiProvider({
		baseUrl: BASE_URL,
		apiKey: 'k',
		model: 'whisper-1',
	});
}

afterEach(() => {
	__setRequestUrlHandler(null);
});

describe('WhisperApiProvider dictionary biasing', () => {
	it('sends the dictionary as a comma-joined prompt field', async () => {
		const calls = capture();

		await provider().transcribe(payload(), {
			diarize: false,
			wordTimestamps: false,
			dictionary: ['Kubernetes', 'gRPC'],
		});

		const decoded = bodyText(calls);
		expect(decoded).toContain('name="prompt"');
		expect(decoded).toContain('Kubernetes, gRPC');
	});

	it('omits the prompt field when the dictionary is empty', async () => {
		const calls = capture();

		await provider().transcribe(payload(), {
			diarize: false,
			wordTimestamps: false,
		});

		expect(bodyText(calls)).not.toContain('name="prompt"');
	});
});
