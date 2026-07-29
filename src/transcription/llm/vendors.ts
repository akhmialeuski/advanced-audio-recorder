/**
 * The LLM vendor registry: the one place that knows everything vendor-specific
 * about transcript post-processing, chapter generation, and the advanced
 * context agents.
 *
 * The layers are deliberate. {@link LlmProvider} is the bottom: a single
 * `complete(prompt, maxTokens, options)` call whose implementations differ only
 * in wire format. This module is the top: for each vendor it names the label,
 * the shipped base URL, the pricing page, the model catalog link, the rate
 * table, which settings fields hold that vendor's key and model, and how to
 * construct its provider. Everything above (settings UI, cost model, factory,
 * migrations) reads a descriptor instead of branching on the provider id, so
 * adding a vendor is one entry here rather than an edit in nine files.
 *
 * The registry is typed as `Record<LlmProviderId, LlmVendorDescriptor>`, which
 * makes a missing vendor a compile error instead of a silent fall-through to
 * OpenAI - the behaviour every hand-written `else` branch used to have.
 * @module transcription/llm/vendors
 */

import {
	ANTHROPIC_MODELS_DOC_URL,
	DEFAULT_LLM_ANTHROPIC_BASE_URL,
	DEFAULT_LLM_GEMINI_BASE_URL,
	DEFAULT_LLM_OPENAI_BASE_URL,
	GEMINI_MODELS_DOC_URL,
	LLM_PROVIDER_IDS,
	OPENAI_MODELS_DOC_URL,
} from '../../constants';
import type {
	AudioRecorderSettings,
	LlmProviderId,
} from '../../settings/settingsSchema';
import {
	AnthropicLlmProvider,
	GeminiLlmProvider,
	OpenAiCompatibleLlmProvider,
	type LlmConfig,
	type LlmProvider,
} from './LlmProvider';

/**
 * A text-billed LLM rate: USD per million input and output tokens. Lives here
 * rather than in the cost model so a vendor's rates sit next to the vendor.
 */
export interface LlmRate {
	input: number;
	output: number;
}

/**
 * How a vendor's key and model are stored in settings. Which field holds them
 * is a vendor fact (OpenAI and Gemini reuse their transcription keys so a
 * vendor token is entered once; Anthropic has no transcription counterpart and
 * keeps its own), so it belongs to the descriptor rather than to each consumer.
 */
export interface LlmVendorSettingsAccess {
	/** Reads the vendor's API key. */
	apiKey(settings: AudioRecorderSettings): string;
	/** Writes the vendor's API key. */
	setApiKey(settings: AudioRecorderSettings, key: string): void;
	/** Reads the selected model id. */
	model(settings: AudioRecorderSettings): string;
	/** Writes the selected model id. */
	setModel(settings: AudioRecorderSettings, id: string): void;
	/** Reads the saved, user-editable model list. */
	models(settings: AudioRecorderSettings): string[];
	/** Writes the saved model list. */
	setModels(settings: AudioRecorderSettings, ids: string[]): void;
}

/** Everything the plugin knows about one LLM vendor. */
export interface LlmVendorDescriptor {
	readonly id: LlmProviderId;
	/** Display label, used in dropdowns and cost-estimate lines. */
	readonly label: string;
	/** Base URL shipped as this vendor's default. */
	readonly defaultBaseUrl: string;
	/** Public pricing page, linked from the cost estimate. */
	readonly pricingUrl: string;
	/** Model catalog link shown under the model picker. */
	readonly modelsDocUrl: string;
	/** Label for the model catalog link. */
	readonly modelsDocLabel: string;
	/** Description shown on the model picker row. */
	readonly modelPickerDesc: string;
	/** Label of the API-key settings row. */
	readonly keyFieldName: string;
	/** Description of the API-key settings row. */
	readonly keyFieldDesc: string;
	/** Error shown when a run is attempted with no key configured. */
	readonly missingKeyMessage: string;
	/**
	 * Approximate rates by model-id fragment, USD per million tokens. Matched
	 * longest-fragment-first by the cost model, so a more specific entry wins.
	 */
	readonly rates: readonly [string, LlmRate][];
	/** Settings fields holding this vendor's key and model. */
	readonly settings: LlmVendorSettingsAccess;
	/** Builds the provider that talks to this vendor. */
	create(config: LlmConfig): LlmProvider;
}

