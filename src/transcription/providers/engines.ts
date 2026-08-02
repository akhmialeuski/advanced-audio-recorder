/**
 * The transcription engine registry: the one place that knows everything
 * engine-specific about turning audio into timed segments.
 *
 * {@link TranscriptionProvider} is the bottom layer - a single `transcribe`
 * call whose implementations differ only in wire format - and
 * {@link ProviderCapabilities} already described what an engine accepts. This
 * module is the top layer: for each engine it names the label, the pricing
 * page, the rate table, which settings fields hold its endpoint, key, and
 * model, how a custom dictionary is applied within that engine's limits, and
 * how to construct it. Everything above (cost model, factory, settings UI,
 * dictionary planning) reads a descriptor instead of branching on the engine
 * id, so adding an engine is one entry here.
 *
 * Typed as `Record<TranscriptionProviderId, ...>`, so a missing engine is a
 * compile error rather than a silent fall-through to the Whisper API.
 * @module transcription/providers/engines
 */

import { MS_PER_MINUTE, TRANSCRIPTION_PROVIDER_IDS } from '../../constants';
import {
	ACCOUNTS,
	ENGINES,
	ENGINE_IDS,
	type EngineId,
} from '../../providers/providers';
import type {
	AudioRecorderSettings,
	TranscriptionProviderId,
} from '../../settings/settingsSchema';
import { ProviderConfigError } from '../providerConfigError';
import {
	DEEPGRAM_KEYTERM_LIMIT,
	DEEPGRAM_KEYWORDS_LIMIT,
	deepgramBiasMechanism,
	termsWithinDeepgramKeyterm,
	termsWithinWhisperPrompt,
	type DictionaryBiasPlan,
} from '../dictionaryBias';
import { DeepgramProvider } from './DeepgramProvider';
import { GeminiProvider } from './GeminiProvider';
import { LocalWhisperProvider } from './LocalWhisperProvider';
import { WhisperApiProvider } from './WhisperApiProvider';
import type { TranscriptionProvider } from './TranscriptionProvider';
import {
	effectiveDictionary,
	isProviderAvailableOnPlatform,
} from './capabilities';

/**
 * How an engine bills a request. A token-billed engine prices the audio and
 * text portions of the prompt separately, because providers such as Gemini
 * charge audio input at a higher rate than text input.
 */
export type EnginePricing =
	| { kind: 'free' }
	| { kind: 'perMinute'; usdPerMinute: number }
	| {
			kind: 'perToken';
			usdPerMillionAudioInput: number;
			usdPerMillionTextInput: number;
			usdPerMillionOutput: number;
	  };

/** A token-billed rate: USD per million audio-input, text-input, and output tokens. */
interface TokenRate {
	audioInput: number;
	textInput: number;
	output: number;
}

/**
 * The endpoint, key, and model-list settings of a cloud engine. Absent on the
 * local engine, which points at files on disk instead.
 */
export interface EngineCredentials {
	/**
	 * Settings keys the engine's fields are stored under. The settings tab is
	 * declared as data, and a declaration binds a control to a key, so the
	 * descriptor names its keys as well as reading and writing them.
	 */
	readonly baseUrlKey: keyof AudioRecorderSettings;
	readonly apiKeyKey: keyof AudioRecorderSettings;
	readonly modelKey: keyof AudioRecorderSettings;
	readonly modelsKey: keyof AudioRecorderSettings;
	baseUrl(settings: AudioRecorderSettings): string;
	setBaseUrl(settings: AudioRecorderSettings, url: string): void;
	apiKey(settings: AudioRecorderSettings): string;
	setApiKey(settings: AudioRecorderSettings, key: string): void;
	setModel(settings: AudioRecorderSettings, id: string): void;
	models(settings: AudioRecorderSettings): string[];
	setModels(settings: AudioRecorderSettings, ids: string[]): void;
	/** Label and description of the base-URL settings row. */
	readonly baseUrlFieldName: string;
	readonly baseUrlFieldDesc: string;
	/** Label and description of the API-key settings row. */
	readonly keyFieldName: string;
	readonly keyFieldDesc: string;
	/** Label, description, and catalog link of the model picker row. */
	readonly modelPickerName: string;
	readonly modelPickerDesc: string;
	readonly modelsDocLabel: string;
	readonly modelsDocUrl: string;
}

