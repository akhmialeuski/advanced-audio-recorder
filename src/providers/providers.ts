/**
 * The engine registry: one entry per catalogue of models the plugin can call,
 * and one account per endpoint those calls are made against.
 *
 * An account is one endpoint and one key. An engine is one catalogue of model
 * ids reached through such an account, and what it can be asked to do follows
 * from that catalogue: Whisper ids transcribe, chat ids write, and Gemini ids
 * do both. That is why OpenAI is two engines over one account - whisper-1 and
 * the gpt ids are different families - while Gemini is one engine used for both
 * jobs. Two engines sharing a key is nothing to work around: they name the same
 * account, so it is entered once and read twice.
 *
 * Describing an engine twice, once for transcription and once for
 * post-processing, is what put the same key on two settings rows and kept two
 * endpoints for one account. Behaviour that is genuinely per job - how a
 * dictionary is applied to a speech model, what a chat model costs, which
 * client speaks the wire format - stays with the registry of that job, which
 * reads its identity, its account, and its catalogue from here.
 * @module providers/providers
 */

import {
	ANTHROPIC_MODELS_DOC_URL,
	DEEPGRAM_MODELS_DOC_URL,
	DEFAULT_LLM_ANTHROPIC_BASE_URL,
	DEFAULT_LLM_GEMINI_BASE_URL,
	DEFAULT_LLM_OPENAI_BASE_URL,
	GEMINI_MODELS_DOC_URL,
	LLM_PROVIDER_IDS,
	OPENAI_MODELS_DOC_URL,
	TRANSCRIPTION_PROVIDER_IDS,
	WHISPER_API_MODELS_DOC_URL,
} from '../constants';
import type {
	AudioRecorderSettings,
	LlmProviderId,
	TranscriptionProviderId,
} from '../settings/settingsSchema';

/** Ids of the accounts the plugin holds credentials for. */
export const ACCOUNT_IDS = {
	OPENAI: 'openai',
	DEEPGRAM: 'deepgram',
	GEMINI: 'gemini',
	ANTHROPIC: 'anthropic',
} as const;

/** One account id. */
export type AccountId = (typeof ACCOUNT_IDS)[keyof typeof ACCOUNT_IDS];

/** Ids of the engines, one per catalogue of models. */
export const ENGINE_IDS = {
	WHISPER_API: 'whisper-api',
	OPENAI_LLM: 'openai-llm',
	DEEPGRAM: 'deepgram',
	GEMINI: 'gemini',
	ANTHROPIC: 'anthropic',
	LOCAL_WHISPER: 'local-whisper',
} as const;

/** One engine id. */
export type EngineId = (typeof ENGINE_IDS)[keyof typeof ENGINE_IDS];

/** Description shown under every stored key field. */
const STORED_LOCALLY_DESC =
	'Stored in plugin data on this device. Avoid syncing data.json to untrusted locations.';

/**
 * How an account is reached: one endpoint and one key, whatever the engines
 * behind it are later asked to do.
 */
export interface ProviderConnection {
	/** Settings keys the fields are stored under, for declaring the controls. */
	readonly baseUrlKey: keyof AudioRecorderSettings;
	readonly apiKeyKey: keyof AudioRecorderSettings;
	/** Endpoint the plugin ships as this account's default. */
	readonly defaultBaseUrl: string;
	readonly baseUrl: (settings: AudioRecorderSettings) => string;
	readonly setBaseUrl: (settings: AudioRecorderSettings, url: string) => void;
	readonly apiKey: (settings: AudioRecorderSettings) => string;
	readonly setApiKey: (settings: AudioRecorderSettings, key: string) => void;
	/** Label and description of the base-URL row. */
	readonly baseUrlFieldName: string;
	readonly baseUrlFieldDesc: string;
	/** Label and description of the API-key row. */
	readonly keyFieldName: string;
	readonly keyFieldDesc: string;
	/** What a run says when it is attempted with no key configured. */
	readonly missingKeyMessage: string;
}

/**
 * An engine's model ids: the saved catalogue and the one picked out of it. One
 * catalogue per engine, and one choice, because an engine is that catalogue.
 */
