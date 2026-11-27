/**
 * Transcription via Google Gemini. Sends one audio payload inline when it fits
 * an inline request and through the File API otherwise, then asks
 * `generateContent` for a structured JSON transcript with timecodes
 * and optional speaker labels. The orchestrator sends a short recording whole
 * (one payload, so speaker numbering stays consistent across it) and asks for
 * a recording too long for one request in parts. A part that names a stretch
 * of the recording is cut out by Gemini itself: the recording is uploaded
 * once for the run, every part's request points at that upload with the
 * stretch it is for, and the upload is deleted when the run disposes of the
 * provider. A container Gemini does not read arrives already decoded to
 * 16 kHz mono WAV: the service converts it once per run, so this provider
 * uploads the bytes it is lent and nothing else.
 * @module transcription/providers/GeminiProvider
 */

import { arrayBufferToBase64 } from 'obsidian';
import {
	GEMINI_API_KEY_HEADER,
	GEMINI_GENERATE_MIN_TIMEOUT_MS,
	GEMINI_INLINE_MAX_BYTES,
	GEMINI_MIN_OUTPUT_TOKENS,
	GEMINI_OUTPUT_TOKENS_PER_SECOND,
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
	type GeminiFile,
} from './geminiFileApi';
import {
	mapGeminiResponse,
	mapGeminiRewrite,
	rebaseToClip,
} from './geminiResponse';
import {
	assertGeminiNotBlocked,
	assertGeminiNotTruncated,
	geminiGenerateContentUrl,
	geminiGenerationControls,
} from './geminiShared';
import type { WhisperResult } from './whisperResponse';
import { OTHER_SEGMENT_LANGUAGE } from '../TranscriptTypes';
import type {
	AudioClip,
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

/**
 * System instruction; the response schema enforces the output shape.
 *
 * Timecodes are asked for as MM:SS, the format Google's audio guide uses
 * (https://ai.google.dev/gemini-api/docs/audio). Measured on a 24-minute
 * lesson cut into two 12-minute parts with gemini-3.8-flash, five runs each:
 * asked for seconds, 7 of 10 parts came back with lines past the part or
 * stopping minutes early, and a phrase spoken at 14:27 landed up to 80 s
 * late; asked for MM:SS, all 10 parts fitted and the phrase landed within a
 * second of where it is spoken.
 */
const SYSTEM_PROMPT =
	'You are a professional meeting transcription assistant. Transcribe the ' +
	'audio verbatim. Write each segment in the language actually spoken; do ' +
	'not translate, and keep technology names as spoken. Provide a start (and ' +
	'when possible an end) timecode for every segment, formatted as MM:SS.';

/** Fields every transcript segment the schema describes must carry. */
const SEGMENT_REQUIRED_FIELDS = ['start', 'text'];

/**
 * Structured-output schema (Gemini uses UPPERCASE OpenAPI type names): an
 * object with optional detected `language` and an array of `segments`, each a
 * start/end as an MM:SS string (see {@link SYSTEM_PROMPT} for why not
 * seconds), an optional speaker label, and the spoken text.
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
		start: { type: 'STRING' },
		end: { type: 'STRING' },
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

/**
 * Schema of a request that carries a rewrite instruction: the rewritten text
 * alone, since nothing downstream reads the verbatim segments of such a run.
 */
const REWRITE_SCHEMA = {
	type: 'OBJECT',
	properties: { text: { type: 'STRING' } },
	required: ['text'],
};

/**
 * What a request for a stretch of an uploaded recording adds to the
 * instruction. Asked the same two stretches of one lesson, the model counted
 * one from the start of the recording (12:06 to 24:06) and the other from the
 * start of the stretch (0:00 to 2:00), so the request says which it wants and
 * the answer is still checked (see `rebaseToClip`).
 */
const CLIP_INSTRUCTION =
	'The audio is an excerpt of a longer recording. Count every timecode ' +
	'from the start of this excerpt, whose first second is 00:00.';

/**
 * A clip boundary in the form `Part.audioMetadata` takes: seconds with an
 * `s` suffix, to the millisecond.
 * @param seconds - The boundary, in seconds from the start of the file
 * @returns The offset string
 */
function clipOffset(seconds: number): string {
	return `${String(Number(seconds.toFixed(3)))}s`;
}

/**
 * The most output tokens a request for this much audio may spend, or
 * undefined when the length of the audio was never measured.
 * @param durationSeconds - How much audio the request covers
 * @returns The limit to send as `maxOutputTokens`
 */
function outputTokenLimit(
	durationSeconds: number | undefined,
): number | undefined {
	if (durationSeconds === undefined) {
		return undefined;
	}
	return Math.max(
		GEMINI_MIN_OUTPUT_TOKENS,
		Math.ceil(durationSeconds * GEMINI_OUTPUT_TOKENS_PER_SECOND),
	);
}

/**
 * What the request says about the language of the recording: every
 * configured language when there are several, the one declared, or nothing
 * but the request to detect it.
 * @param options - The run's options
 * @returns The sentences about language
 */
function languageInstruction(options: TranscribeOptions): string {
	if (options.languages) {
		return languageListInstruction(options.languages);
	}
	return options.language
		? `The primary language is "${options.language}", but transcribe each segment in the language actually spoken.`
		: 'Detect the spoken language(s) and transcribe each segment in the language actually spoken.';
}

/**
 * Builds the per-run instruction text sent alongside the audio. A rewrite
 * instruction turns the task into hearing the audio and answering with the
 * rewritten text; the user's instruction is quoted last and verbatim, so it
 * controls every directive about the result, while the system prompt keeps
 * the transcription rules.
 * @param options - The run's options
 * @param clipped - Whether the request names a stretch of a longer upload
 */
function buildInstruction(
	options: TranscribeOptions,
	clipped: boolean,
): string {
	const { rewrite } = options;
	const lines = [
		rewrite === undefined
			? 'Transcribe the attached audio into ordered segments.'
			: 'Transcribe the attached audio, then rewrite the transcription as the instruction below asks, and return only the rewritten text in the text field.',
		languageInstruction(options),
		options.diarize
			? 'Identify distinct speakers and label each segment (e.g. "Speaker 1", "Speaker 2"); use real names when clearly stated.'
			: 'Do not include speaker labels.',
		...(clipped ? [CLIP_INSTRUCTION] : []),
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
	if (rewrite !== undefined) {
		// Without this a model asked to rewrite silence writes something.
		lines.push(
			'When no speech is heard, return an empty text.',
			`Instruction: ${rewrite}`,
		);
	}
	return lines.join(' ');
}

/**
 * The audio part of a `generateContent` request, in the shape of the official
 * client's `Part` (`@google/genai` 3.6.1, `dist/genai.d.ts`): `inlineData` is
 * its `Blob` (`data` a base64 string, `mimeType`), `fileData` its `FileData`
 * (`fileUri`, `mimeType`), and `audioMetadata` its `AudioMetadata`, whose
 * `startOffset` and `endOffset` cut a stretch out of the audio beside it:
 *
 *     export declare interface AudioMetadata {
 *         startOffset?: string;
 *         endOffset?: string;
 *     }
 *
 * A request with offsets is billed for the stretch alone: a 726 s stretch of
 * a 1453 s upload was counted as 23 783 prompt tokens, at 32 a second.
 */
type GeminiAudioPart =
	| { inlineData: { mimeType: string; data: string } }
	| {
			fileData: { mimeType: string; fileUri: string };
			audioMetadata?: { startOffset: string; endOffset: string };
	  };

/** Google Gemini multimodal transcription provider. */
export class GeminiProvider implements TranscriptionProvider {
	readonly id = TRANSCRIPTION_PROVIDER_IDS.GEMINI;
	readonly label = EngineLabel.Gemini;
	readonly requiresNetwork = true;
	readonly capabilities: ProviderCapabilities = GEMINI_CAPABILITIES;

	/**
	 * Recordings uploaded for this run, by the bytes they were uploaded from.
	 * Every part of a recording is lent the same buffer, so the first part
	 * to arrive uploads it and the rest wait on that upload.
	 */
	private readonly uploads = new Map<ArrayBuffer, Promise<GeminiFile>>();

	constructor(private readonly config: GeminiConfig) {}

	async transcribe(
		payload: AudioPayload,
		options: TranscribeOptions,
	): Promise<WhisperResult> {
		if (payload.clip) {
			return this.transcribeClip(payload, payload.clip, options);
		}
		// Already in a container Gemini reads (see the capability's
		// originalContainers), and only read here: the same payload is sent
		// again when the service waits out a refusal.
		if (payload.data.byteLength <= GEMINI_INLINE_MAX_BYTES) {
			// One request instead of four: no upload session to open, no file
			// to poll until ACTIVE and none to delete afterwards.
			return this.generate(payload, options, {
				inlineData: {
					mimeType: payload.contentType,
					data: arrayBufferToBase64(payload.data),
				},
			});
		}
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
			return await this.generate(payload, options, {
				fileData: { mimeType: payload.contentType, fileUri: file.uri },
			});
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

	/**
	 * Deletes the recordings this run uploaded for its parts. Best effort: a
	 * file that could not be deleted expires on Google's side.
	 */
	async dispose(): Promise<void> {
		const uploads = [...this.uploads.values()];
		this.uploads.clear();
		await Promise.all(
			uploads.map(async (upload) => {
				try {
					const file = await upload;
					await deleteFile(
						this.config.baseUrl,
						this.config.apiKey,
						file.name,
					);
				} catch {
					// Nothing was uploaded, or the delete failed.
				}
			}),
		);
	}

	/**
	 * Transcribes one stretch of a recording uploaded once for the run.
	 * @param payload - The whole recording, lent to every part alike
	 * @param clip - The stretch this request is for
	 * @param options - The run's options
	 * @returns The transcript, timed from the start of the stretch
	 */
	private async transcribeClip(
		payload: AudioPayload,
		clip: AudioClip,
		options: TranscribeOptions,
	): Promise<WhisperResult> {
		const file = await this.uploaded(payload, options.signal);
		const result = await this.generate(payload, options, {
			fileData: { mimeType: payload.contentType, fileUri: file.uri },
			audioMetadata: {
				startOffset: clipOffset(clip.startSeconds),
				endOffset: clipOffset(clip.endSeconds),
			},
		});
		return { ...result, segments: rebaseToClip(result.segments, clip) };
	}

	/**
	 * The upload of a recording, started by the first part that asks for it.
	 * An upload that failed is forgotten, so the part that is sent again
	 * after a refusal uploads anew instead of meeting the same failure.
	 * @param payload - The recording
	 * @param signal - The run's cancel
	 * @returns The uploaded file, ready to be read
	 */
	private uploaded(
		payload: AudioPayload,
		signal: AbortSignal | undefined,
	): Promise<GeminiFile> {
		const known = this.uploads.get(payload.data);
		if (known) {
			return known;
		}
		const upload = this.upload(payload, signal);
		this.uploads.set(payload.data, upload);
		upload.catch(() => {
			this.uploads.delete(payload.data);
		});
		return upload;
	}

	/**
	 * Uploads a recording and waits until Gemini can read it.
	 * @param payload - The recording
	 * @param signal - The run's cancel
	 * @returns The uploaded file
	 */
	private async upload(
		payload: AudioPayload,
		signal: AbortSignal | undefined,
	): Promise<GeminiFile> {
		const file = await uploadFile(
			this.config.baseUrl,
			this.config.apiKey,
			payload.data,
			payload.contentType,
			payload.filename,
			this.config.requestTimeoutMs,
			signal,
		);
		try {
			await waitUntilActive(
				this.config.baseUrl,
				this.config.apiKey,
				file.name,
				fileProcessingWaitMs(payload.data.byteLength),
				signal,
			);
		} catch (error) {
			try {
				await deleteFile(
					this.config.baseUrl,
					this.config.apiKey,
					file.name,
				);
			} catch {
				// Ignore cleanup failures.
			}
			throw error;
		}
		return file;
	}

	/**
	 * The `generateContent` body for one audio part.
	 *
	 * Transcription is deterministic, so the request asks for as little
	 * reasoning as this model's generation allows and for the temperature
	 * that generation is tuned for. Both follow from the generation, so both
	 * are answered in one place. The output limit follows from how much audio
	 * the request covers, when that was measured.
	 * @param payload - The audio, for its length and whether it is a clip
	 * @param options - The run's options
	 * @param audio - The audio part: inline bytes or an uploaded file
	 * @returns The request body, ready to serialize
	 */
	private requestBody(
		payload: AudioPayload,
		options: TranscribeOptions,
		audio: GeminiAudioPart,
	): object {
		const maxOutputTokens = outputTokenLimit(payload.durationSeconds);
		const instruction = buildInstruction(
			options,
			payload.clip !== undefined,
		);
		return {
			contents: [{ parts: [audio, { text: instruction }] }],
			systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
			generationConfig: {
				responseMimeType: 'application/json',
				responseSchema:
					options.rewrite === undefined
						? transcriptSchema(options.languages)
						: REWRITE_SCHEMA,
				...geminiGenerationControls(
					this.config.model,
					DETERMINISTIC_TEMPERATURE,
				),
				...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
			},
		};
	}

	/**
	 * Asks `generateContent` for the structured transcript of the audio part.
	 * @param payload - The audio, for the size the timeout scales with
	 * @param options - The run's options
	 * @param audio - The audio part: inline bytes or an uploaded file
	 * @returns The mapped transcript
	 */
	private async generate(
		payload: AudioPayload,
		options: TranscribeOptions,
		audio: GeminiAudioPart,
	): Promise<WhisperResult> {
		const json = await requestJson({
			url: geminiGenerateContentUrl(
				this.config.baseUrl,
				this.config.model,
			),
			method: 'POST',
			headers: authHeader(GEMINI_API_KEY_HEADER, this.config.apiKey),
			contentType: 'application/json',
			body: JSON.stringify(this.requestBody(payload, options, audio)),
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
		return options.rewrite === undefined
			? mapGeminiResponse(json, options.diarize)
			: mapGeminiRewrite(json);
	}
}
