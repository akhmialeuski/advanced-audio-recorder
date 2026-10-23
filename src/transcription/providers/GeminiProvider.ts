/**
 * Transcription via Google Gemini. Uploads one audio payload with the File API,
 * then asks `generateContent` for a structured JSON transcript with timecodes
 * and optional speaker labels. The orchestrator sends a short recording whole
 * (one payload, so speaker numbering stays consistent across it) and splits a
 * recording too long for one request into parts. A container Gemini does not
 * read (e.g. webm) arrives already decoded to 16 kHz mono WAV: the service
 * converts it once per run, so this provider uploads the bytes it is lent and
 * nothing else.
 * @module transcription/providers/GeminiProvider
 */

import {
	GEMINI_API_KEY_HEADER,
	GEMINI_GENERATE_MIN_TIMEOUT_MS,
	TRANSCRIPTION_PROVIDER_IDS,
} from '../../constants';
import { EngineLabel } from '../../providers/providers';
import { DICTIONARY_JOIN_SEPARATOR } from '../dictionaryBias';
import { authHeader, inferenceTimeoutMs, requestJson } from '../httpClient';
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
	geminiGenerationControls,
} from './geminiShared';
import type { WhisperResult } from './whisperResponse';
import { OTHER_SEGMENT_LANGUAGE } from '../TranscriptTypes';
import type {
	AudioPayload,
	ProviderCapabilities,
	TranscribeOptions,
	TranscriptionProvider,
} from './TranscriptionProvider';

/**
 * Temperature asked for by a transcription, which has one right answer and no
 * use for variety. Sent only to the generations that are tuned to take it; see
 * {@link geminiGenerationControls}.
 */
const DETERMINISTIC_TEMPERATURE = 0;

/** Configuration for the Gemini provider. */
export interface GeminiConfig {
	baseUrl: string;
	apiKey: string;
	model: string;
	/** Per-request timeout cap (ms); the user-configured transcription limit. */
	requestTimeoutMs?: number;
}

/** System instruction; the response schema enforces the output shape. */
const SYSTEM_PROMPT =
	'You are a professional meeting transcription assistant. Transcribe the ' +
	'audio verbatim. Write each segment in the language actually spoken; do ' +
	'not translate, and keep technology names as spoken. Provide a start (and ' +
	'when possible an end) timecode in seconds for every segment.';

/** Fields every transcript segment the schema describes must carry. */
const SEGMENT_REQUIRED_FIELDS = ['start', 'text'];

/**
 * Structured-output schema (Gemini uses UPPERCASE OpenAPI type names): an
 * object with optional detected `language` and an array of `segments`, each a
 * start/end in seconds, an optional speaker label, and the spoken text.
 *
 * A recording configured with several languages asks every segment for its
 * own, limited to the configured codes plus {@link OTHER_SEGMENT_LANGUAGE}.
 * A free-form field was the other choice, and it leaves the model free to
 * answer "Polish" where a code is read. Without the extra value a third
 * language spoken in passing has to be tagged with a code it is not in.
 * @param languages - The configured languages, when more than one
 * @returns The response schema for the request
 */
function transcriptSchema(languages: readonly string[] | undefined): object {
	const segmentProperties: Record<string, object> = {
		start: { type: 'NUMBER' },
		end: { type: 'NUMBER' },
		speaker: { type: 'STRING' },
		text: { type: 'STRING' },
	};
	const required = [...SEGMENT_REQUIRED_FIELDS];
	if (languages) {
		segmentProperties.language = {
			type: 'STRING',
			enum: [...languages, OTHER_SEGMENT_LANGUAGE],
		};
		required.push('language');
	}
	return {
		type: 'OBJECT',
		properties: {
			language: { type: 'STRING' },
			segments: {
				type: 'ARRAY',
				items: {
					type: 'OBJECT',
					properties: segmentProperties,
					required,
				},
			},
		},
		required: ['segments'],
	};
}

/**
 * The instruction for a recording that switches between the configured
 * languages. It names no language of its own: the list is the user's, and the
 * rules hold for any pair. Script and spelling are named because a model that
 * settles on one language writes the other in its orthography, which is how a
 * Ukrainian passage came back as Polish-looking Latin text.
 * @param languages - The configured languages, more than one
 * @returns The sentences that replace the single-language line
 */
