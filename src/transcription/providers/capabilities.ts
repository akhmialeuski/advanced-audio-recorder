/**
 * Static, config-independent capability descriptors for each transcription
 * engine, plus a lookup by engine id. Kept separate from the provider classes
 * so the UI can decide which options to offer (notably speaker diarization)
 * without constructing a provider - construction validates and requires API
 * keys the per-run dialog may not have yet. The provider classes reference
 * these same constants, so capabilities stay a single source of truth.
 * @module transcription/providers/capabilities
 */

import {
	DEEPGRAM_MAX_REQUEST_BYTES,
	GEMINI_MAX_REQUEST_BYTES,
	GEMINI_MAX_WHOLE_FILE_SECONDS,
	TRANSCRIPTION_PROVIDER_IDS,
	VOXTRAL_MAX_REQUEST_BYTES,
	WHISPER_API_MAX_REQUEST_BYTES,
} from '../../constants';
import { isLocalTranscriptionSupported } from '../../platform/capabilities';
import type { TranscriptionProviderId } from '../../settings/settingsSchema';
import type {
	AdvancedBiasChannel,
	ProviderCapabilities,
	WordTimestampSupport,
} from './TranscriptionProvider';

/**
 * OpenAI-compatible Whisper API. OpenAI's `whisper-1` does not return speaker
 * labels, so diarization is not offered for this engine.
 */
export const WHISPER_API_CAPABILITIES: ProviderCapabilities = {
	maxRequestBytes: WHISPER_API_MAX_REQUEST_BYTES,
	maxRequestSeconds: Number.POSITIVE_INFINITY,
	acceptsOriginalContainer: true,
	supportsDiarization: false,
	// OpenAI Whisper accepts a `prompt` that seeds recognition with spellings.
	supportsDictionary: true,
	// The one engine that reads the request: it adds the `word` granularity.
	wordTimestamps: 'requested',
	biasChannel: 'prompt',
	// The endpoint has an /audio/translations operation taking the same
	// fields as transcription and answering in the same shape.
	supportsSpeechTranslation: true,
	readsLanguageHint: true,
};

/** Deepgram pre-recorded API: diarizes a whole request with stable labels. */
export const DEEPGRAM_CAPABILITIES: ProviderCapabilities = {
	maxRequestBytes: DEEPGRAM_MAX_REQUEST_BYTES,
	maxRequestSeconds: Number.POSITIVE_INFINITY,
	acceptsOriginalContainer: true,
	supportsDiarization: true,
	// Deepgram biases via keyterm (nova-3) or keywords (nova-2 and older).
	supportsDictionary: true,
	// Every Deepgram response carries its words, asked for or not, and the
	// mapping keeps them; there is nothing to request and nothing to turn off.
	wordTimestamps: 'always',
	biasChannel: 'keyterm',
	supportsSpeechTranslation: false,
	readsLanguageHint: true,
};

/** Local whisper.cpp: no upload limit, needs decoded WAV, no diarization. */
export const LOCAL_WHISPER_CAPABILITIES: ProviderCapabilities = {
	maxRequestBytes: Number.POSITIVE_INFINITY,
	maxRequestSeconds: Number.POSITIVE_INFINITY,
	acceptsOriginalContainer: false,
	supportsDiarization: false,
	// whisper.cpp accepts an initial prompt via the --prompt CLI flag.
	supportsDictionary: true,
	// The -oj output carries segment offsets and nothing finer.
	wordTimestamps: 'none',
	biasChannel: 'prompt',
	supportsSpeechTranslation: false,
	readsLanguageHint: true,
};

/**
 * Google Gemini: a multimodal model that transcribes a whole file uploaded via
 * the File API in one request, so it diarizes with stable speaker numbering.
 * Accepts the original container (unsupported formats are decoded to WAV inside
 * the provider). Bounded by a per-request duration cap: a recording longer than
 * {@link GEMINI_MAX_WHOLE_FILE_SECONDS} is split into parts so one request never
 * outlasts the timeout or truncates the output, at the cost of speaker numbering
 * resetting between parts (surfaced to the user as a warning).
 */
