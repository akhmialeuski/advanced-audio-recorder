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
	ENGINE_IDS,
	engineAccess,
	missingModelMessage,
	type EngineId,
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

/**
 * What post-processing knows about one LLM vendor beyond the provider registry.
 *
 * Everything about the service itself - its endpoint, its key, the catalogue it
 * serves, and the copy of the rows that configure it - belongs to
 * {@link module:providers/providers} and is read from there. What is left here
 * is what only this job knows: what a chat model costs, and which client speaks
 * the vendor's wire format.
 */
export interface LlmVendorDescriptor {
	readonly id: LlmProviderId;
	/** Display label, used in dropdowns and cost-estimate lines. */
	readonly label: string;
	/** Public pricing page, linked from the cost estimate. */
	readonly pricingUrl: string;
	/** Error shown when a run is attempted with no key configured. */
	readonly missingKeyMessage: string;
	/** Error shown when a run is attempted with no model picked. */
	readonly missingModelMessage: string;
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
 * The half of a vendor that belongs to the service rather than to this job: how
 * it is named, how it is reached, and the catalogue its models come from. Read
 * from the provider registry, so a service that also transcribes declares them
 * once and both uses reach the same fields.
 * @param id - Engine the vendor is the prompt-answering side of
 * @returns That engine's half of the descriptor
 */
function fromRegistry(
	id: EngineId,
): Omit<LlmVendorDescriptor, 'rates' | 'create'> {
	const { engine, account, models } = engineAccess(id);
	if (!engine.llmId) {
		throw new Error(`Engine "${id}" answers no prompts`);
	}
	return {
		id: engine.llmId,
		label: engine.label,
		pricingUrl: engine.pricingUrl,
		missingKeyMessage: account.missingKeyMessage,
		missingModelMessage: missingModelMessage(engine),
		settings: {
			apiKey: account.apiKey,
			setApiKey: account.setApiKey,
			model: models.model,
			setModel: models.setModel,
			models: models.models,
			setModels: models.setModels,
		},
	};
}

/**
 * Every LLM vendor, keyed by its settings id. Insertion order is the order the
 * provider dropdown offers them.
 */
export const LLM_VENDORS: Record<LlmProviderId, LlmVendorDescriptor> = {
	[LLM_PROVIDER_IDS.OPENAI_COMPATIBLE]: {
		...fromRegistry(ENGINE_IDS.OPENAI_LLM),
		rates: OPENAI_RATES,
		create: (config) => new OpenAiCompatibleLlmProvider(config),
	},
	[LLM_PROVIDER_IDS.ANTHROPIC]: {
		...fromRegistry(ENGINE_IDS.ANTHROPIC),
		rates: ANTHROPIC_RATES,
		create: (config) => new AnthropicLlmProvider(config),
	},
	[LLM_PROVIDER_IDS.GEMINI]: {
		...fromRegistry(ENGINE_IDS.GEMINI),
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
 * The jobs that drive an LLM. Each one picks its own engine, so a run can
 * summarize with one service and title its chapters with another.
 */
export type LlmJobId = 'postProcess' | 'contextAgents' | 'autoChapters';

/** Where one job's engine choice is stored. */
export interface LlmJob {
	/** Settings key the choice lives under, for declaring the control. */
	readonly key: keyof AudioRecorderSettings;
	/** The engine the job calls, as the settings currently name it. */
	readonly vendor: (settings: AudioRecorderSettings) => LlmProviderId;
}

/**
 * Every job and the field naming its engine, declared once.
 *
 * Three readers have to agree on that engine: the factory that builds the
 * provider, the ceiling that bounds its answer, and the cost model that prices
 * the call. Each of them used to read `llmProvider` directly, so a job pointed
 * at another engine was dispatched to the post-processing one and merely
 * bounded and priced inconsistently. They read this instead, and the settings
 * declare their rows from the same keys, so a job cannot be configured in one
 * place and run in another.
 */
export const LLM_JOBS: Record<LlmJobId, LlmJob> = {
	postProcess: {
		key: 'llmProvider',
		vendor: (settings) => settings.llmProvider,
	},
	contextAgents: {
		key: 'advancedLlmProvider',
		vendor: (settings) => settings.advancedLlmProvider,
	},
	autoChapters: {
		key: 'chaptersLlmProvider',
		vendor: (settings) => settings.chaptersLlmProvider,
	},
};

/**
 * The engine a job calls.
 * @param settings - Plugin settings
 * @param job - The job about to run
 * @returns Its vendor id
 */
export function jobVendorId(
	settings: AudioRecorderSettings,
	job: LlmJobId,
): LlmProviderId {
	return LLM_JOBS[job].vendor(settings);
}

/**
 * The descriptor of the engine a job calls.
 * @param settings - Plugin settings
 * @param job - The job about to run
 * @returns That engine's vendor descriptor
 */
export function jobLlmVendor(
	settings: AudioRecorderSettings,
	job: LlmJobId,
): LlmVendorDescriptor {
	return llmVendor(jobVendorId(settings, job));
}
