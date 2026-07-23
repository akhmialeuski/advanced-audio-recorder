/**
 * Transcription via Deepgram's pre-recorded API
 * (`POST {baseUrl}/listen`). Sends the audio bytes directly with the
 * file's content type and reads back diarized, smart-formatted segments.
 * Deepgram accepts the original container up to 2 GB and diarizes a whole
 * request with stable speaker numbering, so the service sends the file in
 * one piece instead of chunking it.
 * @module transcription/providers/DeepgramProvider
 */

import { TRANSCRIPTION_PROVIDER_IDS } from '../../constants';
import {
	DEEPGRAM_KEYWORDS_LIMIT,
	deepgramBiasMechanism,
	termsWithinDeepgramKeyterm,
} from '../dictionaryBias';
import { dedupeTerms } from '../dictionary';
import { requestJson, trimTrailingSlash, uploadTimeoutMs } from '../httpClient';
import { DEEPGRAM_CAPABILITIES } from './capabilities';
import { mapDeepgramResponse } from './deepgramResponse';
import type { WhisperResult } from './whisperResponse';
import type {
	AudioPayload,
	ProviderCapabilities,
	TranscribeOptions,
	TranscriptionProvider,
} from './TranscriptionProvider';

/** Configuration for the Deepgram provider. */
export interface DeepgramConfig {
	baseUrl: string;
	apiKey: string;
	model: string;
	/** Per-request timeout cap (ms); the user-configured transcription limit. */
	requestTimeoutMs?: number;
}

/**
 * Deepgram pre-recorded transcription provider.
 */
export class DeepgramProvider implements TranscriptionProvider {
	readonly id = TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM;
	readonly label = 'Deepgram';
	readonly requiresNetwork = true;
	readonly capabilities: ProviderCapabilities = DEEPGRAM_CAPABILITIES;

	constructor(private readonly config: DeepgramConfig) {}

	async transcribe(
		payload: AudioPayload,
		options: TranscribeOptions,
	): Promise<WhisperResult> {
		const params = new URLSearchParams();
		params.set('model', this.config.model);
		params.set('smart_format', 'true');
		params.set('punctuate', 'true');
		// Utterances give clean per-turn segments (with speakers when
		// diarizing) that map directly onto the transcript model.
		params.set('utterances', 'true');
		if (options.diarize) {
			params.set('diarize', 'true');
		}
		if (options.language) {
			params.set('language', options.language);
		} else {
			params.set('detect_language', 'true');
		}
		// Generated keyterms (the advanced second pass) go ahead of the user's
		// dictionary in one combined list, so when the per-model limits bite,
		// the generated context - mined from this very recording - wins over
		// the static glossary. Case-insensitive de-duplication keeps a term the
		// pipeline and the dictionary both carry from being sent twice.
		const biasTerms = dedupeTerms([
			...(options.keyterms ?? []),
			...(options.dictionary ?? []),
		]);
		if (biasTerms.length) {
			// The mechanism is model-specific: nova-3 uses keyterm prompting,
			// nova-2 and older use keywords boosting, and the hosted Whisper
			// models support neither, so they send nothing. Each mechanism has a
			// hard request limit (keyterm: entry count and aggregate tokens;
			// keywords: entry count). The service already trims to these, and
			// this re-applies them so a provider used directly with a longer list
			// still stays within what Deepgram accepts.
			const mechanism = deepgramBiasMechanism(this.config.model);
			if (mechanism) {
				const terms =
					mechanism === 'keyterm'
						? termsWithinDeepgramKeyterm(biasTerms)
						: biasTerms.slice(0, DEEPGRAM_KEYWORDS_LIMIT);
				for (const term of terms) {
					params.append(mechanism, term);
				}
			}
		}

		const url = `${trimTrailingSlash(this.config.baseUrl)}/listen?${params.toString()}`;
		const json = await requestJson({
			url,
			method: 'POST',
			headers: { Authorization: `Token ${this.config.apiKey}` },
			contentType: payload.contentType,
			body: payload.data,
			timeoutMs: uploadTimeoutMs(
				payload.data.byteLength,
				this.config.requestTimeoutMs,
			),
			signal: options.signal,
		});
		return mapDeepgramResponse(json, options.diarize);
	}
}
