/**
 * Transcription via AssemblyAI's pre-recorded API. Unlike the engines that
 * answer one request, AssemblyAI works as a job: the audio is uploaded
 * (`POST /v2/upload`), a transcript is queued for it (`POST /v2/transcript`),
 * and its status is read until it completes (`GET /v2/transcript/{id}`). The
 * segments are then read as sentences (`GET /v2/transcript/{id}/sentences`).
 * The paths and field names are those of AssemblyAI's own generated client,
 * `assemblyai` 4.43.4. A queued job is billed and cannot be taken back, so a
 * read that fails for a while is repeated here and never reported as worth
 * sending the part again.
 * @module transcription/providers/AssemblyAiProvider
 */

import {
	ASSEMBLYAI_POLL_INTERVAL_MS,
	TRANSCRIBE_MAX_REQUEST_TIMEOUT_MS,
	TRANSCRIPTION_PROVIDER_IDS,
} from '../../constants';
import { EngineLabel } from '../../providers/providers';
import { delay } from '../../utils/TimeUtils';
import { termsWithinAssemblyAiKeyterms } from '../dictionaryBias';
import { dedupeTerms } from '../dictionary';
import {
	authHeader,
	HttpError,
	requestJson,
	trimTrailingSlash,
	uploadTimeoutMs,
} from '../httpClient';
import { mapAssemblyAiResponse } from './assemblyAiResponse';
import { ASSEMBLYAI_CAPABILITIES } from './capabilities';
import { isRecord } from './responseUtils';
import type { WhisperResult } from './whisperResponse';
import type {
	AudioPayload,
	ProviderCapabilities,
	TranscribeOptions,
	TranscriptionProvider,
} from './TranscriptionProvider';

/** Status used for failures that never reached an HTTP response. */
const NO_HTTP_STATUS = 0;

/** The job status that ends the wait with a transcript. */
const STATUS_COMPLETED = 'completed';

/** The job status that ends the wait with AssemblyAI's own reason. */
const STATUS_ERROR = 'error';

/** Configuration for the AssemblyAI provider. */
export interface AssemblyAiConfig {
	baseUrl: string;
	apiKey: string;
	model: string;
	/**
	 * The user-configured transcription limit (ms). Caps the upload, and is
	 * the whole budget the job is given to complete.
	 */
	requestTimeoutMs?: number;
}

/**
 * Reads a field the next step cannot go on without.
 * @param body - A parsed response body
 * @param field - The field the step needs
 * @param failure - What to report when the body does not carry it
 * @returns The field's value
 */
function requiredString(body: unknown, field: string, failure: string): string {
	const value = isRecord(body) ? body[field] : undefined;
	if (typeof value !== 'string') {
		throw new HttpError(NO_HTTP_STATUS, failure);
	}
	return value;
}

/**
 * AssemblyAI pre-recorded transcription provider. Uploads the payload it is
 * lent as it stands and only reads it, so the service can send the same
 * payload again after a refusal.
 */
export class AssemblyAiProvider implements TranscriptionProvider {
	readonly id = TRANSCRIPTION_PROVIDER_IDS.ASSEMBLYAI;
	readonly label = EngineLabel.AssemblyAi;
	readonly requiresNetwork = true;
	readonly capabilities: ProviderCapabilities = ASSEMBLYAI_CAPABILITIES;

	/** The API root every path of this client hangs off. */
	private readonly base: string;

	/** AssemblyAI takes the bare key, with no scheme in front of it. */
	private readonly headers: Record<string, string>;

	constructor(private readonly config: AssemblyAiConfig) {
		this.base = `${trimTrailingSlash(config.baseUrl)}/v2`;
		this.headers = authHeader('Authorization', config.apiKey);
	}

	async transcribe(
		payload: AudioPayload,
		options: TranscribeOptions,
	): Promise<WhisperResult> {
		const { signal } = options;
		const uploaded = await requestJson<unknown>({
			url: `${this.base}/upload`,
			method: 'POST',
			headers: this.headers,
			contentType: 'application/octet-stream',
			body: payload.data,
			timeoutMs: uploadTimeoutMs(
				payload.data.byteLength,
				this.config.requestTimeoutMs,
			),
			signal,
		});
		const queued = await requestJson<unknown>({
			url: `${this.base}/transcript`,
			method: 'POST',
			headers: this.headers,
			contentType: 'application/json',
			body: JSON.stringify(
				this.jobRequest(
					requiredString(
						uploaded,
						'upload_url',
						'AssemblyAI upload did not return an upload URL.',
					),
					options,
				),
			),
			signal,
		});
		const id = requiredString(
			queued,
			'id',
			'AssemblyAI did not return a transcript ID.',
		);
		const [transcript, sentences] = await this.readCompletedJob(id, signal);
		return mapAssemblyAiResponse(transcript, sentences, options.diarize);
	}