/**
 * Approximate OpenAI chat rates, USD per million tokens. The GPT-5.6 family is
 * the current seeded generation; the 4.x and o-series entries below it were
 * dropped from the seed list but stay priced because the API still serves them
 * for user-saved model lists.
 */
const OPENAI_RATES: readonly [string, LlmRate][] = [
	['gpt-5.6-sol', { input: 5, output: 30 }],
	['gpt-5.6-terra', { input: 2.5, output: 15 }],
	['gpt-5.6-luna', { input: 1, output: 6 }],
	['gpt-4o-mini', { input: 0.15, output: 0.6 }],
	['gpt-4.1-mini', { input: 0.4, output: 1.6 }],
	['gpt-4.1', { input: 2.0, output: 8.0 }],
	['gpt-4o', { input: 2.5, output: 10 }],
	['o4-mini', { input: 1.1, output: 4.4 }],
];

/**
 * Approximate Anthropic rates, USD per million tokens. The bare
 * `claude-opus-4` fragment prices the $5/$25 Opus 4.5-4.8 tier; the longer
 * `claude-opus-4-1`/`claude-opus-4-0` fragments win the longest-match rule for
 * the legacy $15/$75 models so they do not inherit the cheaper rate.
 */
const ANTHROPIC_RATES: readonly [string, LlmRate][] = [
	['claude-fable-5', { input: 10, output: 50 }],
	['claude-sonnet-5', { input: 3, output: 15 }],
	['claude-opus-4-1', { input: 15, output: 75 }],
	['claude-opus-4-0', { input: 15, output: 75 }],
	['claude-opus-4', { input: 5, output: 25 }],
	['claude-sonnet-4', { input: 3, output: 15 }],
	['claude-haiku-4', { input: 1, output: 5 }],
];

/**
 * Approximate Gemini text rates, USD per million tokens. Post-processing input
 * is text (the transcript), so unlike the Gemini transcription rates the
 * text-input rate applies to every input token.
 */
const GEMINI_RATES: readonly [string, LlmRate][] = [
	['gemini-3.6-flash', { input: 1.5, output: 7.5 }],
	['gemini-3.5-flash', { input: 1.5, output: 9 }],
	['gemini-3.5-flash-lite', { input: 0.3, output: 2.5 }],
	['gemini-2.5-flash-lite', { input: 0.1, output: 0.4 }],
	['gemini-2.5-flash', { input: 0.3, output: 2.5 }],
	['gemini-2.5-pro', { input: 1.25, output: 10 }],
	['gemini-2.0-flash', { input: 0.1, output: 0.4 }],
];

/**
 * Every LLM vendor, keyed by its settings id. Insertion order is the order the
 * provider dropdown offers them.
 */
