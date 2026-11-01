/**
 * Tests for the GeminiProvider transcription orchestration: the upload ->
 * poll-until-ACTIVE -> generateContent -> best-effort delete flow scripted
 * through the shared requestUrl mock, the payload uploaded as it was lent, the
 * thinking-off generationConfig, and the truncation/block guards. Which
 * containers reach the provider undecoded is the capability's to say, and is
 * tested with the capabilities.
 */

import { GeminiProvider } from 'src/transcription/providers/GeminiProvider';
import { at, jsonBody } from '../helpers/assertions';
import type { AudioPayload } from 'src/transcription/providers/TranscriptionProvider';
import { DEFAULT_GEMINI_MODEL, GEMINI_INLINE_MAX_BYTES } from 'src/constants';
// Mock-only surface: these exist on the test double, not on Obsidian's
// API, so they are imported from the mock by path. Jest maps 'obsidian'
// to the same module, so both imports share one instance.
import {
	type MockRequestUrlParam,
	type MockRequestUrlResponse,
} from '../mocks/obsidian';
import { withRequestUrl } from '../helpers/network';
import { outcomeOf, tick, waitFor } from '../helpers/async';

const BASE_URL = 'https://gemini.example';

/** The smallest payload that no longer fits an inline request. */
const FILE_API_BYTES = GEMINI_INLINE_MAX_BYTES + 1;
const API_KEY = 'gm-test';
const MODEL = 'gemini-2.5-flash';

/** Shape of the generateContent request body the provider posts. */
interface GeneratePart {
	fileData?: { mimeType: string; fileUri: string };
	inlineData?: { mimeType: string; data: string };
	text?: string;
}
interface GenerateBody {
	contents: { parts: GeneratePart[] }[];
	systemInstruction: { parts: { text: string }[] };
	generationConfig: {
		temperature: number;
		responseMimeType: string;
		responseSchema: {
			properties: {
				segments: {
					items: {
						properties: Record<
							string,
							{ type?: string; enum?: string[] }
						>;
						required: string[];
					};
				};
			};
		};
		thinkingConfig?: { thinkingBudget?: number; thinkingLevel?: string };
	};
}

function provider(model = MODEL): GeminiProvider {
	return new GeminiProvider({ baseUrl: BASE_URL, apiKey: API_KEY, model });
}

/**
 * An audio payload for the provider.
 * @param contentType - The payload's MIME type
 * @param byteLength - Its size; the default fits an inline request, and
 *   {@link FILE_API_BYTES} sends it through the File API
 */
function payload(contentType: string, byteLength = 8): AudioPayload {
	return {
		data: new ArrayBuffer(byteLength),
		contentType,
		filename: 'rec',
		offsetSeconds: 0,
	};
}

/** Wraps a structured transcript as a generateContent candidate body. */
function transcriptBody(structured: unknown, finishReason = 'STOP'): string {
	return JSON.stringify({
		candidates: [
			{
				finishReason,
				content: { parts: [{ text: JSON.stringify(structured) }] },
			},
		],
	});
}

/** What the scripted endpoint answers a request with, now or later. */
type RequestUrlAnswer =
	MockRequestUrlResponse | Promise<MockRequestUrlResponse>;

interface ScriptedFlow {
	calls: MockRequestUrlParam[];
	generateBody: () => GenerateBody;
}

/**
 * Installs a handler that walks the whole upload/poll/generate/delete flow and
 * records every call; the generateContent step returns `generateText`.
 * @param generateText - The generateContent response body
 * @param uploadAnswered - Holds back the answer to the byte transfer until it
 *   settles, for a run cancelled while its bytes are still on their way
 */
function scriptFlow(
	generateText: string,
	uploadAnswered: Promise<void> = Promise.resolve(),
): ScriptedFlow {
	const calls: MockRequestUrlParam[] = [];
	withRequestUrl((param): RequestUrlAnswer => {
		calls.push(param);
		const url = param.url;
		const method = param.method ?? 'GET';
		if (url.endsWith('/upload/v1beta/files')) {
			return {
				status: 200,
				headers: { 'x-goog-upload-url': `${BASE_URL}/session` },
				text: '',
			};
		}
		if (url === `${BASE_URL}/session`) {
			return uploadAnswered.then((): MockRequestUrlResponse => ({
				status: 200,
				headers: {},
				text: JSON.stringify({
					file: {
						name: 'files/abc',
						uri: 'https://files.example/abc',
						state: 'ACTIVE',
					},
				}),
			}));
		}
		if (method === 'GET' && url === `${BASE_URL}/v1beta/files/abc`) {
			return {
				status: 200,
				headers: {},
				text: JSON.stringify({
					name: 'files/abc',
					uri: 'https://files.example/abc',
					state: 'ACTIVE',
				}),
			};
		}
		if (url.includes(':generateContent')) {
			return { status: 200, headers: {}, text: generateText };
		}
		// DELETE files/abc
		return { status: 200, headers: {}, text: '' };
	});
	return {
		calls,
		generateBody: (): GenerateBody => {
			const gen = calls.find((c) => c.url.includes(':generateContent'));
			return jsonBody<GenerateBody>(gen);
		},
	};
}

