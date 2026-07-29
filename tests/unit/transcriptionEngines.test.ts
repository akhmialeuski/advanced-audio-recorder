/**
 * Tests for the transcription engine registry: it must describe every engine id
 * the settings can hold, and the cost model, labels, factory, and dictionary
 * planner must all resolve an engine through it rather than falling through to
 * the Whisper API for an id they do not recognise.
 */

import {
	TRANSCRIPTION_ENGINE_IDS,
	TRANSCRIPTION_ENGINES,
	createTranscriptionProvider,
	matchRate,
	selectedTranscriptionEngine,
	transcriptionEngine,
} from 'src/transcription/providers/engines';
import { ProviderConfigError } from 'src/transcription/providerConfigError';
import {
	DEEPGRAM_MODEL_SUGGESTIONS,
	GEMINI_MODEL_SUGGESTIONS,
	TRANSCRIPTION_PROVIDER_IDS,
	WHISPER_API_MODEL_SUGGESTIONS,
} from 'src/constants';
import { mergeSettings } from 'src/settings/settingsSerialization';
import {
	resolveEnginePricing,
	selectedEngineModel,
} from 'src/transcription/costs';
import {
	TRANSCRIPTION_PROVIDER_LABELS,
	TRANSCRIPTION_PROVIDER_OPTIONS,
	TRANSCRIPTION_PROVIDER_PRICING_URLS,
} from 'src/settings/labels';
import { providerBiasChannel } from 'src/transcription/providers/capabilities';
import { advancedBiasChannel } from 'src/transcription/advanced/advancedBias';
import type { TranscriptionProviderId } from 'src/settings/settingsSchema';

/** Every id the settings type admits, listed independently of the registry. */
const EVERY_ENGINE_ID: TranscriptionProviderId[] = [
	TRANSCRIPTION_PROVIDER_IDS.WHISPER_API,
	TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
	TRANSCRIPTION_PROVIDER_IDS.GEMINI,
	TRANSCRIPTION_PROVIDER_IDS.LOCAL_WHISPER,
];

describe('transcription engine registry', () => {
	it('describes every engine id', () => {
		expect(TRANSCRIPTION_ENGINE_IDS.slice().sort()).toEqual(
			EVERY_ENGINE_ID.slice().sort(),
		);
		for (const id of EVERY_ENGINE_ID) {
			expect(transcriptionEngine(id).id).toBe(id);
		}
	});

	it('gives every cloud engine its own settings fields', () => {
		const settings = mergeSettings();
		const cloud = TRANSCRIPTION_ENGINE_IDS.filter(
			(id) => TRANSCRIPTION_ENGINES[id].credentials !== undefined,
		);
		expect(cloud.length).toBeGreaterThan(1);
		for (const id of cloud) {
			const credentials = TRANSCRIPTION_ENGINES[id].credentials;
			if (!credentials) {
				throw new Error(`expected credentials for ${id}`);
			}
			credentials.setBaseUrl(settings, `url-${id}`);
			credentials.setApiKey(settings, `key-${id}`);
			credentials.setModel(settings, `model-${id}`);
			credentials.setModels(settings, [`model-${id}`]);
		}
		// Writing every engine's fields must not have them overwrite each other.
		for (const id of cloud) {
			const engine = TRANSCRIPTION_ENGINES[id];
			const credentials = engine.credentials;
			if (!credentials) {
				throw new Error(`expected credentials for ${id}`);
			}
			expect(credentials.baseUrl(settings)).toBe(`url-${id}`);
			expect(credentials.apiKey(settings)).toBe(`key-${id}`);
			expect(credentials.models(settings)).toEqual([`model-${id}`]);
			expect(engine.model(settings)).toBe(`model-${id}`);
		}
	});

	it('treats the local engine as free with no billed model or credentials', () => {
		const engine = transcriptionEngine(
			TRANSCRIPTION_PROVIDER_IDS.LOCAL_WHISPER,
		);
		expect(engine.credentials).toBeUndefined();
		expect(engine.pricingUrl).toBeUndefined();
		expect(engine.model(mergeSettings())).toBe('');
		expect(engine.pricing('anything')).toEqual({ kind: 'free' });
	});
});

