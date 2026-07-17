/**
 * Transcription via an OpenAI-compatible Whisper API
 * (`POST {baseUrl}/audio/transcriptions`). Works with OpenAI and any
 * compatible endpoint (e.g. Groq) by changing the base URL and model.
 * Word timestamps are requested best-effort. Speaker diarization is not
 * offered: OpenAI's Whisper returns no speaker labels, so the diarization
 * UI is disabled for this engine rather than requesting a field the API
 * silently ignores.
 * @module transcription/providers/WhisperApiProvider
 */

import { TRANSCRIPTION_PROVIDER_IDS } from '../../constants';
import {
	DICTIONARY_JOIN_SEPARATOR,
	termsWithinWhisperPrompt,
} from '../dictionaryBias';
import {
	buildMultipart,
	requestJson,
	trimTrailingSlash,
	uploadTimeoutMs,
} from '../httpClient';
import { WHISPER_API_CAPABILITIES } from './capabilities';
import { mapWhisperResponse, type WhisperResult } from './whisperResponse';
import type {
	AudioPayload,
	ProviderCapabilities,
	TranscribeOptions,
	TranscriptionProvider,
} from './TranscriptionProvider';

/** Configuration for the Whisper API provider. */
export interface WhisperApiConfig {
	baseUrl: string;
	apiKey: string;
	model: string;
	/** Per-request timeout cap (ms); the user-configured transcription limit. */
	requestTimeoutMs?: number;
}

/**
 * OpenAI-compatible Whisper transcription provider. Accepts the original
 * container (mp3, wav, webm, m4a, ...) up to the 25 MB API limit; larger
 * recordings are decoded and split into WAV chunks by the service.
 */
export class WhisperApiProvider implements TranscriptionProvider {
	readonly id = TRANSCRIPTION_PROVIDER_IDS.WHISPER_API;
	readonly label = 'Whisper API (OpenAI-compatible)';
	readonly requiresNetwork = true;
	readonly capabilities: ProviderCapabilities = WHISPER_API_CAPABILITIES;

	constructor(private readonly config: WhisperApiConfig) {}

	async transcribe(
		payload: AudioPayload,
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
				filename: payload.filename,
				contentType: payload.contentType,
				data: payload.data,
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
		if (options.dictionary?.length) {
			// OpenAI's `prompt` seeds recognition with preferred spellings, but
			// Whisper only reads the last ~224 tokens, so terms beyond the window
			// are bounded out here. The service applies the same bound and warns
			// about the dropped terms; this keeps a directly used provider safe.
			const terms = termsWithinWhisperPrompt(options.dictionary);
			if (terms.length) {
				fields.push({
					type: 'text' as const,
					name: 'prompt',
					value: terms.join(DICTIONARY_JOIN_SEPARATOR),
				});
			}
		}

		const { body, contentType } = buildMultipart(fields);
		const json = await requestJson({
			url: `${trimTrailingSlash(this.config.baseUrl)}/audio/transcriptions`,
			method: 'POST',
			headers: { Authorization: `Bearer ${this.config.apiKey}` },
			contentType,
			body,
			timeoutMs: uploadTimeoutMs(
				body.byteLength,
				this.config.requestTimeoutMs,
			),
			signal: options.signal,
		});
		return mapWhisperResponse(json);
	}
}