/**
 * The half of an engine's credentials that belongs to the service rather than
 * to transcription: its endpoint, its key, and the catalogue its speech models
 * come from. Read from the provider registry, so a service that also answers
 * prompts declares them once and both uses reach the same fields.
 * @param id - Provider the engine is a capability of
 * @returns That provider's credentials for transcription
 */
function credentialsFromRegistry(id: EngineId): EngineCredentials {
	const engine = ENGINES[id];
	const connection = engine.account ? ACCOUNTS[engine.account] : undefined;
	const models = engine.models;
	if (!connection || !models) {
		throw new Error(`Engine "${id}" declares no endpoint`);
	}
	return {
		baseUrlKey: connection.baseUrlKey,
		apiKeyKey: connection.apiKeyKey,
		modelKey: models.modelKey,
		modelsKey: models.modelsKey,
		baseUrl: connection.baseUrl,
		setBaseUrl: connection.setBaseUrl,
		apiKey: connection.apiKey,
		setApiKey: connection.setApiKey,
		setModel: models.setModel,
		models: models.models,
		setModels: models.setModels,
		baseUrlFieldName: connection.baseUrlFieldName,
		baseUrlFieldDesc: connection.baseUrlFieldDesc,
		keyFieldName: connection.keyFieldName,
		keyFieldDesc: connection.keyFieldDesc,
		modelPickerName: models.pickerName,
		modelPickerDesc: models.pickerDesc,
		modelsDocLabel: models.docLabel,
		modelsDocUrl: models.docUrl,
	};
}

/** Everything the plugin knows about one transcription engine. */
export interface TranscriptionEngineDescriptor {
	readonly id: TranscriptionProviderId;
	/** Display label, used in dropdowns and cost-estimate lines. */
	readonly label: string;
	/** Public pricing page; absent for the free local engine. */
	readonly pricingUrl?: string;
	/**
	 * The model id the settings select for this engine, '' for the local
	 * engine, which has no billed model.
	 */
	model(settings: AudioRecorderSettings): string;
	/** Resolves the rate for a model id, or null when none is built in. */
	pricing(model: string): EnginePricing | null;
	/** Endpoint/key/model settings, absent for the local engine. */
	readonly credentials?: EngineCredentials;
	/**
	 * Plans how the user's dictionary terms are applied within this engine's
	 * mechanism and request limits. The per-engine rules live with the engine
	 * rather than in a switch the caller has to keep in step.
	 */
	planDictionary(model: string, terms: string[]): DictionaryBiasPlan;
	/**
	 * Why this engine and model cannot carry generated biasing context, or null
	 * when they can. Checked before the advanced mode spends any LLM call.
	 */
	biasUnsupportedReason(model: string): string | null;
	/**
	 * Builds the provider, validating the settings it needs. Throws
	 * {@link ProviderConfigError} when they are incomplete or the engine cannot
	 * run on this platform.
	 */
	create(
		settings: AudioRecorderSettings,
		requestTimeoutMs: number,
	): TranscriptionProvider;
}

/**
 * Approximate per-minute Whisper API rates by model-id fragment. Values are
 * USD per audio minute.
 */
const WHISPER_API_RATES: readonly [string, number][] = [
	// Groq-hosted Whisper models (priced per hour: $0.02 / $0.04 / $0.111).
	['distil-whisper-large-v3-en', 0.02 / 60],
	['whisper-large-v3-turbo', 0.04 / 60],
	['whisper-large-v3', 0.111 / 60],
	// OpenAI whisper-1.
	['whisper-1', 0.006],
];

/** Approximate Deepgram pre-recorded pay-as-you-go rates, USD per minute. */
const DEEPGRAM_RATES: readonly [string, number][] = [
	['enhanced', 0.0145],
	['whisper', 0.0048],
	['nova-3', 0.0043],
	['nova-2', 0.0043],
	['nova', 0.0043],
	['base', 0.0125],
];