export interface ProviderModels {
	/** Settings keys the choice and the list are stored under. */
	readonly modelKey: keyof AudioRecorderSettings;
	readonly modelsKey: keyof AudioRecorderSettings;
	readonly model: (settings: AudioRecorderSettings) => string;
	readonly setModel: (settings: AudioRecorderSettings, id: string) => void;
	readonly models: (settings: AudioRecorderSettings) => string[];
	readonly setModels: (
		settings: AudioRecorderSettings,
		ids: string[],
	) => void;
	/** Label and description of the row that picks the model. */
	readonly pickerName: string;
	readonly pickerDesc: string;
	/** Catalogue link shown with the list. */
	readonly docLabel: string;
	readonly docUrl: string;
}

/**
 * Everything the plugin knows about one engine. Every engine answers the same
 * questions, and one that has nothing to say answers with a value rather than
 * by leaving the field out: no account is `null`, no catalogue is `null`, and
 * no upload limit is `0`, which reads as "send it whole". A reader can then ask
 * any engine anything without knowing which one it holds.
 */
export interface EngineDescriptor {
	readonly id: EngineId;
	/** Display label, used wherever the engine is named. */
	readonly label: string;
	/** Public pricing page; empty for the free local engine. */
	readonly pricingUrl: string;
	/** Account it is reached through; null for the local engine. */
	readonly account: AccountId | null;
	/** Its models; null for the local engine, which serves no catalogue. */
	readonly models: ProviderModels | null;
	/** The transcription id it is stored under; null when it never transcribes. */
	readonly transcriptionId: TranscriptionProviderId | null;
	/** The vendor id it is stored under; null when it never writes. */
	readonly llmId: LlmProviderId | null;
	/**
	 * Megabytes one request may carry, or 0 where a recording is sent whole
	 * whatever its size. Only an engine with a limit splits an upload, which is
	 * a fact about the engine rather than a setting to hide per provider.
	 */
	readonly uploadLimitMb: number;
}

/** Every account, keyed by id. */
export const ACCOUNTS: Record<AccountId, ProviderConnection> = {
	[ACCOUNT_IDS.OPENAI]: {
		baseUrlKey: 'whisperApiBaseUrl',
		apiKeyKey: 'whisperApiKey',
		defaultBaseUrl: DEFAULT_LLM_OPENAI_BASE_URL,
		baseUrl: (s) => s.whisperApiBaseUrl,
		setBaseUrl: (s, url) => (s.whisperApiBaseUrl = url),
		apiKey: (s) => s.whisperApiKey,
		setApiKey: (s, key) => (s.whisperApiKey = key),
		baseUrlFieldName: 'Base URL',
		baseUrlFieldDesc:
			'OpenAI-compatible endpoint base (e.g. https://api.openai.com/v1 or a Groq URL). Shared by the Whisper API and OpenAI engines.',
		keyFieldName: 'OpenAI API key',
		keyFieldDesc: STORED_LOCALLY_DESC,
		missingKeyMessage: 'Set the OpenAI API key in settings.',
	},
	[ACCOUNT_IDS.DEEPGRAM]: {
		baseUrlKey: 'deepgramBaseUrl',
		apiKeyKey: 'deepgramApiKey',
		defaultBaseUrl: 'https://api.deepgram.com/v1',
		baseUrl: (s) => s.deepgramBaseUrl,
		setBaseUrl: (s, url) => (s.deepgramBaseUrl = url),
		apiKey: (s) => s.deepgramApiKey,
		setApiKey: (s, key) => (s.deepgramApiKey = key),
		baseUrlFieldName: 'Base URL',
		baseUrlFieldDesc:
			'Deepgram API base (default https://api.deepgram.com/v1).',
		keyFieldName: 'Deepgram API key',
		keyFieldDesc: STORED_LOCALLY_DESC,
		missingKeyMessage: 'Set the Deepgram API key in settings.',
	},
	[ACCOUNT_IDS.GEMINI]: {
		baseUrlKey: 'geminiBaseUrl',
		apiKeyKey: 'geminiApiKey',
		defaultBaseUrl: DEFAULT_LLM_GEMINI_BASE_URL,
		baseUrl: (s) => s.geminiBaseUrl,
		setBaseUrl: (s, url) => (s.geminiBaseUrl = url),
		apiKey: (s) => s.geminiApiKey,
		setApiKey: (s, key) => (s.geminiApiKey = key),
		baseUrlFieldName: 'Base URL',
		baseUrlFieldDesc:
			'Gemini API base (default https://generativelanguage.googleapis.com).',
		keyFieldName: 'Google Gemini API key',
		keyFieldDesc: STORED_LOCALLY_DESC,
		missingKeyMessage: 'Set the Google Gemini API key in settings.',
	},
	[ACCOUNT_IDS.ANTHROPIC]: {
		baseUrlKey: 'anthropicBaseUrl',
		apiKeyKey: 'anthropicApiKey',
		defaultBaseUrl: DEFAULT_LLM_ANTHROPIC_BASE_URL,
		baseUrl: (s) => s.anthropicBaseUrl,
		setBaseUrl: (s, url) => (s.anthropicBaseUrl = url),
		apiKey: (s) => s.anthropicApiKey,
		setApiKey: (s, key) => (s.anthropicApiKey = key),
		baseUrlFieldName: 'Base URL',
		baseUrlFieldDesc:
			'Anthropic API base (default https://api.anthropic.com/v1).',
		keyFieldName: 'Anthropic API key',
		keyFieldDesc: STORED_LOCALLY_DESC,
		missingKeyMessage: 'Set the Anthropic API key in settings.',
	},
};

