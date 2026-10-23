/**
 * Tests for the VoxtralProvider request: the segment granularity that is
 * unconditional because the response carries no segments without it and is
 * never joined by a second the endpoint refuses, the language hint that is never
 * sent because Mistral refuses it alongside that granularity, the context_bias
 * encoding that has to survive the endpoint's no-whitespace rule, the payload
 * uploaded as it was lent, and the deadline a whole-file request is given.
 * Which containers reach the provider undecoded, and the three-hour split of a
 * decoded recording, belong to the capability and to audio preparation, and are
 * tested there.
 */

import { VoxtralProvider } from 'src/transcription/providers/VoxtralProvider';
import { VOXTRAL_CONTEXT_BIAS_LIMIT } from 'src/transcription/dictionaryBias';
import { VOXTRAL_TRANSCRIBE_MIN_TIMEOUT_MS } from 'src/constants';
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

const BASE_URL = 'https://mistral.example/v1';
const MODEL = 'voxtral-mini-latest';

/** The containers under test, each with the extension it is stored under. */
const CONTAINERS = {
	wav: 'audio/wav',
	mp3: 'audio/mpeg',
	m4a: 'audio/mp4',
} as const;

/**
 * A payload as a vault file arrives: the container's own MIME type and a name
 * carrying the matching extension. Both come from one argument on purpose, so
 * no fixture can quietly hold a name and a type that disagree.
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
 * Several cases differ only in the container they hand over and read the same
 * two things back out of the request, so the arrangement is named once here.
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

	it.each([{ wordTimestamps: false }, { wordTimestamps: true }])(
		'asks for the segment level alone, with per-word timing $wordTimestamps',
		async ({ wordTimestamps }) => {
			// The endpoint's enum takes `word`, but neither way of asking for
			// it is usable: naming both levels is refused with a 422 that
			// concatenated the fields into `segmentword`, and naming `word`
			// alone answers in the same `segments` array with one segment per
			// word, replacing the sentences the transcript is assembled from.
			// So this field carries the segment level whatever the switch
			// stores, and never grows a second value.
			const calls = capture();

			await provider().transcribe(
				payload(),
				transcribeOptions({ wordTimestamps }),
			);

			expect(
				fieldValues(requestBodyText(calls), 'timestamp_granularities'),
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

describe('VoxtralProvider upload', () => {
	it.each([
		{ extension: 'mp3', type: 'audio/mpeg' },
		{ extension: 'wav', type: 'audio/wav' },
		{ extension: 'm4a', type: 'audio/mp4' },
	] as const)(
		'uploads $extension as it stands, under its own name',
		async ({ extension, type }) => {
			const body = await uploadedBody(extension);

			expect(body).toContain(`Content-Type: ${type}`);
			expect(uploadFilename(body)).toBe(`rec.${extension}`);
		},
	);

	// The service sends the same payload again after a refusal it waits out,
	// so the provider may only read what it was lent (issue #136).
	it('leaves the payload it uploaded readable for the next send', async () => {
		capture();
		const lent = payload('wav');

		await provider().transcribe(lent, transcribeOptions());

		expect(lent.data.byteLength).toBe(8);
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
