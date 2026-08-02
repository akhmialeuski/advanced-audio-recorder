/**
 * The provider registry: one entry per external service the plugin talks to,
 * holding how it is reached and what it can be asked to do.
 *
 * A service is one account with one endpoint and one key, and some services
 * answer more than one kind of request: Gemini and OpenAI transcribe audio and
 * also run the post-processing prompts, while Deepgram only transcribes and
 * Anthropic only writes. Describing that twice - once for transcription and
 * once for post-processing - is what put the same Gemini key on two settings
 * rows and kept two base URLs for one endpoint. Here a provider is declared
 * once: its connection is the single source of truth for the endpoint and the
 * key, and each capability adds only what is specific to it, namely the model
 * catalogue that use picks from.
 *
 * Behaviour that is genuinely per capability - how a dictionary is applied to a
 * speech model, what a chat model costs, which client speaks the wire format -
 * stays with the capability's own registry, which reads its identity and its
 * connection from here rather than restating them.
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

/** Ids of the services the plugin knows how to reach. */
export const PROVIDER_IDS = {
	OPENAI: 'openai',
	DEEPGRAM: 'deepgram',
	GEMINI: 'gemini',
	ANTHROPIC: 'anthropic',
	LOCAL_WHISPER: 'local-whisper',
} as const;

/** One provider id. */
export type ProviderId = (typeof PROVIDER_IDS)[keyof typeof PROVIDER_IDS];

/** Description shown under every stored key field. */
const STORED_LOCALLY_DESC =
	'Stored in plugin data on this device. Avoid syncing data.json to untrusted locations.';

/**
 * How the plugin reaches a provider. One endpoint and one key per service,
 * whatever the request is for, so both capabilities read the same fields and a
 * key is entered once.
 */
