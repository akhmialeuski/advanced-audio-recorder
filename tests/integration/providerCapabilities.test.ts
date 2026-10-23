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
	configuredLanguageHint,
	configuredLanguages,
	effectiveLanguage,
	effectiveLanguages,
	languageNote,
	providerReadsLanguageHint,
	providerReadsLanguageList,
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
import {
	DurationCapCheck,
	type ProviderCapabilities,
} from 'src/transcription/providers/TranscriptionProvider';
import { audioContainerFromExtension } from 'src/transcription/audioPrep';
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
	// every response whether asked or not, and the other three answer with
	// segment offsets and nothing finer.
	it('records what each engine does with a request for per-word timing', () => {
		expect(WHISPER_API_CAPABILITIES.wordTimestamps).toBe('requested');
		expect(DEEPGRAM_CAPABILITIES.wordTimestamps).toBe('always');
		expect(GEMINI_CAPABILITIES.wordTimestamps).toBe('none');
		expect(LOCAL_WHISPER_CAPABILITIES.wordTimestamps).toBe('none');
		// Voxtral's enum takes `word`, but the engine has no shape carrying
		// words and sentences at once: asking for both is refused, and asking
		// for words alone answers in the same `segments` array with one segment
		// per word, which would cost the transcript its sentences.
		expect(VOXTRAL_CAPABILITIES.wordTimestamps).toBe('none');
	});

	it('caps Gemini and Voxtral by per-request duration; others are unbounded', () => {
		// Gemini transcribes a whole file in one synchronous request, so a long
		// recording must be split; Voxtral's endpoint takes three hours per
		// request; the other whole-file APIs have no duration limit.
		expect(GEMINI_CAPABILITIES.maxRequestSeconds).toBe(15 * 60);
		expect(VOXTRAL_CAPABILITIES.maxRequestSeconds).toBe(3 * 60 * 60);
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

	// The two caps mean different things. Gemini's is how much one request
	// answers reliably, so a file that cannot prove itself short is measured.
	// Voxtral's is the endpoint's own and three hours long, and proving it
	// through the byte size would decode every recording past roughly ten
	// megabytes instead of uploading the container the endpoint reads.
	it("proves Gemini's cap before a whole-file upload and leaves Voxtral's to the endpoint", () => {
		expect(GEMINI_CAPABILITIES.durationCapCheck).toBe(
			DurationCapCheck.ProvenByBytes,
		);
		expect(VOXTRAL_CAPABILITIES.durationCapCheck).toBe(
			DurationCapCheck.LeftToEndpoint,
		);
	});

	it('maps every engine id to its capabilities', () => {
		expect(
			TRANSCRIPTION_PROVIDER_CAPABILITIES[
				TRANSCRIPTION_PROVIDER_IDS.WHISPER_API
			],
		).toBe(WHISPER_API_CAPABILITIES);
		expect(
			TRANSCRIPTION_PROVIDER_CAPABILITIES[
				TRANSCRIPTION_PROVIDER_IDS.LOCAL_WHISPER
			],
		).toBe(LOCAL_WHISPER_CAPABILITIES);
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
		expect(
			providerSupportsDiarization(TRANSCRIPTION_PROVIDER_IDS.WHISPER_API),
		).toBe(false);
		expect(
			providerSupportsDiarization(
				TRANSCRIPTION_PROVIDER_IDS.LOCAL_WHISPER,
			),
		).toBe(false);
		expect(
			providerSupportsDiarization(TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM),
		).toBe(true);
		expect(
			providerSupportsDiarization(TRANSCRIPTION_PROVIDER_IDS.GEMINI),
		).toBe(true);
		expect(
			providerSupportsDiarization(TRANSCRIPTION_PROVIDER_IDS.VOXTRAL),
		).toBe(true);
	});

	it('advertises dictionary biasing for every current engine', () => {
		// Every engine accepts a bias hint (Deepgram keyterm/keywords, Voxtral
		// context_bias, Whisper prompt, Gemini instruction text), so the field
		// is offered for each; the gate exists for a future engine that cannot
		// bias.
		expect(WHISPER_API_CAPABILITIES.supportsDictionary).toBe(true);
		expect(LOCAL_WHISPER_CAPABILITIES.supportsDictionary).toBe(true);
		expect(DEEPGRAM_CAPABILITIES.supportsDictionary).toBe(true);
		expect(GEMINI_CAPABILITIES.supportsDictionary).toBe(true);
		expect(VOXTRAL_CAPABILITIES.supportsDictionary).toBe(true);
	});

	it('exposes dictionary support through the UI helper', () => {
		expect(
			providerSupportsDictionary(TRANSCRIPTION_PROVIDER_IDS.WHISPER_API),
		).toBe(true);
		expect(
			providerSupportsDictionary(
				TRANSCRIPTION_PROVIDER_IDS.LOCAL_WHISPER,
			),
		).toBe(true);
		expect(
			providerSupportsDictionary(TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM),
		).toBe(true);
		expect(
			providerSupportsDictionary(TRANSCRIPTION_PROVIDER_IDS.GEMINI),
		).toBe(true);
		expect(
			providerSupportsDictionary(TRANSCRIPTION_PROVIDER_IDS.VOXTRAL),
		).toBe(true);
	});

	it('records the channel each engine carries a generated bias through', () => {
		// The two-pass mode builds only the representation the channel needs
		// and routes on this value alone, so an engine that takes discrete
		// terms must say so or it is handed a prompt sentence it cannot use.
		expect(DEEPGRAM_CAPABILITIES.biasChannel).toBe('keyterm');
		expect(VOXTRAL_CAPABILITIES.biasChannel).toBe('keyterm');
		expect(WHISPER_API_CAPABILITIES.biasChannel).toBe('prompt');
		expect(LOCAL_WHISPER_CAPABILITIES.biasChannel).toBe('prompt');
		expect(GEMINI_CAPABILITIES.biasChannel).toBe('prompt');
	});
});