export const LLM_VENDORS: Record<LlmProviderId, LlmVendorDescriptor> = {
	[LLM_PROVIDER_IDS.OPENAI_COMPATIBLE]: {
		id: LLM_PROVIDER_IDS.OPENAI_COMPATIBLE,
		label: 'OpenAI',
		defaultBaseUrl: DEFAULT_LLM_OPENAI_BASE_URL,
		pricingUrl: 'https://openai.com/api/pricing/',
		modelsDocUrl: OPENAI_MODELS_DOC_URL,
		modelsDocLabel: 'OpenAI models',
		modelPickerDesc:
			'Pick an OpenAI model (e.g. gpt-5.6-sol, gpt-5.6-luna).',
		keyFieldName: 'OpenAI API key',
		keyFieldDesc:
			'Shared with the Whisper API transcription engine - set it in either place.',
		missingKeyMessage: 'Set the OpenAI API key in settings.',
		rates: OPENAI_RATES,
		settings: {
			// OpenAI reuses the Whisper API key as the shared OpenAI vendor key.
			apiKey: (s) => s.whisperApiKey,
			setApiKey: (s, key) => (s.whisperApiKey = key),
			model: (s) => s.llmOpenAiModel,
			setModel: (s, id) => (s.llmOpenAiModel = id),
			models: (s) => s.llmOpenAiModels,
			setModels: (s, ids) => (s.llmOpenAiModels = ids),
		},
		create: (config) => new OpenAiCompatibleLlmProvider(config),
	},
	[LLM_PROVIDER_IDS.ANTHROPIC]: {
		id: LLM_PROVIDER_IDS.ANTHROPIC,
		label: 'Anthropic (Claude)',
		defaultBaseUrl: DEFAULT_LLM_ANTHROPIC_BASE_URL,
		pricingUrl: 'https://www.anthropic.com/pricing',
		modelsDocUrl: ANTHROPIC_MODELS_DOC_URL,
		modelsDocLabel: 'Anthropic models',
		modelPickerDesc:
			'Pick an Anthropic model (e.g. claude-opus-4-8, claude-sonnet-5).',
		keyFieldName: 'Anthropic API key',
		keyFieldDesc: 'Stored in plugin data on this device.',
		missingKeyMessage: 'Set the Anthropic API key in settings.',
		rates: ANTHROPIC_RATES,
		settings: {
			// Anthropic has no transcription counterpart, so it keeps its own key.
			apiKey: (s) => s.anthropicApiKey,
			setApiKey: (s, key) => (s.anthropicApiKey = key),
			model: (s) => s.llmAnthropicModel,
			setModel: (s, id) => (s.llmAnthropicModel = id),
			models: (s) => s.llmAnthropicModels,
			setModels: (s, ids) => (s.llmAnthropicModels = ids),
		},
		create: (config) => new AnthropicLlmProvider(config),
	},
	[LLM_PROVIDER_IDS.GEMINI]: {
		id: LLM_PROVIDER_IDS.GEMINI,
		label: 'Google Gemini',
		defaultBaseUrl: DEFAULT_LLM_GEMINI_BASE_URL,
		pricingUrl: 'https://ai.google.dev/gemini-api/docs/pricing',
		modelsDocUrl: GEMINI_MODELS_DOC_URL,
		modelsDocLabel: 'Gemini model list',
		modelPickerDesc:
			'Pick a Gemini model (e.g. gemini-3.5-flash, gemini-2.5-pro).',
		keyFieldName: 'Google Gemini API key',
		keyFieldDesc:
			'Shared with the Gemini transcription engine - set it in either place.',
		missingKeyMessage: 'Set the Google Gemini API key in settings.',
		rates: GEMINI_RATES,
		settings: {
			// Gemini reuses the Gemini transcription key.
			apiKey: (s) => s.geminiApiKey,
			setApiKey: (s, key) => (s.geminiApiKey = key),
			model: (s) => s.llmGeminiModel,
			setModel: (s, id) => (s.llmGeminiModel = id),
			models: (s) => s.llmGeminiModels,
			setModels: (s, ids) => (s.llmGeminiModels = ids),
		},
		create: (config) => new GeminiLlmProvider(config),
	},
};

/** Every vendor id, in the order the provider dropdown offers them. */
export const LLM_VENDOR_IDS = Object.keys(LLM_VENDORS) as LlmProviderId[];

/**
 * The descriptor for a vendor id.
 * @param id - LLM provider id
 */
export function llmVendor(id: LlmProviderId): LlmVendorDescriptor {
	return LLM_VENDORS[id];
}

/**
 * The descriptor for the vendor the settings currently select.
 * @param settings - Plugin settings
 */
export function selectedLlmVendor(
	settings: AudioRecorderSettings,
): LlmVendorDescriptor {
	return llmVendor(settings.llmProvider);
}

/**
 * Base URLs that ship as vendor defaults. Auto-switching only replaces a value
 * still equal to one of these, so a custom endpoint the user typed survives a
 * provider change.
 */
export const DEFAULT_LLM_BASE_URLS: ReadonlySet<string> = new Set(
	LLM_VENDOR_IDS.map((id) => LLM_VENDORS[id].defaultBaseUrl),
);
