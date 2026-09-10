/**
 * Tests for the VoxtralProvider request: the timestamp granularity that is
 * unconditional because the response carries no segments without it and never
 * asks for words the answer has no shape for, the language hint that is never
 * sent because Mistral refuses it alongside that granularity, the context_bias
 * encoding that has to survive the endpoint's no-whitespace rule, and the
 * decode branch for a container it does not take - which has to rename the
 * part it decodes as well as retype it.
 */

import { VoxtralProvider } from 'src/transcription/providers/VoxtralProvider';
import { VOXTRAL_CONTEXT_BIAS_LIMIT } from 'src/transcription/dictionaryBias';
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
import { at } from '../helpers/assertions';

// Decoding an unsupported container needs OfflineAudioContext, which jsdom
// lacks; mock the audio helpers so the decode branch is testable by eye.
jest.mock('src/transcription/audioChunks', () => ({
	decodeToMono16k: jest.fn().mockResolvedValue(new Float32Array(4)),
	encodeMonoWav: jest.fn().mockReturnValue(new ArrayBuffer(16)),
}));

// The platform ceiling is a real byte count no fixture can reach, so the one
// answer this suite needs is stubbed while the refusal wording stays real.
jest.mock('src/platform/capabilities', () => {
	const actual = jest.requireActual<
		typeof import('src/platform/capabilities')
	>('src/platform/capabilities');
	return { ...actual, isDecodableSize: jest.fn(() => true) };
});

const BASE_URL = 'https://mistral.example/v1';
const MODEL = 'voxtral-mini-latest';

/** The containers under test, each with the extension it is stored under. */
const CONTAINERS = {
	wav: 'audio/wav',
	mp3: 'audio/mpeg',
	webm: 'audio/webm',
} as const;

/**
 * A payload as a vault file arrives: the container's own MIME type and a name
 * carrying the matching extension. Both come from one argument on purpose, so
 * no fixture can quietly hold a name and a type that disagree - which is the
 * very thing the upload part has to keep true after a decode.
 */
function payload(extension: keyof typeof CONTAINERS = 'wav'): AudioPayload {
	return {
		data: new ArrayBuffer(8),
		contentType: CONTAINERS[extension],
		filename: `rec.${extension}`,
		offsetSeconds: 0,
	};
}

/** The filename the single file part was sent under. */
function uploadFilename(body: string): string | undefined {
	return /name="file"; filename="([^"]*)"/.exec(body)?.[1];
}

/** Records every request and returns a minimal transcript. */
function capture(): MockRequestUrlParam[] {
	const calls: MockRequestUrlParam[] = [];
	withRequestUrl((param): MockRequestUrlResponse => {
		calls.push(param);
		return {
			status: 200,
			headers: {},
			text: JSON.stringify({ text: 'hi', segments: [] }),
		};
	});
	return calls;
}

function bodyText(calls: MockRequestUrlParam[]): string {
	return new TextDecoder().decode(at(calls, 0).body as ArrayBuffer);
}

/** The values one repeated multipart field carries, in order. */
function fieldValues(body: string, name: string): string[] {
	const pattern = new RegExp(
		`name="${name}"\\r\\n\\r\\n([^\\r]*)\\r\\n`,
		'g',
	);
	return [...body.matchAll(pattern)].map((match) => match[1] ?? '');
}

function provider(): VoxtralProvider {
	return new VoxtralProvider({
		baseUrl: BASE_URL,
		apiKey: 'k',
		model: MODEL,
	});
}

/** The options a run carries, with only what a test cares about differing. */
function options(
	overrides: Partial<TranscribeOptions> = {},
): TranscribeOptions {
	return { diarize: false, wordTimestamps: false, ...overrides };
}

describe('VoxtralProvider request fields', () => {
	it('posts to the transcriptions path with a bearer key', async () => {
		const calls = capture();

		await provider().transcribe(payload(), options());

		expect(at(calls, 0).url).toBe(
			'https://mistral.example/v1/audio/transcriptions',
		);
		expect(at(calls, 0).headers?.Authorization).toBe('Bearer k');
		expect(fieldValues(bodyText(calls), 'model')).toEqual([MODEL]);
	});

	it.each([{ wordTimestamps: false }, { wordTimestamps: true }])(
		'asks for the segment level alone, with per-word timing $wordTimestamps',
		async ({ wordTimestamps }) => {
			// Mistral's answer models no per-word shape: a response is
			// {model, text, usage, language, segments} and a segment is
			// {text, start, end, score, speaker_id} with a fixed type. Asking
			// for the word level would either be refused or come back as
			// one-word segments, so the request never asks whatever is stored.
			const calls = capture();

			await provider().transcribe(payload(), options({ wordTimestamps }));

			expect(
				fieldValues(bodyText(calls), 'timestamp_granularities'),
			).toEqual(['segment']);
		},
	);

	it.each([
		{ name: 'a code is configured', language: 'ru' },
		{ name: 'the run also asks for per-word timing', language: 'en' },
	])('leaves the language out when $name', async ({ language }) => {
		// Mistral refuses `language` alongside `timestamp_granularities`, and
		// the granularity is what makes the response carry segments at all, so
		// the hint is the one that gives way - on every run, whatever is stored.
		const calls = capture();

		await provider().transcribe(
			payload(),
			options({ language, wordTimestamps: true }),
		);

		expect(bodyText(calls)).not.toContain('name="language"');
	});

	it.each([
		{
			name: 'sends diarize when the run asks for speaker labels',
			diarize: true,
			expected: ['true'],
		},
		{
			name: 'leaves diarize out when the run asks for none',
			diarize: false,
			expected: [],
		},
	])('$name', async ({ diarize, expected }) => {
		const calls = capture();

		await provider().transcribe(payload(), options({ diarize }));

		expect(fieldValues(bodyText(calls), 'diarize')).toEqual(expected);
	});
});