describe('effectiveDictionary', () => {
	it('passes the terms through for an engine that can bias', () => {
		expect(
			effectiveDictionary(TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM, [
				'Kubernetes',
				'gRPC',
			]),
		).toEqual(['Kubernetes', 'gRPC']);
	});

	it('returns an empty list for an empty dictionary', () => {
		expect(
			effectiveDictionary(TRANSCRIPTION_PROVIDER_IDS.WHISPER_API, []),
		).toEqual([]);
	});
});

describe('effectiveDiarize', () => {
	it('requests diarization only when requested AND the engine supports it', () => {
		expect(
			effectiveDiarize(TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM, true),
		).toBe(true);
		expect(
			effectiveDiarize(TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM, false),
		).toBe(false);
	});

	it('ignores a requested "on" for an engine that cannot diarize', () => {
		expect(
			effectiveDiarize(TRANSCRIPTION_PROVIDER_IDS.WHISPER_API, true),
		).toBe(false);
		expect(
			effectiveDiarize(TRANSCRIPTION_PROVIDER_IDS.LOCAL_WHISPER, true),
		).toBe(false);
	});
});

describe('per-word timing gates', () => {
	it('lets the user choose only on the engine that reads the request', () => {
		expect(
			wordTimestampsSelectable(TRANSCRIPTION_PROVIDER_IDS.WHISPER_API),
		).toBe(true);
		expect(
			wordTimestampsSelectable(TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM),
		).toBe(false);
		expect(
			wordTimestampsSelectable(TRANSCRIPTION_PROVIDER_IDS.GEMINI),
		).toBe(false);
		expect(
			wordTimestampsSelectable(TRANSCRIPTION_PROVIDER_IDS.LOCAL_WHISPER),
		).toBe(false);
	});

	it('honours the request on the engine that reads it', () => {
		expect(
			effectiveWordTimestamps(
				TRANSCRIPTION_PROVIDER_IDS.WHISPER_API,
				true,
			),
		).toBe(true);
		expect(
			effectiveWordTimestamps(
				TRANSCRIPTION_PROVIDER_IDS.WHISPER_API,
				false,
			),
		).toBe(false);
	});

	// The stored value is left alone on the way past, so switching back to an
	// engine that reads it finds the user's own choice still there.
	it('drops a stored "on" for an engine that never returns words', () => {
		expect(
			effectiveWordTimestamps(TRANSCRIPTION_PROVIDER_IDS.GEMINI, true),
		).toBe(false);
		expect(
			effectiveWordTimestamps(
				TRANSCRIPTION_PROVIDER_IDS.LOCAL_WHISPER,
				true,
			),
		).toBe(false);
	});

	it('reports words for an engine that returns them regardless', () => {
		expect(
			effectiveWordTimestamps(TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM, false),
		).toBe(true);
	});

	it('explains each engine in its own terms', () => {
		expect(
			wordTimestampsNote(TRANSCRIPTION_PROVIDER_IDS.WHISPER_API),
		).toMatch(/Request per-word/);
		expect(wordTimestampsNote(TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM)).toMatch(
			/on every run/,
		);
		expect(wordTimestampsNote(TRANSCRIPTION_PROVIDER_IDS.GEMINI)).toMatch(
			/segment-level/,
		);
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
		expect(
			providerWordTimestamps(TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM),
		).toBe(DEEPGRAM_CAPABILITIES.wordTimestamps);
	});
});

