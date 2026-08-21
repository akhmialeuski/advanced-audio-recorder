/**
 * What the OpenAI-compatible Whisper provider puts in its request.
 *
 * Everything the run asked for has to survive the trip into a multipart body -
 * the dictionary as the `prompt` field, the language, the timing granularity -
 * and everything it did not ask for has to stay out of it, since a stray
 * `language` field turns off detection and word granularity multiplies the
 * response. The provider builds the body by hand, so the outgoing request is
 * captured through the shared requestUrl mock and decoded back to text.
 * @module tests/unit/WhisperApiProvider.test
 */

import { WhisperApiProvider } from 'src/transcription/providers/WhisperApiProvider';
import { at } from '../helpers/assertions';
import type {
	AudioPayload,
	TranscribeOptions,
} from 'src/transcription/providers/TranscriptionProvider';
// Mock-only surface: these exist on the test double, not on Obsidian's
// API, so they are imported from the mock by path. Jest maps 'obsidian'
// to the same module, so both imports share one instance.
import {
	type MockRequestUrlParam,
	type MockRequestUrlResponse,
} from '../mocks/obsidian';
import { withRequestUrl } from '../helpers/network';
import { WHISPER_PROMPT_TOKEN_LIMIT } from 'src/transcription/dictionaryBias';

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
	withRequestUrl((param): MockRequestUrlResponse => {
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
	return new TextDecoder().decode(at(calls, 0).body as ArrayBuffer);
}

function provider(): WhisperApiProvider {
	return new WhisperApiProvider({
		baseUrl: BASE_URL,
		apiKey: 'k',
		model: 'whisper-1',
	});
}

/** The options a run carries, with only what a test cares about differing. */
function options(
	overrides: Partial<TranscribeOptions> = {},
): TranscribeOptions {
	return { diarize: false, wordTimestamps: false, ...overrides };
}

describe('WhisperApiProvider request fields', () => {
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

	// The service bounds the dictionary and warns about what it dropped, but
	// a directly driven provider has to bound it too - and a single term
	// longer than the window leaves nothing at all to send.
	it('omits the prompt field when no term fits the prompt window', async () => {
		const calls = capture();

		await provider().transcribe(
			payload(),
			options({
				dictionary: ['x'.repeat(WHISPER_PROMPT_TOKEN_LIMIT + 1)],
			}),
		);

		expect(bodyText(calls)).not.toContain('name="prompt"');
	});

	it('asks for word timings only when the run wants them', async () => {
		// Word granularity multiplies the response size; requesting it for
		// every run would slow the ones that never read it.
		const calls = capture();

		await provider().transcribe(
			payload(),
			options({ wordTimestamps: true }),
		);

		expect(bodyText(calls)).toContain('word');
	});

	it('asks for segment timings alone by default', async () => {
		const calls = capture();

		await provider().transcribe(payload(), options());

		expect(bodyText(calls)).not.toContain(
			'name="timestamp_granularities[]"\r\n\r\nword',
		);
	});

	it('names the language when the run declares one', async () => {
		const calls = capture();

		await provider().transcribe(payload(), options({ language: 'ru' }));

		expect(bodyText(calls)).toContain('ru');
	});

	it('lets the service detect the language when the run declares none', async () => {
		// "auto" is the plugin's own word for it; sending it as a language
		// code would be rejected by the service.
		const calls = capture();

		await provider().transcribe(payload(), options());

		expect(bodyText(calls)).not.toContain('name="language"');
	});
});