export const GEMINI_CAPABILITIES: ProviderCapabilities = {
	maxRequestBytes: GEMINI_MAX_REQUEST_BYTES,
	maxRequestSeconds: GEMINI_MAX_WHOLE_FILE_SECONDS,
	acceptsOriginalContainer: true,
	supportsDiarization: true,
	// Gemini biases via the instruction text sent alongside the audio.
	supportsDictionary: true,
	// The transcript comes back as timed segments; the model is not asked for,
	// and does not return, a timing per word.
	wordTimestamps: 'none',
	biasChannel: 'prompt',
	supportsSpeechTranslation: false,
	readsLanguageHint: true,
};

/**
 * Mistral Voxtral Mini Transcribe 2: one request carries about three hours of
 * audio, so a recording is sent whole and speaker numbering stays consistent.
 *
 * The duration cap is deliberately left unbounded. The cheap proof in
 * `audioPrep` reads bytes rather than seconds, so a three-hour cap would only
 * clear files under about 10.8 MB and would decode every longer recording into
 * a 16 kHz mono WAV several times its size - which is exactly the whole-file
 * upload this engine is chosen for. The byte ceiling still bounds the request,
 * and a recording past three hours is refused by the endpoint in Mistral's own
 * words rather than by a guess made here.
 */
export const VOXTRAL_CAPABILITIES: ProviderCapabilities = {
	maxRequestBytes: VOXTRAL_MAX_REQUEST_BYTES,
	maxRequestSeconds: Number.POSITIVE_INFINITY,
	acceptsOriginalContainer: true,
	supportsDiarization: true,
	// Voxtral biases through context_bias, a flat list of terms bounded by an
	// entry count, which is the keyterm shape rather than the prompt one.
	supportsDictionary: true,
	// The request takes a `word` granularity, but nothing in the answer carries
	// words. Both of Mistral's generated clients model a batch transcription as
	// {model, text, usage, language, segments} and a segment as
	// {text, start, end, score, speaker_id} with `type` fixed to the constant
	// "transcription_segment", so there is no per-word field for mapWhisperResponse
	// to read and no second chunk type words could arrive as. Offering the switch
	// would promise timing this engine has no way to return, so it is declined
	// here until a live run shows a per-word field to map.
	wordTimestamps: 'none',
	biasChannel: 'keyterm',
	// There is no translations operation, so English-only output cannot be
	// asked for.
	supportsSpeechTranslation: false,
	// timestamp_granularities is documented as incompatible with language, and
	// the granularity is always sent, so the engine detects the language itself.
	readsLanguageHint: false,
};

/** Capabilities for every engine, keyed by its settings id. */
export const TRANSCRIPTION_PROVIDER_CAPABILITIES: Record<
	TranscriptionProviderId,
	ProviderCapabilities
> = {
	[TRANSCRIPTION_PROVIDER_IDS.WHISPER_API]: WHISPER_API_CAPABILITIES,
	[TRANSCRIPTION_PROVIDER_IDS.LOCAL_WHISPER]: LOCAL_WHISPER_CAPABILITIES,
	[TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM]: DEEPGRAM_CAPABILITIES,
	[TRANSCRIPTION_PROVIDER_IDS.GEMINI]: GEMINI_CAPABILITIES,
	[TRANSCRIPTION_PROVIDER_IDS.VOXTRAL]: VOXTRAL_CAPABILITIES,
};

/**
 * Whether the engine produces speaker labels. The UI uses this to enable or
 * disable the diarization toggle for the selected engine.
 * @param id - Selected transcription engine id
 * @returns True when the engine can diarize
 */
export function providerSupportsDiarization(
	id: TranscriptionProviderId,
): boolean {
	return TRANSCRIPTION_PROVIDER_CAPABILITIES[id].supportsDiarization;
}

/**
 * The diarization actually requested for a run: the user's preference AND the
 * engine's capability. The single place this AND-gate lives, so the settings
 * tab, the per-run dialog, and the service never diverge - a stored "on" left
 * from a diarizing engine is ignored for an engine that cannot diarize.
 * @param id - Selected transcription engine id
 * @param requested - The user's diarization preference
 * @returns Whether speaker labels should be requested
 */
