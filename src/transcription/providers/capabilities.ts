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