describe('the language hint gate', () => {
	it('records which engines read a language hint at all', () => {
		// Voxtral is the one that does not: Mistral documents `language` as
		// incompatible with `timestamp_granularities`, and the granularity is
		// what makes the response carry segments, so the hint gives way.
		expect(
			providerReadsLanguageHint(TRANSCRIPTION_PROVIDER_IDS.WHISPER_API),
		).toBe(true);
		expect(
			providerReadsLanguageHint(TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM),
		).toBe(true);
		expect(
			providerReadsLanguageHint(TRANSCRIPTION_PROVIDER_IDS.GEMINI),
		).toBe(true);
		expect(
			providerReadsLanguageHint(TRANSCRIPTION_PROVIDER_IDS.LOCAL_WHISPER),
		).toBe(true);
		expect(
			providerReadsLanguageHint(TRANSCRIPTION_PROVIDER_IDS.VOXTRAL),
		).toBe(false);
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
		expect(languageNote(TRANSCRIPTION_PROVIDER_IDS.WHISPER_API)).toMatch(
			/ISO code/,
		);
		expect(languageNote(TRANSCRIPTION_PROVIDER_IDS.VOXTRAL)).toMatch(
			/detects the spoken language/,
		);
	});

	it('keeps the field readable for chapters on an engine that drops it', () => {
		// The two gates answer the same typed value differently, which is why
		// the row stays editable on such an engine: the request drops the code
		// and auto chapters still name the language to the model with it. A
		// note claiming the field is simply unread would be wrong about the
		// second reader, and a disabled row would leave it unreachable.
		expect(
			effectiveLanguage(TRANSCRIPTION_PROVIDER_IDS.VOXTRAL, 'ru'),
		).toBeUndefined();
		expect(configuredLanguageHint('ru')).toBe('ru');
		expect(languageNote(TRANSCRIPTION_PROVIDER_IDS.VOXTRAL)).toMatch(
			/Auto chapters still read it/,
		);
	});
});

