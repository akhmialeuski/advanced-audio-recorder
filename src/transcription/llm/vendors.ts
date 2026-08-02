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

import { LLM_PROVIDER_IDS } from '../../constants';
import {
	PROVIDERS,
	PROVIDER_IDS,
	type ProviderId,
} from '../../providers/providers';
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
	/**
	 * Settings keys the vendor's fields are stored under. The settings tab is
	 * declared as data, and a declaration binds a control to a key, so the
	 * descriptor names its keys as well as reading and writing them.
	 */
	readonly apiKeyKey: keyof AudioRecorderSettings;
	readonly modelKey: keyof AudioRecorderSettings;
	readonly modelsKey: keyof AudioRecorderSettings;
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
 * The half of a vendor that belongs to the service rather than to the use: its
 * label, its endpoint, its key, and the catalogue its models come from. Read
 * from the provider registry, so a service that also transcribes declares them
 * once and both uses reach the same fields.
 * @param id - Provider the vendor is a capability of
 * @returns That provider's half of the descriptor
 */
function fromRegistry(
	id: ProviderId,
): Omit<LlmVendorDescriptor, 'rates' | 'create'> {
	const provider = PROVIDERS[id];
	const connection = provider.connection;
	const llm = provider.llm;
	if (!connection || !llm) {
		throw new Error(`Provider "${id}" declares no LLM connection`);
	}
	return {
		id: llm.vendorId,
		label: provider.label,
		defaultBaseUrl: connection.defaultBaseUrl,
		pricingUrl: provider.pricingUrl ?? '',
		modelsDocUrl: llm.models.docUrl,
		modelsDocLabel: llm.models.docLabel,
		modelPickerDesc: llm.models.pickerDesc,
		keyFieldName: connection.keyFieldName,
		keyFieldDesc: connection.keyFieldDesc,
		missingKeyMessage: connection.missingKeyMessage,
		settings: {
			apiKeyKey: connection.apiKeyKey,
			modelKey: llm.models.modelKey,
			modelsKey: llm.models.modelsKey,
			apiKey: connection.apiKey,
			setApiKey: connection.setApiKey,
			model: llm.models.model,
			setModel: llm.models.setModel,
			models: llm.models.models,
			setModels: llm.models.setModels,
		},
	};
}

/**
 * Every LLM vendor, keyed by its settings id. Insertion order is the order the
 * provider dropdown offers them.
 */
export const LLM_VENDORS: Record<LlmProviderId, LlmVendorDescriptor> = {
	[LLM_PROVIDER_IDS.OPENAI_COMPATIBLE]: {
		...fromRegistry(PROVIDER_IDS.OPENAI),
		rates: OPENAI_RATES,
		create: (config) => new OpenAiCompatibleLlmProvider(config),
	},
	[LLM_PROVIDER_IDS.ANTHROPIC]: {
		...fromRegistry(PROVIDER_IDS.ANTHROPIC),
		rates: ANTHROPIC_RATES,
		create: (config) => new AnthropicLlmProvider(config),
	},
	[LLM_PROVIDER_IDS.GEMINI]: {
		...fromRegistry(PROVIDER_IDS.GEMINI),
		rates: GEMINI_RATES,
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