	/**
	 * Waits for a queued job and reads what it produced. Everything from here
	 * on only reads, which is what lets a failure be waited out in place.
	 *
	 * The budget is the user's transcription limit as a whole rather than a
	 * figure scaled from the upload, because what is waited for is the
	 * inference and its length follows the audio, not the bytes.
	 *
	 * Sentences rather than the transcript's own `utterances`: an utterance
	 * is a whole speaker turn, so a monologue of several minutes would be one
	 * segment under one timecode, and without speaker labels there are no
	 * utterances at all. Sentences come back either way, each with its
	 * speaker and its words.
	 * @param id - The ID the endpoint gave the job
	 * @param signal - The run's cancel
	 * @returns The completed transcript and its sentences, as parsed bodies
	 */
	private async readCompletedJob(
		id: string,
		signal: AbortSignal | undefined,
	): Promise<[transcript: Record<string, unknown>, sentences: unknown]> {
		const transcriptUrl = `${this.base}/transcript/${encodeURIComponent(id)}`;
		const deadline =
			Date.now() +
			(this.config.requestTimeoutMs ?? TRANSCRIBE_MAX_REQUEST_TIMEOUT_MS);
		const transcript = await this.waitUntilCompleted(
			transcriptUrl,
			deadline,
			signal,
		);
		return [
			transcript,
			await this.readJob(`${transcriptUrl}/sentences`, deadline, signal),
		];
	}

	/**
	 * The body that queues a transcript for an uploaded recording.
	 *
	 * Generated keyterms (the advanced second pass) go ahead of the user's
	 * dictionary in one combined list, so when the word budget bites the
	 * context mined from this very recording wins over the static glossary.
	 * The service already trimmed the dictionary to the budget, and
	 * re-applying it here keeps a provider used directly within what the
	 * endpoint accepts.
	 * @param audioUrl - Where the upload step stored the recording
	 * @param options - Transcription options
	 * @returns The request body, before it is serialized
	 */
	private jobRequest(
		audioUrl: string,
		options: TranscribeOptions,
	): Record<string, unknown> {
		const keyterms = termsWithinAssemblyAiKeyterms(
			this.config.model,
			dedupeTerms([
				...(options.keyterms ?? []),
				...(options.dictionary ?? []),
			]),
		);
		return {
			audio_url: audioUrl,
			speech_models: [this.config.model],
			speaker_labels: options.diarize,
			// AssemblyAI writes a regional code with an underscore (`en_us`),
			// where the settings field takes the usual `en-US`.
			...(options.language
				? {
						language_code: options.language
							.toLowerCase()
							.replace('-', '_'),
					}
				: { language_detection: true }),
			...(keyterms.length ? { keyterms_prompt: keyterms } : {}),
		};
	}

	/**
	 * Reads one resource of a queued job, waiting out a failure that passes.
	 *
	 * By now the job is billed, and the service answers a retryable failure
	 * by calling {@link transcribe} again, which would upload the recording
	 * and queue a second job beside the first. A GET is safe to repeat, so a
	 * temporary refusal and a request that never reached an answer are both
	 * read again here, after the pause the endpoint asked for or one poll
	 * interval. Once the pause no longer fits the job's budget the failure
	 * leaves as one that is not retryable.
	 * @param url - The job's own URL, or that of its sentences
	 * @param deadline - When the job's budget runs out, as a timestamp
	 * @param signal - The run's cancel, which also ends the pause
	 * @returns The parsed body of the answer
	 */
	private async readJob(
		url: string,
		deadline: number,
		signal: AbortSignal | undefined,
	): Promise<unknown> {
		for (;;) {
			try {
				return await requestJson<unknown>({
					url,
					method: 'GET',
					headers: this.headers,
					signal,
				});
			} catch (error) {
				if (
					!(error instanceof HttpError) ||
					!(error.retryable || error.status === NO_HTTP_STATUS)
				) {
					throw error;
				}
				const waitMs =
					error.retryAfterMs ?? ASSEMBLYAI_POLL_INTERVAL_MS;
				if (Date.now() + waitMs > deadline) {
					throw new HttpError(error.status, error.message);
				}
				await delay(waitMs, signal);
			}
		}
	}

	/**
	 * Reads a job's status until it completes, throwing AssemblyAI's own
	 * reason when the job fails and a timeout when the budget runs out.
	 * @param transcriptUrl - The job's own URL
	 * @param deadline - When the job's budget runs out, as a timestamp
	 * @param signal - Ends the wait when the run is cancelled, reaching both
	 *   the status request and the pause between two of them
	 * @returns The parsed body of the completed transcript
	 */
	private async waitUntilCompleted(
		transcriptUrl: string,
		deadline: number,
		signal: AbortSignal | undefined,
	): Promise<Record<string, unknown>> {
		for (;;) {
			const body = await this.readJob(transcriptUrl, deadline, signal);
			const transcript = isRecord(body) ? body : {};
			if (transcript.status === STATUS_COMPLETED) {
				return transcript;
			}
			if (transcript.status === STATUS_ERROR) {
				throw new HttpError(
					NO_HTTP_STATUS,
					`AssemblyAI could not transcribe the recording: ${typeof transcript.error === 'string' ? transcript.error : 'no reason was given'}`,
				);
			}
			if (Date.now() >= deadline) {
				throw new HttpError(
					NO_HTTP_STATUS,
					'Timed out waiting for AssemblyAI to transcribe the recording.',
				);
			}
			await delay(ASSEMBLYAI_POLL_INTERVAL_MS, signal);
		}
	}
}