export function effectiveDiarize(
	id: TranscriptionProviderId,
	requested: boolean,
): boolean {
	return requested && providerSupportsDiarization(id);
}

/**
 * Whether the engine has an operation that translates speech into English
 * while transcribing it.
 * @param id - Selected transcription engine id
 * @returns Whether the engine can be asked to translate the speech
 */
export function providerSupportsSpeechTranslation(
	id: TranscriptionProviderId,
): boolean {
	return TRANSCRIPTION_PROVIDER_CAPABILITIES[id].supportsSpeechTranslation;
}

/**
 * The speech translation actually requested for a run: the user's preference
 * AND the engine's capability, gated in one place exactly as
 * {@link effectiveDiarize} is, so a stored "on" left from Whisper stops
 * travelling the moment another engine is chosen.
 * @param id - Selected transcription engine id
 * @param requested - The user's speech-translation preference
 * @returns Whether the translating operation should be used
 */
export function effectiveSpeechTranslation(
	id: TranscriptionProviderId,
	requested: boolean,
): boolean {
	return requested && providerSupportsSpeechTranslation(id);
}

/**
 * What the engine does with a request for per-word timing.
 * @param id - Selected transcription engine id
 * @returns The engine's answer to the request
 */
export function providerWordTimestamps(
	id: TranscriptionProviderId,
): WordTimestampSupport {
	return TRANSCRIPTION_PROVIDER_CAPABILITIES[id].wordTimestamps;
}

/**
 * Whether the user's choice makes any difference on this engine. False both
 * for an engine that returns per-word timing regardless and for one that never
 * returns it: in either case the switch is offered disabled, because the
 * outcome is the engine's to decide and not the user's.
 * @param id - Selected transcription engine id
 * @returns True when the switch actually steers the request
 */
export function wordTimestampsSelectable(id: TranscriptionProviderId): boolean {
	return providerWordTimestamps(id) === 'requested';
}

/**
 * Whether this run's output will carry per-word timing: the user's preference
 * where the engine reads it, the engine's own answer where it does not. The
 * single place that AND-gate lives, so the settings tab, the per-run dialog,
 * and the request the service builds cannot disagree - and a stored "on" left
 * from Whisper API never reaches an engine that would drop it.
 * @param id - Selected transcription engine id
 * @param requested - The user's word-timestamp preference
 * @returns Whether the transcript will carry per-word timing
 */
export function effectiveWordTimestamps(
	id: TranscriptionProviderId,
	requested: boolean,
): boolean {
	const support = providerWordTimestamps(id);
	return support === 'always' || (support === 'requested' && requested);
}

/**
 * What to tell the user about per-word timing on this engine. Kept beside the
 * capability rather than at each surface, so the settings tab and the per-run
 * dialog cannot describe the same engine differently.
 * @param id - Selected transcription engine id
 * @returns The sentence for the switch's description
 */
export function wordTimestampsNote(id: TranscriptionProviderId): string {
	switch (providerWordTimestamps(id)) {
		case 'requested':
			return 'Request per-word timing. Recorded in JSON file output only.';
		case 'always':
			return 'This engine returns per-word timing on every run, so there is nothing to turn on. Recorded in JSON file output only.';
		default:
			return 'This engine returns segment-level timing only, so the JSON file output carries segment times and no words.';
	}
}

/**
 * Whether the engine reads the configured language hint at all.
 * @param id - Selected transcription engine id
 * @returns True when a language code reaches the request
 */
export function providerReadsLanguageHint(
	id: TranscriptionProviderId,
): boolean {
	return TRANSCRIPTION_PROVIDER_CAPABILITIES[id].readsLanguageHint;
}

/**
 * The language field's own rule, wherever that field is read: an empty value
 * and "auto" both mean "let the service decide", so both resolve to no hint.
 *
 * The comparison is case-insensitive because the field's validator is: its
 * pattern carries the `i` flag, so `Auto` and `AUTO` are accepted and stored
 * exactly as typed. Matching only the lowercase spelling passed `Auto` on as
 * though it were an ISO code, which no service resolves.
 *
 * Shared with auto-chapter generation, which needs the same answer about the
 * same field for a different reason - it names the language to the LLM rather
 * than to a transcription engine - so the rule lives once here instead of in
 * a copy per reader that can drift out of step.
 * @param language - The configured language code, as the field stores it
 * @returns The code, or undefined when the field asks for detection
 */