function languageListInstruction(languages: readonly string[]): string {
	return (
		`The recording switches between these languages: ${languages.join(', ')}. ` +
		'Speakers may change language between sentences or inside one sentence. ' +
		"Write every segment in the language actually spoken, in that language's own script and spelling, " +
		"never respell one language in another's orthography, and never translate. " +
		"Start a new segment wherever the language changes, and set each segment's language to the code of the language it is written in, " +
		`or to "${OTHER_SEGMENT_LANGUAGE}" when it is in none of the listed languages.`
	);
}

/**
 * Task-specific remedy appended to the truncation error. Unlike the LLM path,
 * transcription exposes no output-token setting, so the advice is to shorten the
 * recording or change model rather than to raise a limit.
 */
const TRUNCATION_REMEDY =
	'Use a shorter recording, split it into parts, or choose a model with a ' +
	'larger output limit.';

/** Builds the per-run instruction text sent alongside the audio. */
function buildInstruction(options: TranscribeOptions): string {
	const lines = [
		'Transcribe the attached audio into ordered segments.',
		options.languages
			? languageListInstruction(options.languages)
			: options.language
				? `The primary language is "${options.language}", but transcribe each segment in the language actually spoken.`
				: 'Detect the spoken language(s) and transcribe each segment in the language actually spoken.',
		options.diarize
			? 'Identify distinct speakers and label each segment (e.g. "Speaker 1", "Speaker 2"); use real names when clearly stated.'
			: 'Do not include speaker labels.',
	];
	if (options.dictionary?.length) {
		lines.push(
			`Prefer these spellings for names and terms when you hear them: ${options.dictionary.join(DICTIONARY_JOIN_SEPARATOR)}.`,
		);
	}
	const biasPrompt = options.biasPrompt?.trim();
	if (biasPrompt) {
		// The advanced second pass folds its generated context (topic, names,
		// jargon, canonical English acronyms) into the instruction text - the
		// only biasing channel Gemini offers. Framed as context about the
		// recording, not as text to reproduce, so the model still transcribes
		// from the audio.
		lines.push(
			`Context about this recording (topic, speaker names, domain terms, and canonical acronym spellings heard in it): ${biasPrompt}`,
		);
	}
	return lines.join(' ');
}

/** Google Gemini multimodal transcription provider. */
export class GeminiProvider implements TranscriptionProvider {
	readonly id = TRANSCRIPTION_PROVIDER_IDS.GEMINI;
	readonly label = EngineLabel.Gemini;
	readonly requiresNetwork = true;
	readonly capabilities: ProviderCapabilities = GEMINI_CAPABILITIES;

	constructor(private readonly config: GeminiConfig) {}

	async transcribe(
		payload: AudioPayload,
		options: TranscribeOptions,
	): Promise<WhisperResult> {
		// Already in a container the File API reads (see the capability's
		// originalContainers), and only read here: the same payload is sent
		// again when the service waits out a refusal.
		const file = await uploadFile(
			this.config.baseUrl,
			this.config.apiKey,
			payload.data,
			payload.contentType,
			payload.filename,
			this.config.requestTimeoutMs,
			options.signal,
		);
		try {
			await waitUntilActive(
				this.config.baseUrl,
				this.config.apiKey,
				file.name,
				fileProcessingWaitMs(payload.data.byteLength),
				options.signal,
			);
			const url = geminiGenerateContentUrl(
				this.config.baseUrl,
				this.config.model,
			);
			// Transcription is deterministic, so the request asks for as
			// little reasoning as this model's generation allows and for the
			// temperature that generation is tuned for. Both follow from the
			// generation, so both are answered in one place.
			const controls = geminiGenerationControls(
				this.config.model,
				DETERMINISTIC_TEMPERATURE,
			);
			const json = await requestJson({
				url,
				method: 'POST',
				headers: authHeader(GEMINI_API_KEY_HEADER, this.config.apiKey),
				contentType: 'application/json',
				body: JSON.stringify({
					contents: [
						{
							parts: [
								{
									fileData: {
										mimeType: payload.contentType,
										fileUri: file.uri,
									},
								},
								{ text: buildInstruction(options) },
							],
						},
					],
					systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
					generationConfig: {
						responseMimeType: 'application/json',
						responseSchema: transcriptSchema(options.languages),
						...controls,
					},
				}),
				timeoutMs: inferenceTimeoutMs(
					payload.data.byteLength,
					GEMINI_GENERATE_MIN_TIMEOUT_MS,
					this.config.requestTimeoutMs,
				),
				signal: options.signal,
			});
			// A truncated (MAX_TOKENS) response yields invalid JSON, and a
			// safety/policy block yields no candidate; both would otherwise map
			// to an empty transcript with no explanation.
			assertGeminiNotTruncated(json, TRUNCATION_REMEDY);
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