/**
 * Every engine, keyed by id. Insertion order is the order the settings list
 * them and the pickers offer them.
 */
export const ENGINES: Record<EngineId, EngineDescriptor> = {
	[ENGINE_IDS.WHISPER_API]: {
		id: ENGINE_IDS.WHISPER_API,
		label: 'Whisper API (OpenAI-compatible)',
		pricingUrl: 'https://openai.com/api/pricing/',
		account: ACCOUNT_IDS.OPENAI,
		transcriptionId: TRANSCRIPTION_PROVIDER_IDS.WHISPER_API,
		llmId: null,
		// The API refuses a request over 25 MB, so a longer recording is split
		// into chunks under that ceiling and stitched back onto one timeline.
		uploadLimitMb: 25,
		models: {
			modelKey: 'whisperApiModel',
			modelsKey: 'whisperApiModels',
			model: (s) => s.whisperApiModel,
			setModel: (s, id) => (s.whisperApiModel = id),
			models: (s) => s.whisperApiModels,
			setModels: (s, ids) => (s.whisperApiModels = ids),
			pickerName: 'Model',
			pickerDesc:
				'OpenAI: whisper-1. Groq and other hosts: whisper-large-v3, whisper-large-v3-turbo. The model must support verbose_json with timestamps.',
			docLabel: 'Whisper API models',
			docUrl: WHISPER_API_MODELS_DOC_URL,
		},
	},
	[ENGINE_IDS.OPENAI_LLM]: {
		id: ENGINE_IDS.OPENAI_LLM,
		label: 'OpenAI',
		pricingUrl: 'https://openai.com/api/pricing/',
		account: ACCOUNT_IDS.OPENAI,
		transcriptionId: null,
		llmId: LLM_PROVIDER_IDS.OPENAI_COMPATIBLE,
		uploadLimitMb: 0,
		models: {
			modelKey: 'llmOpenAiModel',
			modelsKey: 'llmOpenAiModels',
			model: (s) => s.llmOpenAiModel,
			setModel: (s, id) => (s.llmOpenAiModel = id),
			models: (s) => s.llmOpenAiModels,
			setModels: (s, ids) => (s.llmOpenAiModels = ids),
			pickerName: 'Model',
			pickerDesc:
				'Pick an OpenAI model (e.g. gpt-5.6-sol, gpt-5.6-luna).',
			docLabel: 'OpenAI models',
			docUrl: OPENAI_MODELS_DOC_URL,
		},
	},
	[ENGINE_IDS.DEEPGRAM]: {
		id: ENGINE_IDS.DEEPGRAM,
		label: 'Deepgram',
		pricingUrl: 'https://deepgram.com/pricing',
		account: ACCOUNT_IDS.DEEPGRAM,
		transcriptionId: TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
		llmId: null,
		uploadLimitMb: 0,
		models: {
			modelKey: 'deepgramModel',
			modelsKey: 'deepgramModels',
			model: (s) => s.deepgramModel,
			setModel: (s, id) => (s.deepgramModel = id),
			models: (s) => s.deepgramModels,
			setModels: (s, ids) => (s.deepgramModels = ids),
			pickerName: 'Model',
			pickerDesc:
				'Pick a Deepgram model (e.g. nova-3, nova-2-meeting, enhanced-phonecall). Files up to 2 GB are sent whole for consistent speaker labels.',
			docLabel: 'Deepgram model list',
			docUrl: DEEPGRAM_MODELS_DOC_URL,
		},
	},
	[ENGINE_IDS.GEMINI]: {
		id: ENGINE_IDS.GEMINI,
		label: 'Google Gemini',
		pricingUrl: 'https://ai.google.dev/gemini-api/docs/pricing',
		account: ACCOUNT_IDS.GEMINI,
		// One catalogue for both jobs: the same ids transcribe and write, so a
		// second list over the same account would be that list twice.
		transcriptionId: TRANSCRIPTION_PROVIDER_IDS.GEMINI,
		llmId: LLM_PROVIDER_IDS.GEMINI,
		uploadLimitMb: 0,
		models: {
			modelKey: 'geminiModel',
			modelsKey: 'geminiModels',
			model: (s) => s.geminiModel,
			setModel: (s, id) => (s.geminiModel = id),
			models: (s) => s.geminiModels,
			setModels: (s, ids) => (s.geminiModels = ids),
			pickerName: 'Model',
			pickerDesc:
				'Pick a Gemini model (e.g. gemini-3.5-flash, gemini-2.5-pro). Used for transcription and for the post-processing prompts alike; a recording is uploaded via the File API for consistent speaker labels.',
			docLabel: 'Gemini model list',
			docUrl: GEMINI_MODELS_DOC_URL,
		},
	},
	[ENGINE_IDS.ANTHROPIC]: {
		id: ENGINE_IDS.ANTHROPIC,
		label: 'Anthropic (Claude)',
		pricingUrl: 'https://www.anthropic.com/pricing',
		account: ACCOUNT_IDS.ANTHROPIC,
		transcriptionId: null,
		llmId: LLM_PROVIDER_IDS.ANTHROPIC,
		uploadLimitMb: 0,
		models: {
			modelKey: 'llmAnthropicModel',
			modelsKey: 'llmAnthropicModels',
			model: (s) => s.llmAnthropicModel,
			setModel: (s, id) => (s.llmAnthropicModel = id),
			models: (s) => s.llmAnthropicModels,
			setModels: (s, ids) => (s.llmAnthropicModels = ids),
			pickerName: 'Model',
			pickerDesc:
				'Pick an Anthropic model (e.g. claude-opus-4-8, claude-sonnet-5).',
			docLabel: 'Anthropic models',
			docUrl: ANTHROPIC_MODELS_DOC_URL,
		},
	},
	[ENGINE_IDS.LOCAL_WHISPER]: {
		id: ENGINE_IDS.LOCAL_WHISPER,
		label: 'Local whisper.cpp (desktop)',
		// Runs on the user's machine: no account, no catalogue, no rate card,
		// and a file it reads from disk rather than uploads.
		pricingUrl: '',
		account: null,
		models: null,
		transcriptionId: TRANSCRIPTION_PROVIDER_IDS.LOCAL_WHISPER,
		llmId: null,
		uploadLimitMb: 0,
	},
};