/**
 * Approximate Gemini transcription rates. On the 2.5 Flash tier audio input is
 * billed higher than text input, so the two are kept apart; the 2.5 Pro tier
 * and the whole 3.x generation bill every input modality at one rate.
 */
const GEMINI_RATES: readonly [string, TokenRate][] = [
	['gemini-3.6-flash', { audioInput: 1.5, textInput: 1.5, output: 7.5 }],
	['gemini-3.5-flash', { audioInput: 1.5, textInput: 1.5, output: 9 }],
	['gemini-3.5-flash-lite', { audioInput: 0.3, textInput: 0.3, output: 2.5 }],
	['gemini-2.5-flash-lite', { audioInput: 0.3, textInput: 0.1, output: 0.4 }],
	['gemini-2.5-flash', { audioInput: 1.0, textInput: 0.3, output: 2.5 }],
	['gemini-2.5-pro', { audioInput: 1.25, textInput: 1.25, output: 10 }],
	['gemini-2.0-flash', { audioInput: 0.7, textInput: 0.1, output: 0.4 }],
];

/**
 * Finds the rate whose model-id fragment appears in the (normalized) model id,
 * preferring the longest fragment so more specific entries win: a
 * `whisper-large-v3-turbo` id never resolves through `whisper-large-v3`, and
 * `distil-whisper-large-v3-en` (a distinct, cheaper model) never resolves
 * through the full `whisper-large-v3` rate.
 * @param rates - Rate table as (model-id fragment, rate) pairs
 * @param model - The model id to price
 */
export function matchRate<T>(
	rates: readonly [string, T][],
	model: string,
): T | undefined {
	const normalized = model.trim().toLowerCase();
	let best: { length: number; value: T } | undefined;
	for (const [fragment, value] of rates) {
		if (
			normalized.includes(fragment) &&
			(!best || fragment.length > best.length)
		) {
			best = { length: fragment.length, value };
		}
	}
	return best?.value;
}

/** Wraps a per-minute rate as pricing, or null when unmatched. */
function perMinutePricing(rate: number | undefined): EnginePricing | null {
	return rate === undefined
		? null
		: { kind: 'perMinute', usdPerMinute: rate };
}

/** Wraps a matched {@link TokenRate} as per-token pricing, or null when unmatched. */
function perTokenPricing(rate: TokenRate | undefined): EnginePricing | null {
	return rate === undefined
		? null
		: {
				kind: 'perToken',
				usdPerMillionAudioInput: rate.audioInput,
				usdPerMillionTextInput: rate.textInput,
				usdPerMillionOutput: rate.output,
			};
}

/**
 * Applies the Whisper prompt window: terms beyond the ~224-token window the
 * decoder actually reads are reported as omitted rather than silently dropped.
 * Shared by the Whisper API and local whisper.cpp, which use the same field.
 */
function planWhisperPromptDictionary(terms: string[]): DictionaryBiasPlan {
	const applied = termsWithinWhisperPrompt(terms);
	if (applied.length < terms.length) {
		return {
			applied,
			omitted: terms.slice(applied.length),
			reason: 'prompt-window',
		};
	}
	return { applied, omitted: [] };
}

/**
 * Every transcription engine, keyed by its settings id. Insertion order is the
 * order the engine dropdown offers them.
 */
export const TRANSCRIPTION_ENGINES: Record<
	TranscriptionProviderId,
	TranscriptionEngineDescriptor
