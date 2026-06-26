/**
 * Static, config-independent capability descriptors for each transcription
 * engine, plus a lookup by engine id. Kept separate from the provider classes
 * so the UI can decide which options to offer (notably speaker diarization)
 * without constructing a provider — construction validates and requires API
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
import type { TranscriptionProviderId } from '../../settings/Settings';
import type { ProviderCapabilities } from './TranscriptionProvider';

/**
 * OpenAI-compatible Whisper API. OpenAI's `whisper-1` does not return speaker
 * labels, so diarization is not offered for this engine.
 */
export const WHISPER_API_CAPABILITIES: ProviderCapabilities = {
	maxRequestBytes: WHISPER_API_MAX_REQUEST_BYTES,
	maxRequestSeconds: Number.POSITIVE_INFINITY,
	acceptsOriginalContainer: true,
	diarizesWholeFile: false,
	supportsDiarization: false,
};

/** Deepgram pre-recorded API: diarizes a whole request with stable labels. */
export const DEEPGRAM_CAPABILITIES: ProviderCapabilities = {
	maxRequestBytes: DEEPGRAM_MAX_REQUEST_BYTES,
	maxRequestSeconds: Number.POSITIVE_INFINITY,
	acceptsOriginalContainer: true,
	diarizesWholeFile: true,
	supportsDiarization: true,
};

/** Local whisper.cpp: no upload limit, needs decoded WAV, no diarization. */
export const LOCAL_WHISPER_CAPABILITIES: ProviderCapabilities = {
	maxRequestBytes: Number.POSITIVE_INFINITY,
	maxRequestSeconds: Number.POSITIVE_INFINITY,
	acceptsOriginalContainer: false,
	diarizesWholeFile: false,
	supportsDiarization: false,
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
	diarizesWholeFile: true,
	supportsDiarization: true,
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
 * tab, the per-run dialog, and the service never diverge — a stored "on" left
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
