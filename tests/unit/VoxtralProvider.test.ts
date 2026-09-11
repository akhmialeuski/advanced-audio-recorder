/**
 * Tests for the VoxtralProvider request: the segment granularity that is
 * unconditional because the response carries no segments without it, the word
 * granularity that joins it on request, the language hint that is never
 * sent because Mistral refuses it alongside that granularity, the context_bias
 * encoding that has to survive the endpoint's no-whitespace rule, and the
 * decode branch for a container it does not take - which has to rename the
 * part it decodes as well as retype it - the two ceilings one request is proven
 * against, and the deadline a whole-file request is given.
 */

import { VoxtralProvider } from 'src/transcription/providers/VoxtralProvider';
import { VOXTRAL_CONTEXT_BIAS_LIMIT } from 'src/transcription/dictionaryBias';
import {
	TRANSCRIBE_SAMPLE_RATE,
	VOXTRAL_MAX_REQUEST_SECONDS,
	VOXTRAL_TRANSCRIBE_MIN_TIMEOUT_MS,
} from 'src/constants';
import type { AudioPayload } from 'src/transcription/providers/TranscriptionProvider';
// Mock-only surface: these exist on the test double, not on Obsidian's
// API, so they are imported from the mock by path. Jest maps 'obsidian'
// to the same module, so both imports share one instance.
import {
	type MockRequestUrlParam,
	type MockRequestUrlResponse,
} from '../mocks/obsidian';
import { requestBodyText, withRequestUrl } from '../helpers/network';
import { at } from '../helpers/assertions';
import { transcribeOptions } from '../helpers/providerFixtures';
// The same module instance the jest.mock factory installs, so this is the
// double the provider actually calls.
import { decodeToMono16k, decodedSamples } from '../mocks/modules/audioChunks';

// Decoding an unsupported container needs OfflineAudioContext, which jsdom
// lacks; mock the audio helpers so the decode branch is testable by eye.
jest.mock('src/transcription/audioChunks', () =>
	require('../mocks/modules/audioChunks'),
);

const BASE_URL = 'https://mistral.example/v1';
const MODEL = 'voxtral-mini-latest';

/**
 * The containers under test, each with the extension it is stored under.
 *
 * `m4a` and `mp4` carry the same MIME type on purpose: that is what the format
 * registry gives both, only the first is on Mistral's list, and the second is
 * what iOS falls back to recording in.
 */
const CONTAINERS = {
	wav: 'audio/wav',
	mp3: 'audio/mpeg',
	m4a: 'audio/mp4',
	mp4: 'audio/mp4',
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

/**
 * The multipart body a run over one container produces.
 *
 * Four cases differ only in the container they hand over and read the same two
 * things back out of the request, so the arrangement is named once here.
 * @param extension - The container the vault file is stored as
 * @returns The request body as text
 */
async function uploadedBody(
	extension: keyof typeof CONTAINERS,
): Promise<string> {
	const calls = capture();

	await provider().transcribe(payload(extension), transcribeOptions());

	return requestBodyText(calls);
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

describe('VoxtralProvider request fields', () => {
	it('posts to the transcriptions path with a bearer key', async () => {
		const calls = capture();

		await provider().transcribe(payload(), transcribeOptions());

		expect(at(calls, 0).url).toBe(
			'https://mistral.example/v1/audio/transcriptions',
		);
		expect(at(calls, 0).headers?.Authorization).toBe('Bearer k');
		expect(fieldValues(requestBodyText(calls), 'model')).toEqual([MODEL]);
	});

	it.each([
		{
			name: 'the segment level alone when no per-word timing is asked for',
			wordTimestamps: false,
			expected: ['segment'],
		},
		{
			name: 'the word level alongside it when the run asks for one',
			wordTimestamps: true,
			expected: ['segment', 'word'],
		},
	])('asks for $name', async ({ wordTimestamps, expected }) => {
		// The segment level is unconditional, because without a granularity the
		// response carries no segments at all and the transcript is assembled
		// from them. The word level only annotates those segments, so it is
		// added alongside rather than in place of it.
		const calls = capture();

		await provider().transcribe(
			payload(),
			transcribeOptions({ wordTimestamps }),
		);

		expect(
			fieldValues(requestBodyText(calls), 'timestamp_granularities'),
		).toEqual(expected);
	});

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
			transcribeOptions({ language, wordTimestamps: true }),
		);

		expect(requestBodyText(calls)).not.toContain('name="language"');
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

		await provider().transcribe(payload(), transcribeOptions({ diarize }));

		expect(fieldValues(requestBodyText(calls), 'diarize')).toEqual(
			expected,
		);
	});
});