/** A flow that answers with a one-segment transcript, as most tests need. */
function scriptTranscriptFlow(): ScriptedFlow {
	return scriptFlow(transcriptBody({ segments: [{ start: 0, text: 'hi' }] }));
}

/** The instruction text sent alongside the audio, as one string. */
function instructionOf(flow: ScriptedFlow): string {
	return at(flow.generateBody().contents, 0)
		.parts.map((part) => part.text ?? '')
		.join(' ');
}

describe('GeminiProvider.transcribe', () => {
	it('uploads a WAV payload as-is and maps the structured transcript', async () => {
		const flow = scriptFlow(
			transcriptBody({
				language: 'en',
				segments: [
					{ start: 0, end: 1, speaker: 'Speaker 1', text: 'Hello.' },
				],
			}),
		);

		const result = await provider().transcribe(
			payload('audio/wav', FILE_API_BYTES),
			{ diarize: true, wordTimestamps: false },
		);

		expect(result.language).toBe('en');
		expect(result.segments).toEqual([
			{ start: 0, end: 1, text: 'Hello.', speaker: 'Speaker 1' },
		]);
		const body = flow.generateBody();
		const part = at(at(body.contents, 0).parts, 0);
		// The generateContent request references the uploaded file as audio/wav.
		expect(part.fileData?.mimeType).toBe('audio/wav');
		expect(part.fileData?.fileUri).toBe('https://files.example/abc');
		// Thinking is disabled for the deterministic transcription task.
		expect(body.generationConfig.thinkingConfig).toEqual({
			thinkingBudget: 0,
		});
		// The uploaded file is deleted at the end (best effort).
		expect(
			flow.calls.some(
				(c) =>
					c.method === 'DELETE' &&
					c.url === `${BASE_URL}/v1beta/files/abc`,
			),
		).toBe(true);
	});

	it('folds dictionary terms into the instruction text', async () => {
		const flow = scriptTranscriptFlow();

		await provider().transcribe(payload('audio/wav'), {
			diarize: false,
			wordTimestamps: false,
			dictionary: ['Kubernetes', 'gRPC'],
		});

		// The instruction is the text part sent alongside the audio file part.
		const instruction = instructionOf(flow);
		expect(instruction).toContain('Kubernetes, gRPC');
	});

	it('omits the dictionary sentence when no terms are given', async () => {
		const flow = scriptTranscriptFlow();

		await provider().transcribe(payload('audio/wav'), {
			diarize: false,
			wordTimestamps: false,
		});

		const instruction = instructionOf(flow);
		expect(instruction).not.toContain('Prefer these spellings');
	});

	it('names the language the run declared in the instruction', async () => {
		const flow = scriptTranscriptFlow();

		await provider().transcribe(payload('audio/wav'), {
			diarize: false,
			wordTimestamps: false,
			language: 'de',
		});

		const instruction = instructionOf(flow);
		// Named as the primary language rather than the only one: a bilingual
		// recording still has to be transcribed in the language spoken.
		expect(instruction).toContain('primary language is "de"');
		// A single code keeps the schema it always had: no per-segment field.
		const segment =
			flow.generateBody().generationConfig.responseSchema.properties
				.segments.items;
		expect(Object.keys(segment.properties)).not.toContain('language');
	});

	it('names every configured language and asks each segment for its own', async () => {
		const flow = scriptTranscriptFlow();

		await provider().transcribe(payload('audio/wav'), {
			diarize: false,
			wordTimestamps: false,
			language: 'pl',
			languages: ['pl', 'uk'],
		});

		const instruction = instructionOf(flow);
		expect(instruction).toContain(
			'The recording switches between these languages: pl, uk.',
		);
		expect(instruction).not.toContain('primary language');
		expect(instruction).toContain(
			'or to "other" when it is in none of the listed languages.',
		);
		const segment =
			flow.generateBody().generationConfig.responseSchema.properties
				.segments.items;
		// "other" keeps a third language from being tagged with a listed code.
		expect(segment.properties.language?.enum).toEqual([
			'pl',
			'uk',
			'other',
		]);
		expect(segment.required).toEqual(['start', 'text', 'language']);
	});

	// Asked for seconds, the model's timecodes drifted past the parts of a
	// long recording; asked for MM:SS, they stayed where the speech is.
	it('asks for MM:SS timecodes and reads them back as seconds', async () => {
		const flow = scriptFlow(
			transcriptBody({
				segments: [
					{ start: '14:27', end: '14:30.5', text: 'Andrzej.' },
				],
			}),
		);

		const result = await provider().transcribe(payload('audio/wav'), {
			diarize: false,
			wordTimestamps: false,
		});

		const body = flow.generateBody();
		const { start, end } =
			body.generationConfig.responseSchema.properties.segments.items
				.properties;
		expect([start?.type, end?.type]).toEqual(['STRING', 'STRING']);
		expect(at(body.systemInstruction.parts, 0).text).toContain(
			'timecode for every segment, formatted as MM:SS.',
		);
		expect(result.segments).toEqual([
			{ start: 867, end: 870.5, text: 'Andrzej.' },
		]);
	});

	it('asks Gemini to label speakers when the run diarizes', async () => {
		const flow = scriptTranscriptFlow();

		await provider().transcribe(payload('audio/wav'), {
			diarize: true,
			wordTimestamps: false,
		});

		const instruction = instructionOf(flow);
		expect(instruction).toContain('Identify distinct speakers');
	});

	it('uploads the container it is handed as it stands', async () => {
		const flow = scriptTranscriptFlow();

		await provider().transcribe(payload('audio/ogg', FILE_API_BYTES), {
			diarize: false,
			wordTimestamps: false,
		});

		const start = flow.calls.find((c) =>
			c.url.endsWith('/upload/v1beta/files'),
		);
		expect(start?.headers?.['X-Goog-Upload-Header-Content-Type']).toBe(
			'audio/ogg',
		);
		expect(
			at(at(flow.generateBody().contents, 0).parts, 0).fileData?.mimeType,
		).toBe('audio/ogg');
	});

	// The service sends the same payload again after a refusal it waits out,
	// so the provider may only read what it was lent (issue #136).
	it('leaves the payload it uploaded readable for the next send', async () => {
		scriptTranscriptFlow();
		const lent = payload('audio/wav');

		await provider().transcribe(lent, {
			diarize: false,
			wordTimestamps: false,
		});

		expect(lent.data.byteLength).toBe(8);
	});

	it('sends audio that fits an inline request in one generateContent call', async () => {
		const flow = scriptTranscriptFlow();
		const audio = payload('audio/wav');
		new Uint8Array(audio.data).set([1, 2, 3, 250, 251, 252, 253, 254]);

		await provider().transcribe(audio, {
			diarize: false,
			wordTimestamps: false,
		});

		// No upload session, no status poll and no delete: the generate
		// request is the only one the run makes.
		expect(flow.calls.map((call) => call.method)).toEqual(['POST']);
		expect(at(flow.calls, 0).url).toContain(':generateContent');
		expect(
			at(at(flow.generateBody().contents, 0).parts, 0).inlineData,
		).toEqual({ mimeType: 'audio/wav', data: 'AQID+vv8/f4=' });
	});

	it('sends the largest inline payload inline and one byte more through the File API', async () => {
		const inline = scriptTranscriptFlow();
		await provider().transcribe(
			payload('audio/wav', GEMINI_INLINE_MAX_BYTES),
			{ diarize: false, wordTimestamps: false },
		);
		expect(inline.calls).toHaveLength(1);

		const uploaded = scriptTranscriptFlow();
		await provider().transcribe(payload('audio/wav', FILE_API_BYTES), {
			diarize: false,
			wordTimestamps: false,
		});
		expect(
			uploaded.calls.map((call) => `${call.method ?? 'GET'} ${call.url}`),
		).toEqual([
			`POST ${BASE_URL}/upload/v1beta/files`,
			`POST ${BASE_URL}/session`,
			`GET ${BASE_URL}/v1beta/files/abc`,
			expect.stringContaining(':generateContent'),
			`DELETE ${BASE_URL}/v1beta/files/abc`,
		]);
	});

	it('throws when the response was truncated at the token limit', async () => {
		scriptFlow(transcriptBody({ segments: [] }, 'MAX_TOKENS'));

		await expect(
			provider().transcribe(payload('audio/wav'), {
				diarize: false,
				wordTimestamps: false,
			}),
		).rejects.toThrow(/output token limit/i);
	});

	it('throws when Gemini blocked the request for safety', async () => {
		scriptFlow(
			JSON.stringify({
				candidates: [
					{ finishReason: 'SAFETY', content: { parts: [] } },
				],
			}),
		);

		await expect(
			provider().transcribe(payload('audio/wav'), {
				diarize: false,
				wordTimestamps: false,
			}),
		).rejects.toThrow(/without usable output/i);
	});

	it('uses the Pro minimum thinking budget for a Pro model', async () => {
		const flow = scriptTranscriptFlow();

		await provider('gemini-2.5-pro').transcribe(payload('audio/wav'), {
			diarize: false,
			wordTimestamps: false,
		});

		expect(flow.generateBody().generationConfig.thinkingConfig).toEqual({
			thinkingBudget: 128,
		});
	});

	// The default model belongs to the 3.x generation, which takes a level
	// rather than a budget and was being sent neither: it ran with dynamic
	// thinking, spent output budget on it, and hit the cap on dense audio.
	it('sends the reasoning level on the default model', async () => {
		const flow = scriptTranscriptFlow();

		await provider(DEFAULT_GEMINI_MODEL).transcribe(payload('audio/wav'), {
			diarize: false,
			wordTimestamps: false,
		});

		expect(flow.generateBody().generationConfig.thinkingConfig).toEqual({
			thinkingLevel: 'low',
		});
	});

	it('omits thinkingConfig for a model without a thinking budget (2.0)', async () => {
		const flow = scriptTranscriptFlow();

		await provider('gemini-2.0-flash').transcribe(payload('audio/wav'), {
			diarize: false,
			wordTimestamps: false,
		});

		// 2.0 rejects thinkingConfig, so the key must be absent entirely.
		const config = flow.generateBody().generationConfig;
		expect('thinkingConfig' in config).toBe(false);
	});

	it('asks for the rewritten text alone when the run carries a rewrite instruction', async () => {
		const flow = scriptFlow(transcriptBody({ text: '- milk\n- bread' }));

		const result = await provider().transcribe(payload('audio/wav'), {
			diarize: false,
			wordTimestamps: false,
			rewrite: 'Turn the dictation into a list.',
		});

		const body = flow.generateBody();
		expect(body.generationConfig.responseSchema).toEqual({
			type: 'OBJECT',
			properties: { text: { type: 'STRING' } },
			required: ['text'],
		});
		expect(instructionOf(flow)).toMatch(
			/return an empty text\. Instruction: Turn the dictation into a list\.$/,
		);
		// The transcription rules stay where they were; only the user's
		// instruction rides in the request text.
		expect(at(body.systemInstruction.parts, 0).text).toMatch(
			/^You are a professional meeting transcription assistant\./,
		);
		expect(result).toEqual({ segments: [], rewritten: '- milk\n- bread' });
	});

	it('answers with segments and no rewritten text when no instruction is sent', async () => {
		const flow = scriptTranscriptFlow();

		const result = await provider().transcribe(payload('audio/wav'), {
			diarize: false,
			wordTimestamps: false,
		});

		expect(instructionOf(flow)).not.toContain('Instruction:');
		expect(result.rewritten).toBeUndefined();
		expect(result.segments).toHaveLength(1);
	});

	it('surfaces the transcription-specific remedy on truncation', async () => {
		scriptFlow(transcriptBody({ segments: [] }, 'MAX_TOKENS'));

		// Transcription has no max-tokens setting, so the advice must point at
		// the recording/model, not at raising a limit.
		await expect(
			provider().transcribe(payload('audio/wav'), {
				diarize: false,
				wordTimestamps: false,
			}),
		).rejects.toThrow(/shorter recording/i);
	});
});

describe('GeminiProvider.transcribe cancelled during the upload', () => {
	// A Cancel releases the run while the bytes are still on their way, and
	// Google still creates the file they make up. Left undeleted, the recording
	// the user cancelled stays in the project's File API storage for 48 hours.
	it('deletes the file the cancelled upload still created', async () => {
		let answerUpload = (): void => undefined;
		const flow = scriptFlow(
			transcriptBody({ segments: [] }),
			new Promise<void>((resolve) => {
				answerUpload = resolve;
			}),
		);
		const controller = new AbortController();

		const run = outcomeOf(
			provider().transcribe(payload('audio/wav', FILE_API_BYTES), {
				diarize: false,
				wordTimestamps: false,
				signal: controller.signal,
			}),
		);
		await waitFor(() => flow.calls.length === 2);
		controller.abort();
		await run;
		answerUpload();
		await tick();

		expect(
			flow.calls.map((call) => `${call.method ?? 'GET'} ${call.url}`),
		).toEqual([
			`POST ${BASE_URL}/upload/v1beta/files`,
			`POST ${BASE_URL}/session`,
			`DELETE ${BASE_URL}/v1beta/files/abc`,
		]);
	});
});
