/**
 * Transcription via an OpenAI-compatible Whisper API
 * (`POST {baseUrl}/audio/transcriptions`), or translation of the speech into
 * English through the endpoint's own `/audio/translations` operation. Works
 * with OpenAI and any compatible endpoint (e.g. Groq) by changing the base URL
 * and model.
 * Word timestamps are requested best-effort from the transcription operation,
 * and not at all from the translation one, which has no timing granularity to
 * ask for. Speaker labels are asked for with `diarize=true` only where the
 * user declared that the endpoint returns them (OpenAI's own Whisper does
 * not); the service gates that before a request reaches this provider.
 * @module transcription/providers/WhisperApiProvider
 */

import { TRANSCRIPTION_PROVIDER_IDS } from '../../constants';
import { EngineLabel } from '../../providers/providers';
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

/** Operation that writes the speech down in the language it was spoken in. */
const WHISPER_TRANSCRIPTIONS_PATH = '/audio/transcriptions';

/**
 * Operation that translates the speech into English while transcribing it.
 *
 * It answers in the same shape but takes a narrower set of fields than the
 * transcription operation does: file, model, prompt, response_format, and
 * temperature, and nothing else. A language hint and a timestamp granularity
 * are both outside that set, so what the request carries changes with the
 * path and not only the path itself.
 */
const WHISPER_TRANSLATIONS_PATH = '/audio/translations';

/** Configuration for the Whisper API provider. */
export interface WhisperApiConfig {
	baseUrl: string;
	apiKey: string;
	model: string;
	/** Per-request timeout cap (ms); the user-configured transcription limit. */
	requestTimeoutMs?: number;
}

/**
 * The fields a request carries only when the run asks for them and the
 * operation takes them.
 * @param options - What the run asks for
 * @param translating - Whether the request goes to the translating operation
 * @returns The text fields to add, in the order they are sent
 */
function optionalFields(
	options: TranscribeOptions,
	translating: boolean,
): { type: 'text'; name: string; value: string }[] {
	const fields: { type: 'text'; name: string; value: string }[] = [];
	// The translation operation writes English whatever was spoken, so a
	// language hint would be a claim about the answer rather than about
	// the audio; the endpoint rejects it.
	if (options.language && !translating) {
		fields.push({
			type: 'text',
			name: 'language',
			value: options.language,
		});
	}
	// Speaker labels, from an endpoint the user declared as diarizing - the
	// gate is the service's, so a true here was asked for and is possible.
	// `diarize=true` is how the OpenAI-compatible hosts that diarize take
	// the request (Mistral's own endpoint, Together, self-hosted servers),
	// and the answer stays `verbose_json`, whose segments then carry a
	// speaker each. OpenAI's own diarizing model takes a different response
	// format and drops the prompt and the word timing this request relies
	// on, so it is not what this field asks for. The translating operation
	// takes a fixed set of fields that has no diarization among them.
	if (options.diarize && !translating) {
		fields.push({
			type: 'text',
			name: 'diarize',
			value: 'true',
		});
	}
	// OpenAI's `prompt` seeds recognition with preferred spellings, and it
	// is also where the advanced second pass puts its bias sentence. Which
	// of the two wins, and how a dictionary is bounded to fit, is one policy
	// shared with the local engine.
	const promptValue = whisperPromptValue(options);
	if (promptValue) {
		fields.push({
			type: 'text',
			name: 'prompt',
			value: promptValue,
		});
	}
	return fields;
}

/**
 * OpenAI-compatible Whisper transcription provider. Accepts the original
 * container (mp3, wav, webm, m4a, ...) up to the 25 MB API limit; larger
 * recordings are decoded and split into WAV chunks by the service.
 */
export class WhisperApiProvider implements TranscriptionProvider {
	readonly id = TRANSCRIPTION_PROVIDER_IDS.WHISPER_API;
	readonly label = EngineLabel.WhisperApi;
	readonly requiresNetwork = true;
	readonly capabilities: ProviderCapabilities = WHISPER_API_CAPABILITIES;

	constructor(private readonly config: WhisperApiConfig) {}

	async transcribe(
		payload: AudioPayload,
		options: TranscribeOptions,
	): Promise<WhisperResult> {
		const translating = options.translateToEnglish === true;
		// Asked for only where there is an operation that answers them. The
		// translation one has no timestamp granularity among its fields, and
		// returns segments and never words, so a granularity sent to it is
		// refused exactly as the language hint below is - which cost the whole
		// translation, since every part of every recording carried one.
		const granularities: string[] = [];
		if (!translating) {
			granularities.push('segment');
			if (options.wordTimestamps) {
				granularities.push('word');
			}
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
		fields.push(...optionalFields(options, translating));

		const { body, contentType } = buildMultipart(fields);
		const json = await requestJson({
			url: `${trimTrailingSlash(this.config.baseUrl)}${
				translating
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