/** Every engine id, in the order the settings list them. */
export const ENGINE_ORDER = Object.keys(ENGINES) as EngineId[];

/**
 * The engine a transcription id belongs to.
 * @param transcriptionId - Id stored in the transcription settings
 * @returns The engine, or undefined for an id no engine claims
 */
export function engineOfTranscription(
	transcriptionId: TranscriptionProviderId,
): EngineDescriptor | undefined {
	return ENGINE_ORDER.map((id) => ENGINES[id]).find(
		(engine) => engine.transcriptionId === transcriptionId,
	);
}

/**
 * The engine an LLM vendor id belongs to.
 * @param vendorId - Id stored in the post-processing settings
 * @returns The engine, or undefined for an id no engine claims
 */
export function engineOfVendor(
	vendorId: LlmProviderId,
): EngineDescriptor | undefined {
	return ENGINE_ORDER.map((id) => ENGINES[id]).find(
		(engine) => engine.llmId === vendorId,
	);
}

/**
 * The account an engine is reached through.
 * @param engine - The engine being reached
 * @returns Its account, or undefined for the local engine
 */
export function accountOf(
	engine: EngineDescriptor,
): ProviderConnection | undefined {
	return engine.account ? ACCOUNTS[engine.account] : undefined;
}

/**
 * The account of the engine an LLM vendor id belongs to. Every vendor has one,
 * which is what lets a post-processing run be built without knowing which
 * settings fields the endpoint and the key live in.
 * @param vendorId - Id stored in the post-processing settings
 * @returns That engine's account
 */
export function vendorConnection(vendorId: LlmProviderId): ProviderConnection {
	const engine = engineOfVendor(vendorId);
	const connection = engine && accountOf(engine);
	if (!connection) {
		throw new Error(`No account declared for LLM vendor "${vendorId}"`);
	}
	return connection;
}
