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
	GEMINI_MODELS_DOC_URL,
	LLM_PROVIDER_IDS,
	OPENAI_MODELS_DOC_URL,
	TRANSCRIPTION_PROVIDER_IDS,
	WHISPER_API_MODELS_DOC_URL,
} from '../constants';
import type {
	AudioRecorderSettings,
	LlmProviderId,
	PrimitiveSettingKey,
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
	readonly baseUrlKey: PrimitiveSettingKey;
	readonly apiKeyKey: PrimitiveSettingKey;
	readonly baseUrl: (settings: AudioRecorderSettings) => string;
	readonly setBaseUrl: (settings: AudioRecorderSettings, url: string) => void;
	readonly apiKey: (settings: AudioRecorderSettings) => string;
	readonly setApiKey: (settings: AudioRecorderSettings, key: string) => void;
	/**
	 * What the base-URL row says about this endpoint. Only the description: the
	 * row is called "Base URL" on every account, which makes the label a fact
	 * of the row rather than of the account.
	 */
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
	readonly modelKey: PrimitiveSettingKey;
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
	/**
	 * Where this engine's chunk size is stored, or null where it never splits.
	 * Named per engine rather than assumed, so a second engine with a limit
	 * cannot end up sharing the first one's field by accident.
	 */
	readonly uploadChunk: EngineNumericField | null;
	/**
	 * Where the longest answer this engine may write is stored, or null for one
	 * that writes nothing. A ceiling belongs to the engine that honours it, not
	 * to a job that calls it.
	 */
	readonly maxTokens: EngineNumericField | null;
}

/**
 * Where one number an engine owns is stored, and how it is read and written.
 * The answer ceiling and the upload chunk size are the same shape, so they are
 * declared as one: a reader that can move either can move both.
 */
export interface EngineNumericField {
	readonly key: PrimitiveSettingKey;
	readonly get: (settings: AudioRecorderSettings) => number;
	readonly set: (settings: AudioRecorderSettings, value: number) => void;
}

