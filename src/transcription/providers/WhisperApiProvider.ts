/**
 * Transcription via an OpenAI-compatible Whisper API
 * (`POST {baseUrl}/audio/transcriptions`). Works with OpenAI and any
 * compatible endpoint (e.g. Groq) by changing the base URL and model.
 * Diarization and word timestamps are requested best-effort — endpoints
 * that ignore the extra fields simply return segment-level results.
 * @module transcription/providers/WhisperApiProvider
 */

import { buildMultipart, requestJson } from '../httpClient';
import { mapWhisperResponse, type WhisperResult } from './whisperResponse';
import type {
	TranscribeOptions,
	TranscriptionProvider,
} from './TranscriptionProvider';

/** Configuration for the Whisper API provider. */
export interface WhisperApiConfig {
	baseUrl: string;
	apiKey: string;
	model: string;
}

/**
 * OpenAI-compatible Whisper transcription provider.
 */
export class WhisperApiProvider implements TranscriptionProvider {
	readonly id = 'whisper-api';
	readonly label = 'Whisper API (OpenAI-compatible)';
	readonly requiresNetwork = true;

	constructor(private readonly config: WhisperApiConfig) {}

	async transcribe(
		audio: ArrayBuffer,
		options: TranscribeOptions,
	): Promise<WhisperResult> {
		const granularities: string[] = ['segment'];
		if (options.wordTimestamps) {
			granularities.push('word');
		}
		const fields = [
			{
				type: 'file' as const,
				name: 'file',
				filename: 'audio.wav',
				contentType: 'audio/wav',
				data: audio,
			},
			{ type: 'text' as const, name: 'model', value: this.config.model },
			{
				type: 'text' as const,
				name: 'response_format',
				value: 'verbose_json',
			},
			...granularities.map((value) => ({
				type: 'text' as const,
				name: 'timestamp_granularities[]',
				value,
			})),
		];
		if (options.language) {
			fields.push({
				type: 'text' as const,
				name: 'language',
				value: options.language,
			});
		}
		if (options.diarize) {
			// Honored by diarization-capable compatible endpoints; ignored
			// by OpenAI's own Whisper without error.
			fields.push({
				type: 'text' as const,
				name: 'diarize',
				value: 'true',
			});
		}

		const { body, contentType } = buildMultipart(fields);
		const json = await requestJson({
			url: `${trimTrailingSlash(this.config.baseUrl)}/audio/transcriptions`,
			method: 'POST',
			headers: { Authorization: `Bearer ${this.config.apiKey}` },
			contentType,
			body,
		});
		return mapWhisperResponse(json);
	}
}

/**
 * Removes a single trailing slash from a base URL.
 */
function trimTrailingSlash(url: string): string {
	return url.endsWith('/') ? url.slice(0, -1) : url;
}
