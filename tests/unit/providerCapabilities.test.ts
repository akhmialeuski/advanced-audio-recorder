/**
 * Tests that each transcription engine declares whether it can diarize, and
 * that the UI-facing lookup reflects it. Diarization must be advertised only
 * for engines that actually return speaker labels (Deepgram), so the settings
 * tab and the per-run dialog can disable the toggle for the others instead of
 * offering an option the engine would silently ignore. Also pins the engine
 * id constants as the single source for the provider ids and map keys.
 * @module tests/unit/providerCapabilities.test
 */

import { Platform } from 'obsidian';
import {
	DEEPGRAM_CAPABILITIES,
	effectiveDiarize,
	GEMINI_CAPABILITIES,
	isProviderAvailableOnPlatform,
	LOCAL_WHISPER_CAPABILITIES,
	providerSupportsDiarization,
	TRANSCRIPTION_PROVIDER_CAPABILITIES,
	WHISPER_API_CAPABILITIES,
} from 'src/transcription/providers/capabilities';
import { TRANSCRIPTION_PROVIDER_IDS } from 'src/constants';
import { TRANSCRIPTION_PROVIDER_LABELS } from 'src/settings/labels';
import { WhisperApiProvider } from 'src/transcription/providers/WhisperApiProvider';
import { DeepgramProvider } from 'src/transcription/providers/DeepgramProvider';
import { GeminiProvider } from 'src/transcription/providers/GeminiProvider';
import { LocalWhisperProvider } from 'src/transcription/providers/LocalWhisperProvider';

describe('transcription provider capabilities', () => {
	it('advertises diarization only for engines that return speaker labels', () => {
		expect(WHISPER_API_CAPABILITIES.supportsDiarization).toBe(false);
		expect(LOCAL_WHISPER_CAPABILITIES.supportsDiarization).toBe(false);
		expect(DEEPGRAM_CAPABILITIES.supportsDiarization).toBe(true);
		expect(GEMINI_CAPABILITIES.supportsDiarization).toBe(true);
	});

	it('caps only Gemini by per-request duration; others are unbounded', () => {
		// Gemini transcribes a whole file in one synchronous request, so a long
		// recording must be split; the whole-file APIs have no duration limit.
		expect(GEMINI_CAPABILITIES.maxRequestSeconds).toBe(15 * 60);
		expect(WHISPER_API_CAPABILITIES.maxRequestSeconds).toBe(
			Number.POSITIVE_INFINITY,
		);
		expect(DEEPGRAM_CAPABILITIES.maxRequestSeconds).toBe(
			Number.POSITIVE_INFINITY,
		);
		expect(LOCAL_WHISPER_CAPABILITIES.maxRequestSeconds).toBe(
			Number.POSITIVE_INFINITY,
		);
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
		expect(TRANSCRIPTION_PROVIDER_CAPABILITIES.gemini).toBe(
			GEMINI_CAPABILITIES,
		);
	});

	it('exposes diarization support through the UI helper', () => {
		expect(providerSupportsDiarization('whisper-api')).toBe(false);
		expect(providerSupportsDiarization('local-whisper')).toBe(false);
		expect(providerSupportsDiarization('deepgram')).toBe(true);
		expect(providerSupportsDiarization('gemini')).toBe(true);
	});
});

describe('effectiveDiarize', () => {
	it('requests diarization only when requested AND the engine supports it', () => {
		expect(effectiveDiarize('deepgram', true)).toBe(true);
		expect(effectiveDiarize('deepgram', false)).toBe(false);
	});

	it('ignores a requested "on" for an engine that cannot diarize', () => {
		expect(effectiveDiarize('whisper-api', true)).toBe(false);
		expect(effectiveDiarize('local-whisper', true)).toBe(false);
	});
});

describe('transcription engine id constants', () => {
	it('are the source for each provider id', () => {
		expect(
			new WhisperApiProvider({ baseUrl: '', apiKey: '', model: '' }).id,
		).toBe(TRANSCRIPTION_PROVIDER_IDS.WHISPER_API);
		expect(
			new DeepgramProvider({ baseUrl: '', apiKey: '', model: '' }).id,
		).toBe(TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM);
		expect(
			new GeminiProvider({ baseUrl: '', apiKey: '', model: '' }).id,
		).toBe(TRANSCRIPTION_PROVIDER_IDS.GEMINI);
		expect(
			new LocalWhisperProvider({
				binaryPath: '',
				modelPath: '',
				extraArgs: [],
			}).id,
		).toBe(TRANSCRIPTION_PROVIDER_IDS.LOCAL_WHISPER);
	});

	it('key the capability and label maps (no hand-typed literals drift)', () => {
		const ids = [...Object.values(TRANSCRIPTION_PROVIDER_IDS)].sort();
		expect(Object.keys(TRANSCRIPTION_PROVIDER_CAPABILITIES).sort()).toEqual(
			ids,
		);
		expect(Object.keys(TRANSCRIPTION_PROVIDER_LABELS).sort()).toEqual(ids);
	});

	describe('isProviderAvailableOnPlatform', () => {
		afterEach(() => {
			Platform.isMobile = false;
			Platform.isMobileApp = false;
		});

		it('offers every engine on desktop', () => {
			for (const id of Object.values(TRANSCRIPTION_PROVIDER_IDS)) {
				expect(isProviderAvailableOnPlatform(id)).toBe(true);
			}
		});

		it('blocks only local whisper.cpp on mobile', () => {
			// It shells out to a binary through Node, which the mobile app
			// does not provide; the cloud engines work everywhere.
			Platform.isMobile = true;
			expect(
				isProviderAvailableOnPlatform(
					TRANSCRIPTION_PROVIDER_IDS.LOCAL_WHISPER,
				),
			).toBe(false);
			expect(
				isProviderAvailableOnPlatform(
					TRANSCRIPTION_PROVIDER_IDS.WHISPER_API,
				),
			).toBe(true);
			expect(
				isProviderAvailableOnPlatform(
					TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
				),
			).toBe(true);
			expect(
				isProviderAvailableOnPlatform(
					TRANSCRIPTION_PROVIDER_IDS.GEMINI,
				),
			).toBe(true);
		});
	});
});