/** Every account, keyed by id. */
export const ACCOUNTS: Record<AccountId, ProviderConnection> = {
	[ACCOUNT_IDS.OPENAI]: {
		baseUrlKey: 'whisperApiBaseUrl',
		apiKeyKey: 'whisperApiKey',
		baseUrl: (s) => s.whisperApiBaseUrl,
		setBaseUrl: (s, url) => (s.whisperApiBaseUrl = url),
		apiKey: (s) => s.whisperApiKey,
		setApiKey: (s, key) => (s.whisperApiKey = key),
		baseUrlFieldDesc:
			'OpenAI-compatible endpoint base (e.g. https://api.openai.com/v1 or a Groq URL). Shared by the Whisper API and OpenAI engines.',
		keyFieldName: 'OpenAI API key',
		keyFieldDesc: STORED_LOCALLY_DESC,
		missingKeyMessage: 'Set the OpenAI API key in settings.',
	},
	[ACCOUNT_IDS.DEEPGRAM]: {
		baseUrlKey: 'deepgramBaseUrl',
		apiKeyKey: 'deepgramApiKey',
		baseUrl: (s) => s.deepgramBaseUrl,
		setBaseUrl: (s, url) => (s.deepgramBaseUrl = url),
		apiKey: (s) => s.deepgramApiKey,
		setApiKey: (s, key) => (s.deepgramApiKey = key),
		baseUrlFieldDesc:
			'Deepgram API base (default https://api.deepgram.com/v1).',
		keyFieldName: 'Deepgram API key',
		keyFieldDesc: STORED_LOCALLY_DESC,
		missingKeyMessage: 'Set the Deepgram API key in settings.',
	},
	[ACCOUNT_IDS.GEMINI]: {
		baseUrlKey: 'geminiBaseUrl',
		apiKeyKey: 'geminiApiKey',
		baseUrl: (s) => s.geminiBaseUrl,
		setBaseUrl: (s, url) => (s.geminiBaseUrl = url),
		apiKey: (s) => s.geminiApiKey,
		setApiKey: (s, key) => (s.geminiApiKey = key),
		baseUrlFieldDesc:
			'Gemini API base (default https://generativelanguage.googleapis.com).',
		keyFieldName: 'Google Gemini API key',
		keyFieldDesc: STORED_LOCALLY_DESC,
		missingKeyMessage: 'Set the Google Gemini API key in settings.',
	},
	[ACCOUNT_IDS.ANTHROPIC]: {
		baseUrlKey: 'anthropicBaseUrl',
		apiKeyKey: 'anthropicApiKey',
		baseUrl: (s) => s.anthropicBaseUrl,
		setBaseUrl: (s, url) => (s.anthropicBaseUrl = url),
		apiKey: (s) => s.anthropicApiKey,
		setApiKey: (s, key) => (s.anthropicApiKey = key),
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
		uploadChunk: {
			key: 'transcriptionChunkMb',
			get: (settings) => settings.transcriptionChunkMb,
			set: (settings, value) => (settings.transcriptionChunkMb = value),
		},
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
		maxTokens: null,
	},
	[ENGINE_IDS.OPENAI_LLM]: {
		id: ENGINE_IDS.OPENAI_LLM,
		label: 'OpenAI',
		pricingUrl: 'https://openai.com/api/pricing/',
		account: ACCOUNT_IDS.OPENAI,
		transcriptionId: null,
		llmId: LLM_PROVIDER_IDS.OPENAI_COMPATIBLE,
		uploadLimitMb: 0,
		uploadChunk: null,
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
		maxTokens: {
			key: 'llmOpenAiMaxTokens',
			get: (settings) => settings.llmOpenAiMaxTokens,
			set: (settings, value) => (settings.llmOpenAiMaxTokens = value),
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
		uploadChunk: null,
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
		maxTokens: null,
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
		uploadChunk: null,
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
		maxTokens: {
			key: 'geminiMaxTokens',
			get: (settings) => settings.geminiMaxTokens,
			set: (settings, value) => (settings.geminiMaxTokens = value),
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
		uploadChunk: null,
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
		maxTokens: {
			key: 'llmAnthropicMaxTokens',
			get: (settings) => settings.llmAnthropicMaxTokens,
			set: (settings, value) => (settings.llmAnthropicMaxTokens = value),
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
		uploadChunk: null,
		maxTokens: null,
	},
};

/** Every engine id, in the order the settings list them. */
export const ENGINE_ORDER = Object.keys(ENGINES) as EngineId[];

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
 * The engine an LLM vendor id names.
 *
 * Every vendor is the prompt-answering side of an engine, which is what lets a
 * job's model be moved without the caller knowing which catalogue holds it.
 * @param vendorId - Id stored for the job being configured
 * @returns That engine
 * @throws Error when no engine claims the id
 */
export function vendorEngine(vendorId: LlmProviderId): EngineDescriptor {
	const engine = engineOfVendor(vendorId);
	if (!engine) {
		throw new Error(`No engine declared for LLM vendor "${vendorId}"`);
	}
	return engine;
}

/**
 * The engine a transcription id names.
 * @param transcriptionId - Id stored in the transcription settings
 * @returns That engine, or undefined for an id no engine claims
 */
export function engineOfTranscription(
	transcriptionId: TranscriptionProviderId,
): EngineDescriptor | undefined {
	return ENGINE_ORDER.map((id) => ENGINES[id]).find(
		(engine) => engine.transcriptionId === transcriptionId,
	);
}

/**
 * The account transcription is actually reached through, as the settings stand.
 *
 * Not the same question as whether an account can transcribe. An account that
 * serves a speech engine nobody selected is, for the configuration in front of
 * you, a prompt-answering account and nothing else - and a caller deciding
 * whether some other feature may write its endpoint has to ask about the
 * configuration rather than about the catalogue.
 * @param settings - Plugin settings
 * @returns That account's id, or null when transcription needs no account
 */
export function transcribingAccount(
	settings: AudioRecorderSettings,
): AccountId | null {
	return (
		engineOfTranscription(settings.transcriptionProvider)?.account ?? null
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
 * Every engine reached through one account, in registry order.
 * @param account - The account being asked about
 * @returns The engines behind it
 */
export function enginesOfAccount(account: AccountId): EngineDescriptor[] {
	return ENGINE_ORDER.map((id) => ENGINES[id]).filter(
		(engine) => engine.account === account,
	);
}

/**
 * Whether anything transcribes through an account.
 *
 * An account is one endpoint, and what that endpoint has to serve follows from
 * the engines behind it: where one of them transcribes, the endpoint is a
 * transcription endpoint whatever else it also answers. A caller about to write
 * one on some other feature's behalf has to know that, because a host that
 * answers prompts is not thereby a host that accepts audio.
 * @param account - The account being asked about
 */
export function accountTranscribes(account: AccountId): boolean {
	return enginesOfAccount(account).some((engine) => engine.transcriptionId);
}

/** An engine together with the account and catalogue it declares. */
export interface EngineAccess {
	readonly engine: EngineDescriptor;
	readonly account: ProviderConnection;
	readonly models: ProviderModels;
}

/**
 * An engine that is reached over the network, with the two things such an
 * engine always has: the account it is called through and the catalogue it
 * serves. Both job registries and the run that builds a client ask for the same
 * pair, so the "an engine with an endpoint has a catalogue too" check lives
 * here rather than once per reader.
 * @param id - The engine being resolved
 * @returns Its descriptor, account, and catalogue
 * @throws Error when the id names the local engine, which has neither
 */
export function engineAccess(id: EngineId): EngineAccess {
	const engine = ENGINES[id];
	const account = accountOf(engine);
	if (!account || !engine.models) {
		throw new Error(`Engine "${id}" is not reached over an account`);
	}
	return { engine, account, models: engine.models };
}

/**
 * What a run says when it is attempted with no model picked. Derived from the
 * engine's own label, so an engine added to the registry arrives with the
 * message rather than needing a string of its own.
 * @param engine - The engine whose catalogue is empty
 */
export function missingModelMessage(engine: EngineDescriptor): string {
	return `Pick a model for ${engine.label} in settings.`;
}

/**
 * The account of the engine an LLM vendor id belongs to. Every vendor has one,
 * which is what lets a post-processing run be built without knowing which
 * settings fields the endpoint and the key live in.
 * @param vendorId - Id stored in the post-processing settings
 * @returns That engine's account
 */
export function vendorConnection(vendorId: LlmProviderId): ProviderConnection {
	const connection = accountOf(vendorEngine(vendorId));
	if (!connection) {
		throw new Error(`No account declared for LLM vendor "${vendorId}"`);
	}
	return connection;
}

/**
 * The longest answer the engine behind a vendor id may write.
 * @param settings - Plugin settings
 * @param vendorId - Id stored for the job being run
 * @returns That engine's ceiling, or 0 when it declares none
 */
export function vendorMaxTokens(
	settings: AudioRecorderSettings,
	vendorId: LlmProviderId,
): number {
	const maxTokens = engineOfVendor(vendorId)?.maxTokens;
	return maxTokens ? maxTokens.get(settings) : 0;
}