export function configuredLanguageHint(language: string): string | undefined {
	const trimmed = language.trim();
	return trimmed && trimmed.toLowerCase() !== 'auto' ? trimmed : undefined;
}

/**
 * The language hint actually sent for a run: the user's code AND the engine's
 * capability, gated in one place exactly as {@link effectiveDiarize} is. A code
 * stored while a hint-reading engine was selected stops travelling the moment
 * an engine that detects the language itself is chosen, so the request the
 * service builds and the note the row shows cannot disagree.
 * @param id - Selected transcription engine id
 * @param language - The configured language code
 * @returns The code to send, or undefined when none should be
 */
export function effectiveLanguage(
	id: TranscriptionProviderId,
	language: string,
): string | undefined {
	return providerReadsLanguageHint(id)
		? configuredLanguageHint(language)
		: undefined;
}

/**
 * What to tell the user about the language hint on this engine. Kept beside the
 * capability rather than at each surface, so the settings tab and the per-run
 * dialog cannot describe the same engine differently.
 * @param id - Selected transcription engine id
 * @returns The sentence for the language row's description
 */
export function languageNote(id: TranscriptionProviderId): string {
	return providerReadsLanguageHint(id)
		? 'ISO code (e.g. en, ru, es). Leave empty, or write "auto", to detect it.'
		: 'This engine detects the spoken language itself and does not read this field, because it cannot be asked for timed segments and a language at the same time.';
}

/**
 * The representation of generated biasing context this engine reads. The
 * single source of truth shared by the context pipeline (which builds only
 * what the channel needs) and the second pass's bias routing.
 * @param id - Selected transcription engine id
 * @returns The channel the engine biases through
 */
export function providerBiasChannel(
	id: TranscriptionProviderId,
): AdvancedBiasChannel {
	return TRANSCRIPTION_PROVIDER_CAPABILITIES[id].biasChannel;
}

/**
 * Whether the engine can bias recognition toward a custom dictionary. The UI
 * uses this to enable or disable the dictionary field for the selected engine.
 * @param id - Selected transcription engine id
 * @returns True when the engine accepts biasing terms
 */
export function providerSupportsDictionary(
	id: TranscriptionProviderId,
): boolean {
	return TRANSCRIPTION_PROVIDER_CAPABILITIES[id].supportsDictionary;
}

/**
 * The provider-level dictionary gate: the user's terms AND the engine's
 * capability. Terms stored while a biasing engine was selected are dropped for
 * an engine that cannot bias at all, instead of being sent and silently
 * ignored. This is only the coarse per-engine gate; the per-model Deepgram
 * rules and the provider request limits live in {@link planDictionaryBias},
 * which calls this first. The service runs every dictionary through that plan,
 * so the terms it sends and the terms it warns about never diverge.
 * @param id - Selected transcription engine id
 * @param terms - The user's parsed dictionary terms
 * @returns The terms to send, empty when the engine cannot bias
 */
export function effectiveDictionary(
	id: TranscriptionProviderId,
	terms: string[],
): string[] {
	return providerSupportsDictionary(id) ? terms : [];
}

/**
 * Whether the engine can run at all on this platform. Cloud engines work
 * everywhere; local whisper.cpp shells out to a binary through Node,
 * which only the desktop app provides. The UI uses this to block the
 * engine option (and its configuration) on platforms that cannot run it,
 * without knowing which platform it is on.
 * @param id - Transcription engine id
 * @returns True when the engine is usable on this platform
 */
export function isProviderAvailableOnPlatform(
	id: TranscriptionProviderId,
): boolean {
	if (id === TRANSCRIPTION_PROVIDER_IDS.LOCAL_WHISPER) {
		return isLocalTranscriptionSupported();
	}
	return true;
}