describe('VoxtralProvider context bias', () => {
	it('joins a multi-word term with underscores', async () => {
		// The endpoint constrains an entry to `^[^,\s]+$`, and Mistral's own
		// examples write a phrase as `affordable_health_care`.
		const calls = capture();

		await provider().transcribe(
			payload(),
			options({ dictionary: ['affordable health care', 'Kubernetes'] }),
		);

		expect(fieldValues(bodyText(calls), 'context_bias')).toEqual([
			'affordable_health_care',
			'Kubernetes',
		]);
	});

	it('replaces a comma inside a term rather than sending it', async () => {
		const calls = capture();

		await provider().transcribe(
			payload(),
			options({ dictionary: ['Smith, John'] }),
		);

		expect(fieldValues(bodyText(calls), 'context_bias')).toEqual([
			'Smith_John',
		]);
	});

	it('sends generated keyterms ahead of the dictionary', async () => {
		// When the entry cap bites, the context mined from this very recording
		// wins over the static glossary.
		const calls = capture();

		await provider().transcribe(
			payload(),
			options({ keyterms: ['Catchain'], dictionary: ['Kubernetes'] }),
		);

		expect(fieldValues(bodyText(calls), 'context_bias')).toEqual([
			'Catchain',
			'Kubernetes',
		]);
	});

	it('sends a term both lists carry only once', async () => {
		// The pipeline mines terms from the recording and the glossary may
		// hold the same one; sending it twice would spend two of the hundred
		// entries on one word.
		const calls = capture();

		await provider().transcribe(
			payload(),
			options({ keyterms: ['Catchain'], dictionary: ['catchain'] }),
		);

		expect(fieldValues(bodyText(calls), 'context_bias')).toEqual([
			'Catchain',
		]);
	});

	it('caps the entries at the request limit', async () => {
		const calls = capture();
		const terms = Array.from(
			{ length: VOXTRAL_CONTEXT_BIAS_LIMIT + 12 },
			(_unused, index) => `term${String(index)}`,
		);

		await provider().transcribe(payload(), options({ dictionary: terms }));

		expect(fieldValues(bodyText(calls), 'context_bias')).toHaveLength(
			VOXTRAL_CONTEXT_BIAS_LIMIT,
		);
	});

	it('omits the field when the run biases nothing', async () => {
		const calls = capture();

		await provider().transcribe(payload(), options());

		expect(bodyText(calls)).not.toContain('name="context_bias"');
	});
});

describe('VoxtralProvider container handling', () => {
	it('uploads an accepted container untouched, under its own name', async () => {
		const calls = capture();

		await provider().transcribe(payload('mp3'), options());

		const body = bodyText(calls);
		expect(body).toContain('Content-Type: audio/mpeg');
		expect(uploadFilename(body)).toBe('rec.mp3');
	});

	it('renames the part it decodes to match the bytes it now holds', async () => {
		// webm is what this plugin records by default and is absent from the
		// endpoint's list, so it is decoded to 16 kHz mono WAV before upload.
		// Mistral's own client reads a part's type from its filename, so a WAV
		// body still called `.webm` announces one container in the header and
		// another in the name - on this engine's most common input.
		const calls = capture();

		await provider().transcribe(payload('webm'), options());

		const body = bodyText(calls);
		expect(body).toContain('Content-Type: audio/wav');
		expect(uploadFilename(body)).toBe('rec.wav');
	});

	it('refuses a container it would have to decode past the memory ceiling', async () => {
		// The decode expands the whole recording to PCM, and this engine
		// declares no duration cap, so it is handed whole recordings of any
		// length; on a phone that allocation is not a catchable error.
		const { isDecodableSize } = jest.requireMock<{
			isDecodableSize: jest.Mock;
		}>('src/platform/capabilities');
		isDecodableSize.mockReturnValueOnce(false);
		const calls = capture();

		await expect(
			provider().transcribe(payload('webm'), options()),
		).rejects.toThrow(/too large to transcribe with Mistral Voxtral/);
		expect(calls).toHaveLength(0);
	});
});
