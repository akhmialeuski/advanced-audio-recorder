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
import {
	ENGINE_IDS,
	engineAccess,
	missingModelMessage,
	type EngineDescriptor,
	type EngineId,
} from 'src/providers/providers';
import type { TranscriptionProviderId } from 'src/settings/settingsSchema';
import { defined } from '../helpers/assertions';

/** The engines a transcription run reaches over an account. */
const CLOUD_ENGINES: EngineId[] = [
	ENGINE_IDS.WHISPER_API,
	ENGINE_IDS.DEEPGRAM,
	ENGINE_IDS.GEMINI,
];

/**
 * The transcription id a registry engine is stored under, asserted rather than
 * assumed so a mis-declared engine fails here instead of silently testing the
 * wrong one.
 * @param engine - The engine being addressed
 */
const transcriptionIdOf = (
	engine: EngineDescriptor,
): TranscriptionProviderId => {
	if (!engine.transcriptionId) {
		throw new Error(`Engine "${engine.id}" does not transcribe`);
	}
	return engine.transcriptionId;
};

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

	it('reads a cloud engine field set from the provider registry alone', () => {
		// The descriptor used to mirror the endpoint, the key, and the
		// catalogue that the registry already declares, and nothing outside
		// its own tests ever read the copy.
		const settings = mergeSettings();
		for (const id of CLOUD_ENGINES) {
			const { account, models } = engineAccess(id);
			account.setBaseUrl(settings, `url-${id}`);
			account.setApiKey(settings, `key-${id}`);
			models.setModel(settings, `model-${id}`);
			models.setModels(settings, [`model-${id}`]);
		}
		// Writing every engine's fields must not have them overwrite each other.
		for (const id of CLOUD_ENGINES) {
			const { account, models } = engineAccess(id);
			expect(account.baseUrl(settings)).toBe(`url-${id}`);
			expect(account.apiKey(settings)).toBe(`key-${id}`);
			expect(models.models(settings)).toEqual([`model-${id}`]);
			expect(models.model(settings)).toBe(`model-${id}`);
		}
	});

	it('reaches the two OpenAI engines through one account', () => {
		// Whisper ids and chat ids are different catalogues over one endpoint
		// and one key, which is why the key is entered once and read twice.
		const speech = engineAccess(ENGINE_IDS.WHISPER_API);
		const chat = engineAccess(ENGINE_IDS.OPENAI_LLM);

		expect(chat.account).toBe(speech.account);
		expect(chat.models).not.toBe(speech.models);
	});

	it('treats the local engine as free with no billed model or account', () => {
		const engine = transcriptionEngine(
			TRANSCRIPTION_PROVIDER_IDS.LOCAL_WHISPER,
		);
		expect(engine.pricingUrl).toBeUndefined();
		expect(engine.model(mergeSettings())).toBe('');
		expect(engine.pricing('anything')).toEqual({ kind: 'free' });
		expect(() => engineAccess(ENGINE_IDS.LOCAL_WHISPER)).toThrow(
			/not reached over an account/,
		);
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

	it('refuses to build a cloud engine with no key, in the account wording', () => {
		for (const engineId of CLOUD_ENGINES) {
			const { engine, account } = engineAccess(engineId);
			const settings = mergeSettings({
				transcriptionProvider: transcriptionIdOf(engine),
			});
			account.setApiKey(settings, '');

			expect(() => createTranscriptionProvider(settings)).toThrow(
				ProviderConfigError,
			);
			// The key is entered on a row the account labels, so the message
			// names that field rather than the engine that happened to need it.
			expect(() => createTranscriptionProvider(settings)).toThrow(
				account.missingKeyMessage,
			);
		}
	});

	it('refuses to build a cloud engine whose catalogue holds no model', () => {
		// A request naming no model cannot succeed; it used to be sent anyway
		// and fail at the endpoint in the provider's own wording.
		for (const engineId of CLOUD_ENGINES) {
			const { engine, account, models } = engineAccess(engineId);
			const settings = mergeSettings({
				transcriptionProvider: transcriptionIdOf(engine),
			});
			account.setApiKey(settings, 'token');
			models.setModel(settings, '');

			expect(() => createTranscriptionProvider(settings)).toThrow(
				missingModelMessage(engine),
			);
		}
	});

	it('builds each configured cloud engine with its own id', () => {
		for (const engineId of CLOUD_ENGINES) {
			const { engine, account } = engineAccess(engineId);
			const id = transcriptionIdOf(engine);
			const settings = mergeSettings({ transcriptionProvider: id });
			account.setApiKey(settings, 'token');

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
			// Not merely "there is a price": the estimate multiplies these
			// numbers, so a rate of zero or a NaN reads to the user as a free
			// run they are about to be billed for.
			const pricing = defined(transcriptionEngine(id).pricing(model));
			const rates = Object.values(pricing).filter(
				(value): value is number => typeof value === 'number',
			);

			expect(rates.length).toBeGreaterThan(0);
			for (const rate of rates) {
				expect(rate).toBeGreaterThan(0);
				expect(Number.isFinite(rate)).toBe(true);
			}
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
