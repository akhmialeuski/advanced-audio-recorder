/**
 * Tests that each transcription engine declares whether it can diarize, and
 * that the UI-facing lookup reflects it. Diarization must be advertised only
 * for engines that actually return speaker labels (Deepgram), so the settings
 * tab and the per-run dialog can disable the toggle for the others instead of
 * offering an option the engine would silently ignore. Also pins the engine
 * id constants as the single source for the provider ids and map keys.
 * @module tests/unit/providerCapabilities.test
 */

import {
	DEEPGRAM_CAPABILITIES,
	effectiveDiarize,
	effectiveDictionary,
	GEMINI_CAPABILITIES,
	isProviderAvailableOnPlatform,
	LOCAL_WHISPER_CAPABILITIES,
	effectiveWordTimestamps,
	providerSupportsDiarization,
	providerSupportsDictionary,
	providerWordTimestamps,
	wordTimestampsNote,
	wordTimestampsSelectable,
	TRANSCRIPTION_PROVIDER_CAPABILITIES,
	WHISPER_API_CAPABILITIES,
} from 'src/transcription/providers/capabilities';
import { TRANSCRIPTION_PROVIDER_IDS } from 'src/constants';
import { TRANSCRIPTION_PROVIDER_LABELS } from 'src/settings/labels';
import { WhisperApiProvider } from 'src/transcription/providers/WhisperApiProvider';
import { DeepgramProvider } from 'src/transcription/providers/DeepgramProvider';
import { GeminiProvider } from 'src/transcription/providers/GeminiProvider';
import { LocalWhisperProvider } from 'src/transcription/providers/LocalWhisperProvider';
import { setPlatform, useDesktopPlatform } from '../helpers/platform';

describe('transcription provider capabilities', () => {
	it('advertises diarization only for engines that return speaker labels', () => {
		expect(WHISPER_API_CAPABILITIES.supportsDiarization).toBe(false);
		expect(LOCAL_WHISPER_CAPABILITIES.supportsDiarization).toBe(false);
		expect(DEEPGRAM_CAPABILITIES.supportsDiarization).toBe(true);
		expect(GEMINI_CAPABILITIES.supportsDiarization).toBe(true);
	});

	// Three answers, one per behaviour actually observed: Whisper API adds the
	// `word` granularity when asked, Deepgram's mapping keeps the words of
	// every response whether asked or not, and the other two return segment
	// offsets and nothing finer.
	it('records what each engine does with a request for per-word timing', () => {
		expect(WHISPER_API_CAPABILITIES.wordTimestamps).toBe('requested');
		expect(DEEPGRAM_CAPABILITIES.wordTimestamps).toBe('always');
		expect(GEMINI_CAPABILITIES.wordTimestamps).toBe('none');
		expect(LOCAL_WHISPER_CAPABILITIES.wordTimestamps).toBe('none');
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

	it('advertises dictionary biasing for every current engine', () => {
		// All four engines accept a bias hint (Deepgram keyterm/keywords,
		// Whisper prompt, Gemini instruction text), so the field is offered
		// for each; the gate exists for a future engine that cannot bias.
		expect(WHISPER_API_CAPABILITIES.supportsDictionary).toBe(true);
		expect(LOCAL_WHISPER_CAPABILITIES.supportsDictionary).toBe(true);
		expect(DEEPGRAM_CAPABILITIES.supportsDictionary).toBe(true);
		expect(GEMINI_CAPABILITIES.supportsDictionary).toBe(true);
	});

	it('exposes dictionary support through the UI helper', () => {
		expect(providerSupportsDictionary('whisper-api')).toBe(true);
		expect(providerSupportsDictionary('local-whisper')).toBe(true);
		expect(providerSupportsDictionary('deepgram')).toBe(true);
		expect(providerSupportsDictionary('gemini')).toBe(true);
	});
});

describe('effectiveDictionary', () => {
	it('passes the terms through for an engine that can bias', () => {
		expect(effectiveDictionary('deepgram', ['Kubernetes', 'gRPC'])).toEqual(
			['Kubernetes', 'gRPC'],
		);
	});

	it('returns an empty list for an empty dictionary', () => {
		expect(effectiveDictionary('whisper-api', [])).toEqual([]);
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

describe('per-word timing gates', () => {
	it('lets the user choose only on the engine that reads the request', () => {
		expect(wordTimestampsSelectable('whisper-api')).toBe(true);
		expect(wordTimestampsSelectable('deepgram')).toBe(false);
		expect(wordTimestampsSelectable('gemini')).toBe(false);
		expect(wordTimestampsSelectable('local-whisper')).toBe(false);
	});

	it('honours the request on the engine that reads it', () => {
		expect(effectiveWordTimestamps('whisper-api', true)).toBe(true);
		expect(effectiveWordTimestamps('whisper-api', false)).toBe(false);
	});

	// The stored value is left alone on the way past, so switching back to an
	// engine that reads it finds the user's own choice still there.
	it('drops a stored "on" for an engine that never returns words', () => {
		expect(effectiveWordTimestamps('gemini', true)).toBe(false);
		expect(effectiveWordTimestamps('local-whisper', true)).toBe(false);
	});

	it('reports words for an engine that returns them regardless', () => {
		expect(effectiveWordTimestamps('deepgram', false)).toBe(true);
	});

	it('explains each engine in its own terms', () => {
		expect(wordTimestampsNote('whisper-api')).toMatch(/Request per-word/);
		expect(wordTimestampsNote('deepgram')).toMatch(/on every run/);
		expect(wordTimestampsNote('gemini')).toMatch(/segment-level/);
	});

	it('answers the same question through the table and the accessor', () => {
		expect(providerWordTimestamps('deepgram')).toBe(
			DEEPGRAM_CAPABILITIES.wordTimestamps,
		);
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
			useDesktopPlatform();
		});

		it('offers every engine on desktop', () => {
			for (const id of Object.values(TRANSCRIPTION_PROVIDER_IDS)) {
				expect(isProviderAvailableOnPlatform(id)).toBe(true);
			}
		});

		it('blocks only local whisper.cpp on mobile', () => {
			// It shells out to a binary through Node, which the mobile app
			// does not provide; the cloud engines work everywhere.
			setPlatform({ isMobile: true });
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
