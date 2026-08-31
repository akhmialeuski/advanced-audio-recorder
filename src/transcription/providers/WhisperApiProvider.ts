/**
 * Transcription via an OpenAI-compatible Whisper API
 * (`POST {baseUrl}/audio/transcriptions`), or translation of the speech into
 * English through the endpoint's own `/audio/translations` operation. Works
 * with OpenAI and any compatible endpoint (e.g. Groq) by changing the base URL
 * and model.
 * Word timestamps are requested best-effort. Speaker diarization is not
 * offered: OpenAI's Whisper returns no speaker labels, so the diarization
 * UI is disabled for this engine rather than requesting a field the API
 * silently ignores.
 * @module transcription/providers/WhisperApiProvider
 */

import { TRANSCRIPTION_PROVIDER_IDS } from '../../constants';

/** Operation that writes the speech down in the language it was spoken in. */
const WHISPER_TRANSCRIPTIONS_PATH = '/audio/transcriptions';

/**
 * Operation that translates the speech into English while transcribing it.
 * Takes the same fields and answers in the same shape, so only the path and
 * the language hint change.
 */
const WHISPER_TRANSLATIONS_PATH = '/audio/translations';
import { whisperPromptValue } from '../dictionaryBias';
import {
	authHeader,
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
		// The translation operation writes English whatever was spoken, so a
		// language hint would be a claim about the answer rather than about
		// the audio; the endpoint rejects it.
		if (options.language && !options.translateToEnglish) {
			fields.push({
				type: 'text' as const,
				name: 'language',
				value: options.language,
			});
		}
		// OpenAI's `prompt` seeds recognition with preferred spellings, and it
		// is also where the advanced second pass puts its bias sentence. Which
		// of the two wins, and how a dictionary is bounded to fit, is one policy
		// shared with the local engine.
		const promptValue = whisperPromptValue(options);
		if (promptValue) {
			fields.push({
				type: 'text' as const,
				name: 'prompt',
				value: promptValue,
			});
		}

		const { body, contentType } = buildMultipart(fields);
		const json = await requestJson({
			url: `${trimTrailingSlash(this.config.baseUrl)}${
				options.translateToEnglish
					? WHISPER_TRANSLATIONS_PATH
					: WHISPER_TRANSCRIPTIONS_PATH
			}`,
			method: 'POST',
			headers: authHeader('Authorization', this.config.apiKey, 'Bearer'),
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
