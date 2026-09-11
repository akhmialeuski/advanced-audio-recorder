/**
 * Transcription via Mistral's Voxtral batch endpoint
 * (`POST {baseUrl}/audio/transcriptions`), a multipart request answering in a
 * shape close enough to Whisper's `verbose_json` that the same mapper reads it.
 *
 * Two properties of the endpoint decide what the request carries. Segments come
 * back only when a timestamp granularity is asked for, so the segment level is
 * sent on every run and the word level joins it when the run asks for per-word
 * timing. And Mistral documents that granularity as incompatible with a
 * language hint, so the hint is never sent and the engine detects the language
 * itself, which the capability `readsLanguageHint` states and the settings row
 * repeats to the user.
 * @module transcription/providers/VoxtralProvider
 */

import {
	TRANSCRIPTION_PROVIDER_IDS,
	VOXTRAL_AUDIO_EXTENSIONS,
	VOXTRAL_MAX_REQUEST_SECONDS,
	VOXTRAL_TRANSCRIBE_MIN_TIMEOUT_MS,
} from '../../constants';
import { dedupeTerms } from '../dictionary';
import { voxtralContextBiasTerms } from '../dictionaryBias';
import {
	authHeader,
	buildMultipart,
	inferenceTimeoutMs,
	requestJson,
	trimTrailingSlash,
	type MultipartField,
} from '../httpClient';
import { VOXTRAL_CAPABILITIES } from './capabilities';
import { uploadContainer } from './uploadContainer';
import { mapWhisperResponse, type WhisperResult } from './whisperResponse';
import type {
	AudioPayload,
	ProviderCapabilities,
	TranscribeOptions,
	TranscriptionProvider,
} from './TranscriptionProvider';

/** Operation that writes the speech down in the language it was spoken in. */
const VOXTRAL_TRANSCRIPTIONS_PATH = '/audio/transcriptions';

/**
 * The timestamp level every run asks for. Without one the response carries no
 * segments at all, only the flat transcript text.
 */
const SEGMENT_GRANULARITY = 'segment';

/**
 * The level added when the run asks for per-word timing. Mistral lists
 * word-level timestamps among this model's features and its API takes `word`
 * here, so the switch steers the request (see {@link VOXTRAL_CAPABILITIES}).
 */
const WORD_GRANULARITY = 'word';

/**
 * The containers the endpoint reads, in the refusal's own words, so a user
 * told to convert is told what to convert to.
 */
const VOXTRAL_ACCEPTED_CONTAINERS = 'mp3, m4a, ogg, flac or wav';

/** Configuration for the Voxtral provider. */
export interface VoxtralConfig {
	baseUrl: string;
	apiKey: string;
	model: string;
	/** Per-request timeout cap (ms); the user-configured transcription limit. */
	requestTimeoutMs?: number;
}

/**
 * Mistral Voxtral transcription provider. Accepts the original container for
 * the formats the endpoint takes and decodes the rest - notably the `audio/webm`
 * this plugin records by default - to 16 kHz mono WAV, the way the Gemini
 * provider does for the same reason.
 */
export class VoxtralProvider implements TranscriptionProvider {
	readonly id = TRANSCRIPTION_PROVIDER_IDS.VOXTRAL;
	readonly label = 'Mistral Voxtral';
	readonly requiresNetwork = true;
	readonly capabilities: ProviderCapabilities = VOXTRAL_CAPABILITIES;

	constructor(private readonly config: VoxtralConfig) {}

