/**
 * Tests for the GeminiProvider transcription orchestration: the upload ->
 * poll-until-ACTIVE -> generateContent -> best-effort delete flow scripted
 * through the shared requestUrl mock, the WAV-passthrough vs decode-to-WAV
 * branch, the thinking-off generationConfig, and the truncation/block guards.
 */

import {
	GeminiProvider,
	geminiGenerateTimeoutMs,
} from 'src/transcription/providers/GeminiProvider';
import { at, jsonBody } from '../helpers/assertions';
import type { AudioPayload } from 'src/transcription/providers/TranscriptionProvider';
import { uploadTimeoutMs } from 'src/transcription/httpClient';
import { GEMINI_GENERATE_MIN_TIMEOUT_MS } from 'src/constants';
// Mock-only surface: these exist on the test double, not on Obsidian's
// API, so they are imported from the mock by path. Jest maps 'obsidian'
// to the same module, so both imports share one instance.
import {
	__setRequestUrlHandler,
	type MockRequestUrlParam,
	type MockRequestUrlResponse,
} from '../mocks/obsidian';

// Decoding an unsupported container needs OfflineAudioContext, which jsdom
// lacks; mock the audio helpers so the decode branch is testable by eye.
jest.mock('src/transcription/audioChunks', () => ({
	decodeToMono16k: jest.fn().mockResolvedValue(new Float32Array(4)),
	encodeMonoWav: jest.fn().mockReturnValue(new ArrayBuffer(16)),
}));

const BASE_URL = 'https://gemini.example';
const API_KEY = 'gm-test';
const MODEL = 'gemini-2.5-flash';

/** Shape of the generateContent request body the provider posts. */
interface GeneratePart {
	fileData?: { mimeType: string; fileUri: string };
	text?: string;
}
interface GenerateBody {
	contents: { parts: GeneratePart[] }[];
	generationConfig: {
		temperature: number;
		responseMimeType: string;
		thinkingConfig?: { thinkingBudget: number };
	};
}

function provider(model = MODEL): GeminiProvider {
	return new GeminiProvider({ baseUrl: BASE_URL, apiKey: API_KEY, model });
}

function payload(contentType: string): AudioPayload {
	return {
		data: new ArrayBuffer(8),
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

interface ScriptedFlow {
	calls: MockRequestUrlParam[];
	generateBody: () => GenerateBody;
}

/**
 * Installs a handler that walks the whole upload/poll/generate/delete flow and
 * records every call; the generateContent step returns `generateText`.
 */
function scriptFlow(generateText: string): ScriptedFlow {
	const calls: MockRequestUrlParam[] = [];
	__setRequestUrlHandler((param): MockRequestUrlResponse => {
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
			return {
				status: 200,
				headers: {},
				text: JSON.stringify({
					file: {
						name: 'files/abc',
						uri: 'https://files.example/abc',
						state: 'ACTIVE',
					},
				}),
			};
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

		const result = await provider().transcribe(payload('audio/wav'), {
			diarize: true,
			wordTimestamps: false,
		});

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
		const flow = scriptFlow(
			transcriptBody({ segments: [{ start: 0, text: 'hi' }] }),
		);

		await provider().transcribe(payload('audio/wav'), {
			diarize: false,
			wordTimestamps: false,
			dictionary: ['Kubernetes', 'gRPC'],
		});

		// The instruction is the text part sent alongside the audio file part.
		const instruction = at(flow.generateBody().contents, 0)
			.parts.map((p) => p.text ?? '')
			.join(' ');
		expect(instruction).toContain('Kubernetes, gRPC');
	});

	it('omits the dictionary sentence when no terms are given', async () => {
		const flow = scriptFlow(
			transcriptBody({ segments: [{ start: 0, text: 'hi' }] }),
		);

		await provider().transcribe(payload('audio/wav'), {
			diarize: false,
			wordTimestamps: false,
		});

		const instruction = at(flow.generateBody().contents, 0)
			.parts.map((p) => p.text ?? '')
			.join(' ');
		expect(instruction).not.toContain('Prefer these spellings');
	});

	it('decodes an unsupported container to WAV before upload', async () => {
		const flow = scriptFlow(
			transcriptBody({ segments: [{ start: 0, text: 'hi' }] }),
		);

		await provider().transcribe(payload('audio/webm'), {
			diarize: false,
			wordTimestamps: false,
		});

		// webm is not accepted, so it is decoded and uploaded as WAV.
		expect(
			at(at(flow.generateBody().contents, 0).parts, 0).fileData?.mimeType,
		).toBe('audio/wav');
		const start = flow.calls.find((c) =>
			c.url.endsWith('/upload/v1beta/files'),
		);
		expect(start?.headers?.['X-Goog-Upload-Header-Content-Type']).toBe(
			'audio/wav',
		);
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
		const flow = scriptFlow(
			transcriptBody({ segments: [{ start: 0, text: 'hi' }] }),
		);

		await provider('gemini-2.5-pro').transcribe(payload('audio/wav'), {
			diarize: false,
			wordTimestamps: false,
		});

		expect(flow.generateBody().generationConfig.thinkingConfig).toEqual({
			thinkingBudget: 128,
		});
	});

	it('omits thinkingConfig for a model without a thinking budget (2.0)', async () => {
		const flow = scriptFlow(
			transcriptBody({ segments: [{ start: 0, text: 'hi' }] }),
		);

		await provider('gemini-2.0-flash').transcribe(payload('audio/wav'), {
			diarize: false,
			wordTimestamps: false,
		});

		// 2.0 rejects thinkingConfig, so the key must be absent entirely.
		const config = flow.generateBody().generationConfig;
		expect('thinkingConfig' in config).toBe(false);
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

describe('geminiGenerateTimeoutMs', () => {
	it('floors a small upload at the generous inference minimum', () => {
		// A few bytes (e.g. a tiny clip) must not inherit the short upload
		// proxy; the inference floor applies so long audio is not cut off.
		expect(geminiGenerateTimeoutMs(8)).toBe(GEMINI_GENERATE_MIN_TIMEOUT_MS);
	});

	it('uses the size-scaled upload budget once it exceeds the floor', () => {
		const bigBytes = 600 * 1024 * 1024;
		const scaled = uploadTimeoutMs(bigBytes);
		expect(scaled).toBeGreaterThan(GEMINI_GENERATE_MIN_TIMEOUT_MS);
		expect(geminiGenerateTimeoutMs(bigBytes)).toBe(scaled);
	});

	it('clamps to the configured cap even below the inference floor', () => {
		// A user who sets a 5-minute limit overrides the 10-minute floor: the
		// per-request cap wins so the run cannot wait longer than configured.
		const cap = 5 * 60_000;
		expect(geminiGenerateTimeoutMs(8, cap)).toBe(cap);
		expect(geminiGenerateTimeoutMs(600 * 1024 * 1024, cap)).toBe(cap);
	});
});