export interface ProviderConnection {
	/** Settings keys the fields are stored under, for declaring the controls. */
	readonly baseUrlKey: keyof AudioRecorderSettings;
	readonly apiKeyKey: keyof AudioRecorderSettings;
	/** Endpoint the plugin ships as this provider's default. */
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
 * The saved model ids one capability of a provider picks from. Speech models
 * and chat models are different catalogues even where one service serves both,
 * so each capability keeps its own.
 */
export interface ProviderModels {
	/** Settings keys the selection and the list are stored under. */
	readonly modelKey: keyof AudioRecorderSettings;
	readonly modelsKey: keyof AudioRecorderSettings;
	readonly model: (settings: AudioRecorderSettings) => string;
	readonly setModel: (settings: AudioRecorderSettings, id: string) => void;
	readonly models: (settings: AudioRecorderSettings) => string[];
	readonly setModels: (
		settings: AudioRecorderSettings,
		ids: string[],
	) => void;
	/** Label and description of the entry that opens the catalogue. */
	readonly pickerName: string;
	readonly pickerDesc: string;
	/** Catalogue link shown with the list. */
	readonly docLabel: string;
	readonly docUrl: string;
}

/** Everything the plugin knows about one provider. */
export interface ProviderDescriptor {
	readonly id: ProviderId;
	/** Display label, used wherever a provider is named. */
	readonly label: string;
	/** Public pricing page; absent for the free local engine. */
	readonly pricingUrl?: string;
	/** Endpoint and key; absent for the local engine, which runs a binary. */
	readonly connection?: ProviderConnection;
	/** Set when this provider transcribes: the id it is stored under. */
	readonly transcription?: {
		readonly engineId: TranscriptionProviderId;
		/** Absent for the local engine, which has no served catalogue. */
		readonly models?: ProviderModels;
	};
	/** Set when this provider answers prompts: the id it is stored under. */
	readonly llm?: {
		readonly vendorId: LlmProviderId;
		readonly models: ProviderModels;
	};
}

/**
 * Every provider, keyed by id. Insertion order is the order they are listed in
 * the settings and offered in the pickers.
 */
export const PROVIDERS: Record<ProviderId, ProviderDescriptor> = {
	[PROVIDER_IDS.OPENAI]: {
		id: PROVIDER_IDS.OPENAI,
		label: 'OpenAI',
		pricingUrl: 'https://openai.com/api/pricing/',
		connection: {
			baseUrlKey: 'whisperApiBaseUrl',
			apiKeyKey: 'whisperApiKey',
			defaultBaseUrl: DEFAULT_LLM_OPENAI_BASE_URL,
			baseUrl: (s) => s.whisperApiBaseUrl,
			setBaseUrl: (s, url) => (s.whisperApiBaseUrl = url),
			apiKey: (s) => s.whisperApiKey,
			setApiKey: (s, key) => (s.whisperApiKey = key),
			baseUrlFieldName: 'Whisper API base URL',
			baseUrlFieldDesc:
				'OpenAI-compatible endpoint base (e.g. https://api.openai.com/v1 or a Groq URL).',
			keyFieldName: 'Whisper API key',
			keyFieldDesc: STORED_LOCALLY_DESC,
			missingKeyMessage: 'Set the OpenAI API key in settings.',
		},
		transcription: {
			engineId: TRANSCRIPTION_PROVIDER_IDS.WHISPER_API,
			models: {
				modelKey: 'whisperApiModel',
				modelsKey: 'whisperApiModels',
				model: (s) => s.whisperApiModel,
				setModel: (s, id) => (s.whisperApiModel = id),
				models: (s) => s.whisperApiModels,
				setModels: (s, ids) => (s.whisperApiModels = ids),
				pickerName: 'Whisper model',
				pickerDesc:
					'OpenAI: whisper-1. Groq and other hosts: whisper-large-v3, whisper-large-v3-turbo. The model must support verbose_json with timestamps.',
				docLabel: 'Whisper API models',
				docUrl: WHISPER_API_MODELS_DOC_URL,
			},
		},
		llm: {
			vendorId: LLM_PROVIDER_IDS.OPENAI_COMPATIBLE,
			models: {
				modelKey: 'llmOpenAiModel',
				modelsKey: 'llmOpenAiModels',
				model: (s) => s.llmOpenAiModel,
				setModel: (s, id) => (s.llmOpenAiModel = id),
				models: (s) => s.llmOpenAiModels,
				setModels: (s, ids) => (s.llmOpenAiModels = ids),
				pickerName: 'LLM model',
				pickerDesc:
					'Pick an OpenAI model (e.g. gpt-5.6-sol, gpt-5.6-luna).',
				docLabel: 'OpenAI models',
				docUrl: OPENAI_MODELS_DOC_URL,
			},
		},
	},
	[PROVIDER_IDS.DEEPGRAM]: {
		id: PROVIDER_IDS.DEEPGRAM,
		label: 'Deepgram',
		pricingUrl: 'https://deepgram.com/pricing',
		connection: {
			baseUrlKey: 'deepgramBaseUrl',
			apiKeyKey: 'deepgramApiKey',
			defaultBaseUrl: 'https://api.deepgram.com/v1',
			baseUrl: (s) => s.deepgramBaseUrl,
			setBaseUrl: (s, url) => (s.deepgramBaseUrl = url),
			apiKey: (s) => s.deepgramApiKey,
			setApiKey: (s, key) => (s.deepgramApiKey = key),
			baseUrlFieldName: 'Deepgram base URL',
			baseUrlFieldDesc:
				'Deepgram API base (default https://api.deepgram.com/v1).',
			keyFieldName: 'Deepgram API key',
			keyFieldDesc: STORED_LOCALLY_DESC,
			missingKeyMessage: 'Set the Deepgram API key in settings.',
		},
		transcription: {
			engineId: TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
			models: {
				modelKey: 'deepgramModel',
				modelsKey: 'deepgramModels',
				model: (s) => s.deepgramModel,
				setModel: (s, id) => (s.deepgramModel = id),
				models: (s) => s.deepgramModels,
				setModels: (s, ids) => (s.deepgramModels = ids),
				pickerName: 'Deepgram model',
				pickerDesc:
					'Pick a Deepgram model (e.g. nova-3, nova-2-meeting, enhanced-phonecall). Files up to 2 GB are sent whole for consistent speaker labels.',
				docLabel: 'Deepgram model list',
				docUrl: DEEPGRAM_MODELS_DOC_URL,
			},
		},
	},
	[PROVIDER_IDS.GEMINI]: {
		id: PROVIDER_IDS.GEMINI,
		label: 'Google Gemini',
		pricingUrl: 'https://ai.google.dev/gemini-api/docs/pricing',
		connection: {
			baseUrlKey: 'geminiBaseUrl',
			apiKeyKey: 'geminiApiKey',
			defaultBaseUrl: DEFAULT_LLM_GEMINI_BASE_URL,
			baseUrl: (s) => s.geminiBaseUrl,
			setBaseUrl: (s, url) => (s.geminiBaseUrl = url),
			apiKey: (s) => s.geminiApiKey,
			setApiKey: (s, key) => (s.geminiApiKey = key),
			baseUrlFieldName: 'Gemini base URL',
			baseUrlFieldDesc:
				'Gemini API base (default https://generativelanguage.googleapis.com).',
			keyFieldName: 'Gemini API key',
			keyFieldDesc: STORED_LOCALLY_DESC,
			missingKeyMessage: 'Set the Google Gemini API key in settings.',
		},
		transcription: {
			engineId: TRANSCRIPTION_PROVIDER_IDS.GEMINI,
			models: {
				modelKey: 'geminiModel',
				modelsKey: 'geminiModels',
				model: (s) => s.geminiModel,
				setModel: (s, id) => (s.geminiModel = id),
				models: (s) => s.geminiModels,
				setModels: (s, ids) => (s.geminiModels = ids),
				pickerName: 'Gemini model',
				pickerDesc:
					'Pick a Gemini model (e.g. gemini-3.5-flash, gemini-2.5-pro). The whole recording is uploaded via the File API for consistent speaker labels.',
				docLabel: 'Gemini model list',
				docUrl: GEMINI_MODELS_DOC_URL,
			},
		},
		llm: {
			vendorId: LLM_PROVIDER_IDS.GEMINI,
			models: {
				modelKey: 'llmGeminiModel',
				modelsKey: 'llmGeminiModels',
				model: (s) => s.llmGeminiModel,
				setModel: (s, id) => (s.llmGeminiModel = id),
				models: (s) => s.llmGeminiModels,
				setModels: (s, ids) => (s.llmGeminiModels = ids),
				pickerName: 'LLM model',
				pickerDesc:
					'Pick a Gemini model (e.g. gemini-3.5-flash, gemini-2.5-pro).',
				docLabel: 'Gemini model list',
				docUrl: GEMINI_MODELS_DOC_URL,
			},
		},
	},
	[PROVIDER_IDS.ANTHROPIC]: {
		id: PROVIDER_IDS.ANTHROPIC,
		label: 'Anthropic (Claude)',
		pricingUrl: 'https://www.anthropic.com/pricing',
		connection: {
			baseUrlKey: 'anthropicBaseUrl',
			apiKeyKey: 'anthropicApiKey',
			defaultBaseUrl: DEFAULT_LLM_ANTHROPIC_BASE_URL,
			baseUrl: (s) => s.anthropicBaseUrl,
			setBaseUrl: (s, url) => (s.anthropicBaseUrl = url),
			apiKey: (s) => s.anthropicApiKey,
			setApiKey: (s, key) => (s.anthropicApiKey = key),
			baseUrlFieldName: 'Anthropic base URL',
			baseUrlFieldDesc:
				'Anthropic API base (default https://api.anthropic.com/v1).',
			keyFieldName: 'Anthropic API key',
			keyFieldDesc: STORED_LOCALLY_DESC,
			missingKeyMessage: 'Set the Anthropic API key in settings.',
		},
		llm: {
			vendorId: LLM_PROVIDER_IDS.ANTHROPIC,
			models: {
				modelKey: 'llmAnthropicModel',
				modelsKey: 'llmAnthropicModels',
				model: (s) => s.llmAnthropicModel,
				setModel: (s, id) => (s.llmAnthropicModel = id),
				models: (s) => s.llmAnthropicModels,
				setModels: (s, ids) => (s.llmAnthropicModels = ids),
				pickerName: 'LLM model',
				pickerDesc:
					'Pick an Anthropic model (e.g. claude-opus-4-8, claude-sonnet-5).',
				docLabel: 'Anthropic models',
				docUrl: ANTHROPIC_MODELS_DOC_URL,
			},
		},
	},
	[PROVIDER_IDS.LOCAL_WHISPER]: {
		id: PROVIDER_IDS.LOCAL_WHISPER,
		label: 'Local whisper.cpp (desktop)',
		// Runs on the user's machine: no endpoint, no key, no rate card.
		transcription: {
			engineId: TRANSCRIPTION_PROVIDER_IDS.LOCAL_WHISPER,
		},
	},
};

/** Every provider id, in the order the settings list them. */
export const PROVIDER_ORDER = Object.keys(PROVIDERS) as ProviderId[];

/**
 * The provider a transcription engine id belongs to.
 * @param engineId - Id stored in the transcription settings
 * @returns The provider, or undefined for an id no provider claims
 */
export function providerOfEngine(
	engineId: TranscriptionProviderId,
): ProviderDescriptor | undefined {
	return PROVIDER_ORDER.map((id) => PROVIDERS[id]).find(
		(provider) => provider.transcription?.engineId === engineId,
	);
}

/**
 * The provider an LLM vendor id belongs to.
 * @param vendorId - Id stored in the post-processing settings
 * @returns The provider, or undefined for an id no provider claims
 */
export function providerOfVendor(
	vendorId: LlmProviderId,
): ProviderDescriptor | undefined {
	return PROVIDER_ORDER.map((id) => PROVIDERS[id]).find(
		(provider) => provider.llm?.vendorId === vendorId,
	);
}

/**
 * The connection of the provider an LLM vendor id belongs to. Every vendor has
 * one, which is what lets a post-processing run be built without knowing which
 * settings fields the endpoint and the key live in.
 * @param vendorId - Id stored in the post-processing settings
 * @returns That provider's connection
 */
export function vendorConnection(vendorId: LlmProviderId): ProviderConnection {
	const connection = providerOfVendor(vendorId)?.connection;
	if (!connection) {
		throw new Error(`No connection declared for LLM vendor "${vendorId}"`);
	}
	return connection;
}

/**
 * The connection of the provider a transcription engine id belongs to, or
 * undefined for the local engine, which runs a binary instead of a service.
 * @param engineId - Id stored in the transcription settings
 */
export function engineConnection(
	engineId: TranscriptionProviderId,
): ProviderConnection | undefined {
	return providerOfEngine(engineId)?.connection;
}
