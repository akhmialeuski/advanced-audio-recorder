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
			return 'This engine returns segment-level timing only, so per-word timing is not available for it.';
	}
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
