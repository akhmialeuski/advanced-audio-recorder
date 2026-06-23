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
	acceptsOriginalContainer: true,
	diarizesWholeFile: false,
	supportsDiarization: false,
};

/** Deepgram pre-recorded API: diarizes a whole request with stable labels. */
export const DEEPGRAM_CAPABILITIES: ProviderCapabilities = {
	maxRequestBytes: DEEPGRAM_MAX_REQUEST_BYTES,
	acceptsOriginalContainer: true,
	diarizesWholeFile: true,
	supportsDiarization: true,
};

/** Local whisper.cpp: no upload limit, needs decoded WAV, no diarization. */
export const LOCAL_WHISPER_CAPABILITIES: ProviderCapabilities = {
	maxRequestBytes: Number.POSITIVE_INFINITY,
	acceptsOriginalContainer: false,
	diarizesWholeFile: false,
	supportsDiarization: false,
};

/** Capabilities for every engine, keyed by its settings id. */
export const TRANSCRIPTION_PROVIDER_CAPABILITIES: Record<
	TranscriptionProviderId,
	ProviderCapabilities
> = {
	[TRANSCRIPTION_PROVIDER_IDS.WHISPER_API]: WHISPER_API_CAPABILITIES,
	[TRANSCRIPTION_PROVIDER_IDS.LOCAL_WHISPER]: LOCAL_WHISPER_CAPABILITIES,
	[TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM]: DEEPGRAM_CAPABILITIES,
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