describe('a field naming several languages', () => {
	it('reads the codes in the order typed and ignores spacing', () => {
		expect(configuredLanguages(' pl ,uk, be ')).toEqual(['pl', 'uk', 'be']);
		expect(configuredLanguages('auto')).toEqual([]);
		expect(configuredLanguages('')).toEqual([]);
		expect(configuredLanguageHint('pl, uk')).toBe('pl');
	});

	it('counts a code typed twice once, whatever its case', () => {
		expect(configuredLanguages('pl, PL, uk, pl')).toEqual(['pl', 'uk']);
		// So a repeated single code keeps the single-language request.
		expect(
			effectiveLanguages(TRANSCRIPTION_PROVIDER_IDS.GEMINI, 'pl, pl'),
		).toBeUndefined();
	});

	it('records Gemini as the one engine that reads a list', () => {
		expect(
			Object.values(TRANSCRIPTION_PROVIDER_IDS).filter((id) =>
				providerReadsLanguageList(id),
			),
		).toEqual([TRANSCRIPTION_PROVIDER_IDS.GEMINI]);
	});

	it.each([
		{
			name: 'sends every code to an engine that reads a list',
			id: TRANSCRIPTION_PROVIDER_IDS.GEMINI,
			language: 'pl, uk',
			languages: ['pl', 'uk'],
			hint: 'pl',
		},
		{
			name: 'sends the first code to an engine that takes one',
			id: TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
			language: 'pl, uk',
			languages: undefined,
			hint: 'pl',
		},
		{
			name: 'keeps a single code a single-language request',
			id: TRANSCRIPTION_PROVIDER_IDS.GEMINI,
			language: 'pl',
			languages: undefined,
			hint: 'pl',
		},
		{
			name: 'sends nothing to an engine that reads no language',
			id: TRANSCRIPTION_PROVIDER_IDS.VOXTRAL,
			language: 'pl, uk',
			languages: undefined,
			hint: undefined,
		},
	])('$name', ({ id, language, languages, hint }) => {
		expect(effectiveLanguages(id, language)).toEqual(languages);
		expect(effectiveLanguage(id, language)).toBe(hint);
	});

	it('tells each engine what a list does on it', () => {
		expect(languageNote(TRANSCRIPTION_PROVIDER_IDS.GEMINI)).toMatch(
			/each segment is written in its own language/,
		);
		expect(languageNote(TRANSCRIPTION_PROVIDER_IDS.WHISPER_API)).toMatch(
			/only the first is sent/,
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

/**
 * Whether an engine reads a file stored under this extension as it stands.
 * @param capabilities - The engine's declaration
 * @param extension - The file's extension, which also gives its MIME type
 * @returns True when the original bytes are uploaded with no decode
 */
function readsAsItStands(
	capabilities: ProviderCapabilities,
	extension: string,
): boolean {
	return capabilities.originalContainers.accepts(
		audioContainerFromExtension(extension),
	);
}

// The service decodes every other container to 16 kHz mono WAV before the
// provider sees it, so these answers decide which recordings pay a decode.
// Getting one wrong either way is costly: a container claimed but unread is
// refused by the endpoint after the upload, and one read but unclaimed is
// expanded to a WAV several times its size for nothing.
describe('the containers each engine reads as they stand', () => {
	it.each([
		{ name: 'Whisper API', capabilities: WHISPER_API_CAPABILITIES },
		{ name: 'Deepgram', capabilities: DEEPGRAM_CAPABILITIES },
	])('reads every container on $name', ({ capabilities }) => {
		expect(
			['webm', 'ogg', 'mp3', 'm4a', 'mp4', 'wav', 'flac', 'aac'].filter(
				(extension) => !readsAsItStands(capabilities, extension),
			),
		).toEqual([]);
	});

	// A user's WAV is rarely the 16 kHz mono whisper.cpp needs, so even WAV is
	// decoded and resampled.
	it('reads none on local whisper.cpp, WAV included', () => {
		expect(
			['webm', 'ogg', 'mp3', 'wav'].filter((extension) =>
				readsAsItStands(LOCAL_WHISPER_CAPABILITIES, extension),
			),
		).toEqual([]);
	});

	it.each([
		{ extension: 'wav', reads: true },
		{ extension: 'mp3', reads: true },
		{ extension: 'aac', reads: true },
		{ extension: 'ogg', reads: true },
		{ extension: 'flac', reads: true },
		{ extension: 'webm', reads: false },
		{ extension: 'm4a', reads: false },
		{ extension: 'mp4', reads: false },
	])('answers $reads for $extension on Gemini', ({ extension, reads }) => {
		expect(readsAsItStands(GEMINI_CAPABILITIES, extension)).toBe(reads);
	});

	// `m4a` and `mp4` are one `audio/mp4` in the format registry and Mistral
	// lists only m4a, so a type-keyed gate sent every iOS recording - mp4 is
	// what that platform falls back to - as a container the endpoint never
	// claimed to read. The extension is what decides.
	it.each([
		{ extension: 'wav', reads: true },
		{ extension: 'mp3', reads: true },
		{ extension: 'm4a', reads: true },
		{ extension: 'ogg', reads: true },
		{ extension: 'flac', reads: true },
		{ extension: 'mp4', reads: false },
		{ extension: 'webm', reads: false },
	])('answers $reads for $extension on Voxtral', ({ extension, reads }) => {
		expect(readsAsItStands(VOXTRAL_CAPABILITIES, extension)).toBe(reads);
	});

	it('reads the extension in any case', () => {
		expect(readsAsItStands(VOXTRAL_CAPABILITIES, 'M4A')).toBe(true);
	});

	// The names are what a refusal tells the user to convert to, so each has
	// to be a container the same engine reads.
	it.each([
		{ name: 'Gemini', capabilities: GEMINI_CAPABILITIES },
		{ name: 'Voxtral', capabilities: VOXTRAL_CAPABILITIES },
	])('advises only containers $name reads', ({ capabilities }) => {
		const named = (capabilities.originalContainers.acceptedNames ?? '')
			.split(/, | or /)
			.filter((extension) => extension !== '');

		expect(named.length).toBeGreaterThan(0);
		expect(
			named.filter(
				(extension) => !readsAsItStands(capabilities, extension),
			),
		).toEqual([]);
	});
});
