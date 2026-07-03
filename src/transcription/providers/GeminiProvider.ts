/**
 * Transcription via Google Gemini. Uploads one audio payload with the File API,
 * then asks `generateContent` for a structured JSON transcript with timecodes
 * and optional speaker labels. The orchestrator sends a short recording whole
 * (one payload, so speaker numbering stays consistent across it) and splits a
 * recording too long for one request into parts. Containers Gemini does not
 * accept (e.g. webm) are decoded to 16 kHz mono WAV before upload.
 * @module transcription/providers/GeminiProvider
 */

import {
	GEMINI_API_KEY_HEADER,
	GEMINI_AUDIO_MIME_TYPES,
	GEMINI_GENERATE_MIN_TIMEOUT_MS,
	MIME_TYPE_AUDIO_PREFIX,
	TRANSCRIBE_MAX_REQUEST_TIMEOUT_MS,
	TRANSCRIBE_SAMPLE_RATE,
	TRANSCRIPTION_PROVIDER_IDS,
} from '../../constants';
import { decodeToMono16k, encodeMonoWav } from '../audioChunks';
import { requestJson, uploadTimeoutMs } from '../httpClient';
import { GEMINI_CAPABILITIES } from './capabilities';
import {
	deleteFile,
	fileProcessingWaitMs,
	uploadFile,
	waitUntilActive,
} from './geminiFileApi';
import { mapGeminiResponse } from './geminiResponse';
import {
	assertGeminiNotBlocked,
	assertGeminiNotTruncated,
	geminiGenerateContentUrl,
	geminiThinkingConfig,
} from './geminiShared';
import type { WhisperResult } from './whisperResponse';
import type {
	AudioPayload,
	ProviderCapabilities,
	TranscribeOptions,
	TranscriptionProvider,
} from './TranscriptionProvider';

/** Configuration for the Gemini provider. */
export interface GeminiConfig {
	baseUrl: string;
	apiKey: string;
	model: string;
	/** Per-request timeout cap (ms); the user-configured transcription limit. */
	requestTimeoutMs?: number;
}

/** WAV MIME type used when a container is decoded before upload. */
const WAV_MIME = `${MIME_TYPE_AUDIO_PREFIX}wav`;

/** System instruction; the response schema enforces the output shape. */
const SYSTEM_PROMPT =
	'You are a professional meeting transcription assistant. Transcribe the ' +
	'audio verbatim. Write each segment in the language actually spoken; do ' +
	'not translate, and keep technology names as spoken. Provide a start (and ' +
	'when possible an end) timecode in seconds for every segment.';

/**
 * Structured-output schema (Gemini uses UPPERCASE OpenAPI type names): an
 * object with optional detected `language` and an array of `segments`, each a
 * start/end in seconds, an optional speaker label, and the spoken text.
 */
const TRANSCRIPT_SCHEMA = {
	type: 'OBJECT',
	properties: {
		language: { type: 'STRING' },
		segments: {
			type: 'ARRAY',
			items: {
				type: 'OBJECT',
				properties: {
					start: { type: 'NUMBER' },
					end: { type: 'NUMBER' },
					speaker: { type: 'STRING' },
					text: { type: 'STRING' },
				},
				required: ['start', 'text'],
			},
		},
	},
	required: ['segments'],
};

/**
 * Task-specific remedy appended to the truncation error. Unlike the LLM path,
 * transcription exposes no output-token setting, so the advice is to shorten the
 * recording or change model rather than to raise a limit.
 */
const TRUNCATION_REMEDY =
	'Use a shorter recording, split it into parts, or choose a model with a ' +
	'larger output limit.';

/**
 * Timeout for the transcription `generateContent` call. Inference time tracks
 * audio duration, not byte size, and a compressed accepted container (mp3, aac,
 * ogg, flac) has far fewer bytes than its duration implies, so the upload-size
 * proxy alone can abort a healthy long transcription. Take the larger of the
 * size-scaled upload budget and a generous floor, then cap by the
 * user-configured per-request limit so the floor cannot exceed it.
 * @param byteLength - Size of the uploaded audio bytes
 * @param maxMs - Per-request timeout cap; defaults to
 *   {@link TRANSCRIBE_MAX_REQUEST_TIMEOUT_MS}
 * @returns Timeout in milliseconds
 */
