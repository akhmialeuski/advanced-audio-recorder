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
	VOXTRAL_CAPABILITIES,
	effectiveLanguage,
	languageNote,
	providerReadsLanguageHint,
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
		expect(VOXTRAL_CAPABILITIES.supportsDiarization).toBe(true);
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
		// Voxtral's request takes a `word` granularity, but its answer models
		// no per-word shape - a segment is {text, start, end, score,
		// speaker_id} and there is no second chunk type - so the switch is not
		// offered rather than promising timing the mapper cannot read.
		expect(VOXTRAL_CAPABILITIES.wordTimestamps).toBe('none');
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
		// Voxtral takes about three hours per request, but the cheap
		// whole-file proof reads bytes rather than seconds, so a cap here
		// would decode every recording past roughly ten megabytes instead of
		// uploading the container it already accepts.
		expect(VOXTRAL_CAPABILITIES.maxRequestSeconds).toBe(
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
		expect(TRANSCRIPTION_PROVIDER_CAPABILITIES.voxtral).toBe(
			VOXTRAL_CAPABILITIES,
		);
	});

	it('exposes diarization support through the UI helper', () => {
		expect(providerSupportsDiarization('whisper-api')).toBe(false);
		expect(providerSupportsDiarization('local-whisper')).toBe(false);
		expect(providerSupportsDiarization('deepgram')).toBe(true);
		expect(providerSupportsDiarization('gemini')).toBe(true);
		expect(providerSupportsDiarization('voxtral')).toBe(true);
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

	// Where the timing lands is what makes the option intelligible at all, and
	// a user who has only ever seen the row disabled has never been told it.
	// The note that dropped the JSON clause was the note on the two engines
	// where the row is always disabled.
	it.each(Object.values(TRANSCRIPTION_PROVIDER_IDS))(
		'says where the timing is recorded on %s',
		(id) => {
			expect(wordTimestampsNote(id)).toMatch(/JSON/);
		},
	);

	it('answers the same question through the table and the accessor', () => {
		expect(providerWordTimestamps('deepgram')).toBe(
			DEEPGRAM_CAPABILITIES.wordTimestamps,
		);
	});
});

describe('the language hint gate', () => {
	it('records which engines read a language hint at all', () => {
		// Voxtral is the one that does not: Mistral documents `language` as
		// incompatible with `timestamp_granularities`, and the granularity is
		// what makes the response carry segments, so the hint gives way.
		expect(providerReadsLanguageHint('whisper-api')).toBe(true);
		expect(providerReadsLanguageHint('deepgram')).toBe(true);
		expect(providerReadsLanguageHint('gemini')).toBe(true);
		expect(providerReadsLanguageHint('local-whisper')).toBe(true);
		expect(providerReadsLanguageHint('voxtral')).toBe(false);
	});

	it.each([
		{
			name: 'passes a configured code to an engine that reads it',
			id: TRANSCRIPTION_PROVIDER_IDS.WHISPER_API,
			language: 'ru',
			expected: 'ru',
		},
		{
			name: 'reads an empty field as no hint',
			id: TRANSCRIPTION_PROVIDER_IDS.WHISPER_API,
			language: '   ',
			expected: undefined,
		},
		{
			name: 'reads "auto" as no hint',
			id: TRANSCRIPTION_PROVIDER_IDS.WHISPER_API,
			language: 'auto',
			expected: undefined,
		},
		{
			// The field's validator carries the `i` flag, so "Auto" is accepted
			// and stored exactly as typed; matching only the lowercase spelling
			// sent it on to the endpoint as though it were an ISO code.
			name: 'reads "Auto" as no hint, the way its validator accepts it',
			id: TRANSCRIPTION_PROVIDER_IDS.WHISPER_API,
			language: 'Auto',
			expected: undefined,
		},
		{
			name: 'drops a code stored while another engine was selected',
			id: TRANSCRIPTION_PROVIDER_IDS.VOXTRAL,
			language: 'ru',
			expected: undefined,
		},
	])('$name', ({ id, language, expected }) => {
		expect(effectiveLanguage(id, language)).toBe(expected);
	});

	it('names the engine behaviour in the note the row shows', () => {
		expect(languageNote('whisper-api')).toMatch(/ISO code/);
		expect(languageNote('voxtral')).toMatch(/detects the spoken language/);
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
				processTimeoutMs: 60_000,
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