describe('registry-derived consumers stay in step', () => {
	it('derives the labels, options, and pricing URLs from the registry', () => {
		for (const id of TRANSCRIPTION_ENGINE_IDS) {
			expect(TRANSCRIPTION_PROVIDER_LABELS[id]).toBe(
				TRANSCRIPTION_ENGINES[id].label,
			);
			expect(TRANSCRIPTION_PROVIDER_PRICING_URLS[id]).toBe(
				TRANSCRIPTION_ENGINES[id].pricingUrl,
			);
		}
		expect(TRANSCRIPTION_PROVIDER_OPTIONS.map((o) => o.value)).toEqual(
			TRANSCRIPTION_ENGINE_IDS,
		);
	});

	it('prices and selects the model of the engine actually configured', () => {
		for (const id of TRANSCRIPTION_ENGINE_IDS) {
			const engine = TRANSCRIPTION_ENGINES[id];
			const settings = mergeSettings({ transcriptionProvider: id });
			expect(selectedEngineModel(settings, id)).toBe(
				engine.model(settings),
			);
			expect(selectedTranscriptionEngine(settings)).toBe(engine);
			expect(resolveEnginePricing(id, engine.model(settings))).toEqual(
				engine.pricing(engine.model(settings)),
			);
		}
	});

	it('routes the advanced bias channel through the engine capabilities', () => {
		for (const id of TRANSCRIPTION_ENGINE_IDS) {
			expect(advancedBiasChannel(id)).toBe(providerBiasChannel(id));
		}
		// Deepgram is the keyword-biased outlier; the rest read a prompt.
		expect(providerBiasChannel(TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM)).toBe(
			'keyterm',
		);
	});

	it('refuses to build a cloud engine with no key', () => {
		for (const id of TRANSCRIPTION_ENGINE_IDS) {
			const engine = TRANSCRIPTION_ENGINES[id];
			if (!engine.credentials) {
				continue;
			}
			const settings = mergeSettings({ transcriptionProvider: id });
			engine.credentials.setApiKey(settings, '');
			expect(() => createTranscriptionProvider(settings)).toThrow(
				ProviderConfigError,
			);
		}
	});

	it('builds each configured cloud engine with its own id', () => {
		for (const id of TRANSCRIPTION_ENGINE_IDS) {
			const engine = TRANSCRIPTION_ENGINES[id];
			if (!engine.credentials) {
				continue;
			}
			const settings = mergeSettings({ transcriptionProvider: id });
			engine.credentials.setApiKey(settings, 'token');
			expect(createTranscriptionProvider(settings).id).toBe(id);
		}
	});
});

describe('every seeded model has a built-in rate', () => {
	// The seed lists and the rate tables are separate data; a model offered in
	// the picker with no rate shows "no built-in rate" in the cost estimate.
	const cases: [TranscriptionProviderId, readonly string[]][] = [
		[TRANSCRIPTION_PROVIDER_IDS.WHISPER_API, WHISPER_API_MODEL_SUGGESTIONS],
		[TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM, DEEPGRAM_MODEL_SUGGESTIONS],
		[TRANSCRIPTION_PROVIDER_IDS.GEMINI, GEMINI_MODEL_SUGGESTIONS],
	];
	it.each(cases)('prices every seeded %s model', (id, models) => {
		for (const model of models) {
			expect(transcriptionEngine(id).pricing(model)).not.toBeNull();
		}
	});
});

describe('matchRate', () => {
	it('prefers the longest matching fragment', () => {
		const rates: [string, number][] = [
			['whisper-large-v3', 1],
			['whisper-large-v3-turbo', 2],
		];
		expect(matchRate(rates, 'whisper-large-v3-turbo')).toBe(2);
		expect(matchRate(rates, 'whisper-large-v3')).toBe(1);
	});

	it('normalizes case and surrounding whitespace', () => {
		expect(matchRate([['nova-3', 7]], '  NOVA-3  ')).toBe(7);
	});

	it('returns undefined when nothing matches', () => {
		expect(matchRate([['nova-3', 7]], 'mystery')).toBeUndefined();
	});
});
