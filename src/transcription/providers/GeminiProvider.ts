/**
 * Transcription via Google Gemini. Uploads the whole audio file with the File
 * API — so speaker numbering stays consistent across the recording — then asks
 * `generateContent` for a structured JSON transcript with timecodes and
 * optional speaker labels. Containers Gemini does not accept (e.g. webm) are
 * decoded to 16 kHz mono WAV before upload.
 * @module transcription/providers/GeminiProvider
 */

import {
	GEMINI_API_KEY_HEADER,
	GEMINI_AUDIO_MIME_TYPES,
	MIME_TYPE_AUDIO_PREFIX,
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
			: encodeMonoWav(
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
						// Transcription is deterministic; disabling thinking
						// frees the whole output budget for the transcript and
						// avoids MAX_TOKENS truncation.
						thinkingConfig: geminiThinkingConfig(this.config.model),
					},
				}),
				// The file is already uploaded; the byte size is only a proxy
				// for how long Gemini may take to transcribe the audio.
				timeoutMs: uploadTimeoutMs(data.byteLength),
			});
			// A truncated (MAX_TOKENS) response yields invalid JSON, and a
			// safety/policy block yields no candidate; both would otherwise map
			// to an empty transcript with no explanation.
			assertGeminiNotTruncated(json);
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
