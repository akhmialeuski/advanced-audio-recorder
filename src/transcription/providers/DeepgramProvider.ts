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
		if (options.dictionary?.length) {
			// nova-3 uses keyterm prompting; nova-2 and older use keywords
			// boosting. Both are multi-valued, so append one entry per term.
			const param = this.config.model.startsWith('nova-3')
				? 'keyterm'
				: 'keywords';
			for (const term of options.dictionary) {
				params.append(param, term);
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