describe('VoxtralProvider context bias', () => {
	it('joins a multi-word term with underscores', async () => {
		// Mistral's own examples write a phrase as `affordable_health_care`;
		// whether a space could survive inside one entry is undocumented.
		const calls = capture();

		await provider().transcribe(
			payload(),
			transcribeOptions({
				dictionary: ['affordable health care', 'Kubernetes'],
			}),
		);

		expect(fieldValues(requestBodyText(calls), 'context_bias')).toEqual([
			'affordable_health_care',
			'Kubernetes',
		]);
	});

	it('replaces a comma inside a term rather than sending it', async () => {
		const calls = capture();

		await provider().transcribe(
			payload(),
			transcribeOptions({ dictionary: ['Smith, John'] }),
		);

		expect(fieldValues(requestBodyText(calls), 'context_bias')).toEqual([
			'Smith_John',
		]);
	});

	it('sends generated keyterms ahead of the dictionary', async () => {
		// When the entry cap bites, the context mined from this very recording
		// wins over the static glossary.
		const calls = capture();

		await provider().transcribe(
			payload(),
			transcribeOptions({
				keyterms: ['Catchain'],
				dictionary: ['Kubernetes'],
			}),
		);

		expect(fieldValues(requestBodyText(calls), 'context_bias')).toEqual([
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
			transcribeOptions({
				keyterms: ['Catchain'],
				dictionary: ['catchain'],
			}),
		);

		expect(fieldValues(requestBodyText(calls), 'context_bias')).toEqual([
			'Catchain',
		]);
	});

	it('caps the entries at the request limit', async () => {
		const calls = capture();
		const terms = Array.from(
			{ length: VOXTRAL_CONTEXT_BIAS_LIMIT + 12 },
			(_unused, index) => `term${String(index)}`,
		);

		await provider().transcribe(
			payload(),
			transcribeOptions({ dictionary: terms }),
		);

		expect(
			fieldValues(requestBodyText(calls), 'context_bias'),
		).toHaveLength(VOXTRAL_CONTEXT_BIAS_LIMIT);
	});

	it('omits the field when the run biases nothing', async () => {
		const calls = capture();

		await provider().transcribe(payload(), transcribeOptions());

		expect(requestBodyText(calls)).not.toContain('name="context_bias"');
	});
});

describe('VoxtralProvider container handling', () => {
	it('uploads an accepted container untouched, under its own name', async () => {
		const body = await uploadedBody('mp3');

		expect(body).toContain('Content-Type: audio/mpeg');
		expect(uploadFilename(body)).toBe('rec.mp3');
	});

	it('renames the part it decodes to match the bytes it now holds', async () => {
		// webm is what this plugin records by default and is absent from the
		// endpoint's list, so it is decoded to 16 kHz mono WAV before upload.
		// Mistral's own client reads a part's type from its filename, so a WAV
		// body still called `.webm` announces one container in the header and
		// another in the name - on this engine's most common input.
		const body = await uploadedBody('webm');

		expect(body).toContain('Content-Type: audio/wav');
		expect(uploadFilename(body)).toBe('rec.wav');
	});

	it('uploads m4a untouched, the one of the two mp4 names Mistral lists', async () => {
		expect(uploadFilename(await uploadedBody('m4a'))).toBe('rec.m4a');
	});

	it('decodes mp4, which shares the m4a type but is not on the list', async () => {
		// The two containers are one `audio/mp4` in the format registry and
		// Mistral lists only m4a, so a type-keyed gate sent every iOS recording
		// - mp4 is what that platform falls back to - as a container the
		// endpoint never claimed to read. The name is what decides instead.
		const body = await uploadedBody('mp4');

		expect(body).toContain('Content-Type: audio/wav');
		expect(uploadFilename(body)).toBe('rec.wav');
	});

	it('refuses a recording past the three hours one request carries', async () => {
		// The engine's two ceilings are hours apart: three hours is about 346 MB
		// of this WAV against a 1 GB request, so proving only the bytes uploaded
		// about nine hours of audio before Mistral declined it. The capability
		// stays unbounded so whole containers keep being uploaded untouched,
		// which is why the endpoint's real limit has to reach the decode path.
		const calls = capture();
		decodeToMono16k.mockResolvedValueOnce(
			decodedSamples(
				(VOXTRAL_MAX_REQUEST_SECONDS + 1) * TRANSCRIBE_SAMPLE_RATE,
			),
		);

		await expect(
			provider().transcribe(payload('webm'), transcribeOptions()),
		).rejects.toThrow(
			'Recording is too long to transcribe with Mistral Voxtral in one request. Split it into parts first.',
		);
		expect(calls).toHaveLength(0);
	});
});

describe('VoxtralProvider request deadline', () => {
	afterEach(() => {
		jest.useRealTimers();
	});

	it('waits the inference floor, not the transfer budget alone', async () => {
		// The byte count funds the transfer and nothing else, so on the bare
		// two-minute floor a whole recording of up to three hours was abandoned
		// while the endpoint was still transcribing it. The deadline the request
		// actually got is named in the timeout it raises.
		jest.useFakeTimers();
		withRequestUrl(
			() => new Promise<MockRequestUrlResponse>(() => undefined),
		);

		const settled = provider()
			.transcribe(payload(), transcribeOptions())
			.catch((error: unknown) => error);
		await jest.advanceTimersByTimeAsync(VOXTRAL_TRANSCRIBE_MIN_TIMEOUT_MS);

		expect(await settled).toHaveProperty(
			'message',
			`Request to ${BASE_URL}/audio/transcriptions timed out after ${String(VOXTRAL_TRANSCRIBE_MIN_TIMEOUT_MS)} ms.`,
		);
	});
});