	async transcribe(
		payload: AudioPayload,
		options: TranscribeOptions,
	): Promise<WhisperResult> {
		const audio = await uploadContainer(payload, {
			// Asked by extension, the unit Mistral publishes its list in. A MIME
			// gate could not tell the `m4a` the endpoint reads from the `mp4`
			// it does not, because the format registry gives both `audio/mp4`,
			// and `mp4` is what iOS falls back to recording in.
			accepts: ({ extension }) => VOXTRAL_AUDIO_EXTENSIONS.has(extension),
			engineLabel: this.label,
			acceptedContainers: VOXTRAL_ACCEPTED_CONTAINERS,
			// Read from the engine's own declaration rather than named again
			// here, so the ceiling the service proves the source against and
			// the one a decoded upload is proven against are one number.
			maxRequestBytes: this.capabilities.maxRequestBytes,
			// Not the capability's duration cap, which stays unbounded so the
			// service keeps uploading whole containers (see
			// VOXTRAL_MAX_REQUEST_SECONDS). The endpoint's real limit binds well
			// before the byte ceiling does - three hours is about 346 MB of this
			// WAV against a 1 GB request - so without it the nine hours that
			// gigabyte holds were uploaded before Mistral declined them.
			maxRequestSeconds: VOXTRAL_MAX_REQUEST_SECONDS,
		});
		const granularities = options.wordTimestamps
			? [SEGMENT_GRANULARITY, WORD_GRANULARITY]
			: [SEGMENT_GRANULARITY];
		const fields: MultipartField[] = [
			{
				type: 'file',
				name: 'file',
				filename: audio.filename,
				contentType: audio.contentType,
				data: audio.data,
			},
			{ type: 'text', name: 'model', value: this.config.model },
			// The segment level goes on every run: without a granularity the
			// response carries an empty `segments` array and only the flat
			// transcript text, which would cost this engine every timing the
			// plugin is built on. The word level is added alongside it rather
			// than instead of it, because the segments are what the transcript
			// is assembled from and words only annotate them. One repeated
			// field per level, which is how Mistral's own client sends the
			// array, and unbracketed unlike the OpenAI spelling.
			...granularities.map((value) => ({
				type: 'text' as const,
				name: 'timestamp_granularities',
				value,
			})),
		];
		if (options.diarize) {
			fields.push({ type: 'text', name: 'diarize', value: 'true' });
		}
		// A language hint is deliberately absent. Mistral documents `language`
		// as incompatible with `timestamp_granularities`, and the granularity is
		// what makes the response carry segments at all, so the hint is the one
		// that gives way. The service already drops it through effectiveLanguage;
		// this provider never reads options.language, so a caller constructing it
		// directly cannot reinstate a request the endpoint would refuse.
		for (const term of this.biasTerms(options)) {
			fields.push({ type: 'text', name: 'context_bias', value: term });
		}

		const { body, contentType } = buildMultipart(fields);
		const json = await requestJson({
			url: `${trimTrailingSlash(this.config.baseUrl)}${VOXTRAL_TRANSCRIPTIONS_PATH}`,
			method: 'POST',
			headers: authHeader('Authorization', this.config.apiKey, 'Bearer'),
			contentType,
			body,
			// The size-scaled budget funds the transfer and nothing else, and
			// this engine hands the endpoint up to three hours of audio to work
			// through in one request, so the floor underneath it is what the
			// inference actually gets (see VOXTRAL_TRANSCRIBE_MIN_TIMEOUT_MS).
			timeoutMs: inferenceTimeoutMs(
				body.byteLength,
				VOXTRAL_TRANSCRIBE_MIN_TIMEOUT_MS,
				this.config.requestTimeoutMs,
			),
			signal: options.signal,
		});
		return mapWhisperResponse(json);
	}

	/**
	 * The terms this run biases recognition toward, in the form `context_bias`
	 * takes them.
	 *
	 * Generated keyterms from the advanced second pass go ahead of the user's
	 * dictionary in one combined list, so when the entry cap bites the context
	 * mined from this very recording wins over the static glossary - the same
	 * order the Deepgram provider applies for the same reason. The service
	 * already trimmed the dictionary to the cap; re-applying it here keeps a
	 * provider used directly within what the endpoint accepts.
	 * @param options - Transcription options
	 * @returns The entries to send, empty when the run biases nothing
	 */
	private biasTerms(options: TranscribeOptions): string[] {
		const terms = dedupeTerms([
			...(options.keyterms ?? []),
			...(options.dictionary ?? []),
		]);
		return terms.length ? voxtralContextBiasTerms(terms) : [];
	}
}