export function geminiGenerateTimeoutMs(
	byteLength: number,
	maxMs: number = TRANSCRIBE_MAX_REQUEST_TIMEOUT_MS,
): number {
	const base = Math.max(
		uploadTimeoutMs(byteLength, maxMs),
		GEMINI_GENERATE_MIN_TIMEOUT_MS,
	);
	return Math.min(base, maxMs);
}

/** Builds the per-run instruction text sent alongside the audio. */
function buildInstruction(options: TranscribeOptions): string {
	const lines = [
		'Transcribe the attached audio into ordered segments.',
		options.language
			? `The primary language is "${options.language}", but transcribe each segment in the language actually spoken.`
			: 'Detect the spoken language(s) and transcribe each segment in the language actually spoken.',
		options.diarize
			? 'Identify distinct speakers and label each segment (e.g. "Speaker 1", "Speaker 2"); use real names when clearly stated.'
			: 'Do not include speaker labels.',
	];
	return lines.join(' ');
}

/** Google Gemini multimodal transcription provider. */
export class GeminiProvider implements TranscriptionProvider {
	readonly id = TRANSCRIPTION_PROVIDER_IDS.GEMINI;
	readonly label = 'Google Gemini';
	readonly requiresNetwork = true;
	readonly capabilities: ProviderCapabilities = GEMINI_CAPABILITIES;

	constructor(private readonly config: GeminiConfig) {}

	async transcribe(
		payload: AudioPayload,
		options: TranscribeOptions,
	): Promise<WhisperResult> {
		// The File API accepts only certain audio containers; decode anything
		// else (e.g. webm) to 16 kHz mono WAV before uploading.
		const accepted = GEMINI_AUDIO_MIME_TYPES.has(payload.contentType);
		const data = accepted
			? payload.data
			: await encodeMonoWav(
					await decodeToMono16k(payload.data),
					TRANSCRIBE_SAMPLE_RATE,
				);
		const mimeType = accepted ? payload.contentType : WAV_MIME;

		const file = await uploadFile(
			this.config.baseUrl,
			this.config.apiKey,
			data,
			mimeType,
			payload.filename,
			this.config.requestTimeoutMs,
			options.signal,
		);
		try {
			await waitUntilActive(
				this.config.baseUrl,
				this.config.apiKey,
				file.name,
				fileProcessingWaitMs(data.byteLength),
			);
			const url = geminiGenerateContentUrl(
				this.config.baseUrl,
				this.config.model,
			);
			// Transcription is deterministic; on models that support a thinking
			// budget, disabling thinking frees the whole output budget for the
			// transcript and avoids MAX_TOKENS truncation. Models without a
			// thinking budget (2.0 and earlier) get no thinkingConfig at all,
			// which they would otherwise reject.
			const thinkingConfig = geminiThinkingConfig(this.config.model);
			const json = await requestJson({
				url,
				method: 'POST',
				headers: { [GEMINI_API_KEY_HEADER]: this.config.apiKey },
				contentType: 'application/json',
				body: JSON.stringify({
					contents: [
						{
							parts: [
								{ fileData: { mimeType, fileUri: file.uri } },
								{ text: buildInstruction(options) },
							],
						},
					],
					systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
					generationConfig: {
						temperature: 0,
						responseMimeType: 'application/json',
						responseSchema: TRANSCRIPT_SCHEMA,
						...(thinkingConfig ? { thinkingConfig } : {}),
					},
				}),
				timeoutMs: geminiGenerateTimeoutMs(
					data.byteLength,
					this.config.requestTimeoutMs,
				),
				signal: options.signal,
			});
			// A truncated (MAX_TOKENS) response yields invalid JSON, and a
			// safety/policy block yields no candidate; both would otherwise map
			// to an empty transcript with no explanation.
			assertGeminiNotTruncated(json, TRUNCATION_REMEDY);
			assertGeminiNotBlocked(json);
			return mapGeminiResponse(json, options.diarize);
		} finally {
			// Best-effort cleanup; a left-over file expires on Google's side.
			try {
				await deleteFile(
					this.config.baseUrl,
					this.config.apiKey,
					file.name,
				);
			} catch {
				// Ignore cleanup failures.
			}
		}
	}
}