> = {
	[TRANSCRIPTION_PROVIDER_IDS.WHISPER_API]: {
		id: TRANSCRIPTION_PROVIDER_IDS.WHISPER_API,
		// The engine is named for what it does; the service behind it is named
		// once in the provider registry.
		label: 'Whisper API (OpenAI-compatible)',
		pricingUrl: 'https://openai.com/api/pricing/',
		model: (s) => s.whisperApiModel,
		pricing: (model) =>
			perMinutePricing(matchRate(WHISPER_API_RATES, model)),
		credentials: credentialsFromRegistry(ENGINE_IDS.WHISPER_API),
		planDictionary: (_model, terms) => planWhisperPromptDictionary(terms),
		biasUnsupportedReason: () => null,
		create: (settings, requestTimeoutMs) => {
			if (!settings.whisperApiKey) {
				throw new ProviderConfigError(
					'Set the Whisper API key in settings to transcribe.',
				);
			}
			return new WhisperApiProvider({
				baseUrl: settings.whisperApiBaseUrl,
				apiKey: settings.whisperApiKey,
				model: settings.whisperApiModel,
				requestTimeoutMs,
			});
		},
	},
	[TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM]: {
		id: TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
		label: 'Deepgram',
		pricingUrl: 'https://deepgram.com/pricing',
		model: (s) => s.deepgramModel,
		pricing: (model) => perMinutePricing(matchRate(DEEPGRAM_RATES, model)),
		credentials: credentialsFromRegistry(ENGINE_IDS.DEEPGRAM),
		// Deepgram's mechanism, and therefore its limits, depend on the model:
		// Nova-3 keyterm prompting is bounded by both an entry count and an
		// aggregate token budget, Nova-2 and older keyword boosting only by an
		// entry count, and the hosted Whisper models cannot bias at all.
		planDictionary: (model, terms) => {
			const mechanism = deepgramBiasMechanism(model);
			if (mechanism === null) {
				return {
					applied: [],
					omitted: terms,
					reason: 'model-unsupported',
				};
			}
			if (mechanism === 'keyterm') {
				const applied = termsWithinDeepgramKeyterm(terms);
				if (applied.length < terms.length) {
					return {
						applied,
						omitted: terms.slice(applied.length),
						// Stopping at the entry cap means the count bound bit;
						// stopping earlier means the aggregate token budget did.
						reason:
							applied.length >= DEEPGRAM_KEYTERM_LIMIT
								? 'keyterm-limit'
								: 'keyterm-token-budget',
					};
				}
				return { applied, omitted: [] };
			}
			if (terms.length > DEEPGRAM_KEYWORDS_LIMIT) {
				return {
					applied: terms.slice(0, DEEPGRAM_KEYWORDS_LIMIT),
					omitted: terms.slice(DEEPGRAM_KEYWORDS_LIMIT),
					reason: 'keywords-limit',
				};
			}
			return { applied: terms, omitted: [] };
		},
		biasUnsupportedReason: (model) =>
			deepgramBiasMechanism(model) === null
				? `the Deepgram model "${model}" cannot bias recognition (choose a Nova model)`
				: null,
		create: (settings, requestTimeoutMs) => {
			if (!settings.deepgramApiKey) {
				throw new ProviderConfigError(
					'Set the Deepgram API key in settings to transcribe.',
				);
			}
			return new DeepgramProvider({
				baseUrl: settings.deepgramBaseUrl,
				apiKey: settings.deepgramApiKey,
				model: settings.deepgramModel,
				requestTimeoutMs,
			});
		},
	},
	[TRANSCRIPTION_PROVIDER_IDS.GEMINI]: {
		id: TRANSCRIPTION_PROVIDER_IDS.GEMINI,
		label: 'Google Gemini',
		pricingUrl: 'https://ai.google.dev/gemini-api/docs/pricing',
		model: (s) => s.geminiModel,
		pricing: (model) => perTokenPricing(matchRate(GEMINI_RATES, model)),
		credentials: credentialsFromRegistry(ENGINE_IDS.GEMINI),
		// Gemini folds terms into a large instruction context with no hard cap.
		planDictionary: (_model, terms) => ({ applied: terms, omitted: [] }),
		biasUnsupportedReason: () => null,
		create: (settings, requestTimeoutMs) => {
			if (!settings.geminiApiKey) {
				throw new ProviderConfigError(
					'Set the Google Gemini API key in settings to transcribe.',
				);
			}
			return new GeminiProvider({
				baseUrl: settings.geminiBaseUrl,
				apiKey: settings.geminiApiKey,
				model: settings.geminiModel,
				requestTimeoutMs,
			});
		},
	},
	[TRANSCRIPTION_PROVIDER_IDS.LOCAL_WHISPER]: {
		id: TRANSCRIPTION_PROVIDER_IDS.LOCAL_WHISPER,
		label: 'Local whisper.cpp (desktop)',
		// Runs on the user's machine, so there is no rate card to link.
		model: () => '',
		pricing: () => ({ kind: 'free' }),
		planDictionary: (_model, terms) => planWhisperPromptDictionary(terms),
		biasUnsupportedReason: () => null,
		create: (settings) => {
			if (
				!settings.localWhisperBinaryPath ||
				!settings.localWhisperModelPath
			) {
				throw new ProviderConfigError(
					'Set the local whisper.cpp binary and model paths in settings.',
				);
			}
			const provider = new LocalWhisperProvider({
				binaryPath: settings.localWhisperBinaryPath,
				modelPath: settings.localWhisperModelPath,
				extraArgs: parseArgs(settings.localWhisperExtraArgs),
			});
			if (!provider.isAvailable()) {
				throw new ProviderConfigError(
					'Local transcription is only available in the desktop app.',
				);
			}
			return provider;
		},
	},
};

