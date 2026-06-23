/**
 * Tests that each transcription engine declares whether it can diarize, and
 * that the UI-facing lookup reflects it. Diarization must be advertised only
 * for engines that actually return speaker labels (Deepgram), so the settings
 * tab and the per-run dialog can disable the toggle for the others instead of
 * offering an option the engine would silently ignore.
 * @module tests/unit/providerCapabilities.test
 */

import {
	DEEPGRAM_CAPABILITIES,
	LOCAL_WHISPER_CAPABILITIES,
	providerSupportsDiarization,
	TRANSCRIPTION_PROVIDER_CAPABILITIES,
	WHISPER_API_CAPABILITIES,
} from 'src/transcription/providers/capabilities';

describe('transcription provider capabilities', () => {
	it('advertises diarization only for Deepgram', () => {
		expect(WHISPER_API_CAPABILITIES.supportsDiarization).toBe(false);
		expect(LOCAL_WHISPER_CAPABILITIES.supportsDiarization).toBe(false);
		expect(DEEPGRAM_CAPABILITIES.supportsDiarization).toBe(true);
	});

	it('maps every engine id to its capabilities', () => {
		expect(TRANSCRIPTION_PROVIDER_CAPABILITIES['whisper-api']).toBe(
			WHISPER_API_CAPABILITIES,
		);
		expect(TRANSCRIPTION_PROVIDER_CAPABILITIES['local-whisper']).toBe(
			LOCAL_WHISPER_CAPABILITIES,
		);
		expect(TRANSCRIPTION_PROVIDER_CAPABILITIES.deepgram).toBe(
			DEEPGRAM_CAPABILITIES,
		);
	});

	it('exposes diarization support through the UI helper', () => {
		expect(providerSupportsDiarization('whisper-api')).toBe(false);
		expect(providerSupportsDiarization('local-whisper')).toBe(false);
		expect(providerSupportsDiarization('deepgram')).toBe(true);
	});
});
