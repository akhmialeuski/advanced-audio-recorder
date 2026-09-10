/**
 * Transcription via Mistral's Voxtral batch endpoint
 * (`POST {baseUrl}/audio/transcriptions`), a multipart request answering in a
 * shape close enough to Whisper's `verbose_json` that the same mapper reads it.
 *
 * Two properties of the endpoint decide what the request carries. Segments come
 * back only when a timestamp granularity is asked for, so the segment level is
 * sent on every run - and only that level, because the answer models no
 * per-word shape at all. And Mistral documents that granularity as incompatible
 * with a language hint, so the hint is never sent and the engine detects the
 * language itself, which the capability `readsLanguageHint` states and the
 * settings row repeats to the user.
 * @module transcription/providers/VoxtralProvider
 */

import {
	MIME_TYPE_AUDIO_PREFIX,
	TRANSCRIBE_SAMPLE_RATE,
	TRANSCRIPTION_PROVIDER_IDS,
	VOXTRAL_AUDIO_MIME_TYPES,
} from '../../constants';
import { isDecodableSize, tooLargeMessage } from '../../platform/capabilities';
import { decodeToMono16k, encodeMonoWav } from '../audioChunks';
import { dedupeTerms } from '../dictionary';
import { voxtralContextBiasTerms } from '../dictionaryBias';
import {
	authHeader,
	buildMultipart,
	requestJson,
	trimTrailingSlash,
	uploadTimeoutMs,
	type MultipartField,
} from '../httpClient';
import { VOXTRAL_CAPABILITIES } from './capabilities';
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
 * The only timestamp level asked for. Without one the response carries no
 * segments; the word level is not asked for because nothing in the answer
 * carries words (see {@link VOXTRAL_CAPABILITIES}).
 */
const SEGMENT_GRANULARITY = 'segment';

/** Container a decoded upload takes, named once so its type and its extension agree. */
const WAV_EXTENSION = 'wav';

/** MIME type used when a container is decoded before upload. */
const WAV_MIME = `${MIME_TYPE_AUDIO_PREFIX}${WAV_EXTENSION}`;

/** Trailing extension of a file name, including its dot. */
const EXTENSION_PATTERN = /\.[^./\\]+$/;

/** One multipart file part: the bytes and the two things that describe them. */
interface UploadPart {
	data: ArrayBuffer;
	contentType: string;
	filename: string;
}

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
		const audio = await this.uploadBody(payload);
		const fields: MultipartField[] = [
			{
				type: 'file',
				name: 'file',
				filename: audio.filename,
				contentType: audio.contentType,
				data: audio.data,
			},
			{ type: 'text', name: 'model', value: this.config.model },
			// Sent on every run: without a granularity the response carries an
			// empty `segments` array and only the flat transcript text, which
			// would cost this engine every timing the plugin is built on. Only
			// the segment level is asked for, because the answer has no shape a
			// word could arrive in (see VOXTRAL_CAPABILITIES.wordTimestamps).
			{
				type: 'text',
				name: 'timestamp_granularities',
				value: SEGMENT_GRANULARITY,
			},
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
			timeoutMs: uploadTimeoutMs(
				body.byteLength,
				this.config.requestTimeoutMs,
			),
			signal: options.signal,
		});
		return mapWhisperResponse(json);
	}

	/**
	 * The whole upload part: the bytes, the type declared for them, and the
	 * name they are sent under. The original container where the endpoint takes
	 * it, a decoded 16 kHz mono WAV otherwise.
	 *
	 * The name travels with the other two rather than being taken from the
	 * payload at the call site, because all three describe the same bytes and a
	 * decode changes all three at once. Sending decoded WAV under the recording's
	 * own `.webm` name announced one container in the part's header and another
	 * in its filename, and Mistral's own client derives a part's type from that
	 * filename - so the engine's most common input, this plugin's default
	 * recording format, was the one that contradicted itself.
	 *
	 * The size is checked before the decode rather than after, because the
	 * decode is the allocation: it expands the file to full PCM in memory, and
	 * on a phone exceeding the ceiling is not a catchable error but the OS
	 * killing the WebView. This engine needs the check more than the others do,
	 * since it declares no per-request duration cap and so is handed whole
	 * recordings of any length.
	 * @param payload - The audio bytes and their metadata
	 * @returns The bytes to send, their content type, and their filename
	 */
	private async uploadBody(payload: AudioPayload): Promise<UploadPart> {
		if (VOXTRAL_AUDIO_MIME_TYPES.has(payload.contentType)) {
			return {
				data: payload.data,
				contentType: payload.contentType,
				filename: payload.filename,
			};
		}
		if (!isDecodableSize(payload.data.byteLength)) {
			throw new Error(
				tooLargeMessage('transcribe with Mistral Voxtral', {
					desktopAdvice:
						'Record or convert it to mp3, m4a, ogg, flac or wav, which this engine uploads without decoding.',
				}),
			);
		}
		return {
			data: await encodeMonoWav(
				await decodeToMono16k(payload.data),
				TRANSCRIBE_SAMPLE_RATE,
			),
			contentType: WAV_MIME,
			filename: `${payload.filename.replace(EXTENSION_PATTERN, '')}.${WAV_EXTENSION}`,
		};
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