/** Every engine id, in the order the engine dropdown offers them. */
export const TRANSCRIPTION_ENGINE_IDS = Object.keys(
	TRANSCRIPTION_ENGINES,
) as TranscriptionProviderId[];

/**
 * The descriptor for an engine id.
 * @param id - Transcription engine id
 */
export function transcriptionEngine(
	id: TranscriptionProviderId,
): TranscriptionEngineDescriptor {
	return TRANSCRIPTION_ENGINES[id];
}

/**
 * The descriptor for the engine the settings currently select.
 * @param settings - Plugin settings
 */
export function selectedTranscriptionEngine(
	settings: AudioRecorderSettings,
): TranscriptionEngineDescriptor {
	return transcriptionEngine(settings.transcriptionProvider);
}

/**
 * Builds the configured transcription provider from the selected engine's
 * descriptor, which owns the fields it reads and the errors it raises.
 * @param settings - Plugin settings
 */
export function createTranscriptionProvider(
	settings: AudioRecorderSettings,
): TranscriptionProvider {
	const engine = selectedTranscriptionEngine(settings);
	if (!isProviderAvailableOnPlatform(engine.id)) {
		throw new ProviderConfigError(
			`${engine.label} is not available on this device.`,
		);
	}
	// Per-request timeout cap shared by every network provider, from the
	// user-configured limit (minutes). Local whisper.cpp makes no HTTP request,
	// so its descriptor ignores this.
	return engine.create(
		settings,
		settings.transcriptionTimeoutMinutes * MS_PER_MINUTE,
	);
}

/**
 * Plans the dictionary biasing for a run: which terms are sent to the engine
 * and which are dropped because it cannot bias or a request limit is exceeded.
 * The model-independent capability gate is applied first, then the engine's own
 * per-model rules. The service runs every dictionary through this, so the terms
 * it sends and the terms it warns about never diverge.
 * @param engineId - Selected transcription engine id
 * @param model - Configured model id for that engine
 * @param terms - The user's parsed, de-duplicated dictionary terms
 * @returns The applied and omitted terms, with the reason when any were dropped
 */
export function planDictionaryBias(
	engineId: TranscriptionProviderId,
	model: string,
	terms: string[],
): DictionaryBiasPlan {
	// An engine with supportsDictionary=false drops everything here.
	const gated = effectiveDictionary(engineId, terms);
	if (!gated.length) {
		return { applied: [], omitted: [] };
	}
	// The mechanism and its limits are engine facts, so the descriptor plans
	// them; only the model-independent capability gate above is shared.
	return transcriptionEngine(engineId).planDictionary(model, gated);
}

/**
 * Splits a space-separated argument string into individual arguments,
 * dropping empty tokens. (Quoting is intentionally not supported - paths
 * with spaces should be configured via the dedicated path fields.)
 * @param raw - Raw argument string
 */
export function parseArgs(raw: string): string[] {
	return raw
		.split(/\s+/)
		.map((part) => part.trim())
		.filter((part) => part.length > 0);
}
