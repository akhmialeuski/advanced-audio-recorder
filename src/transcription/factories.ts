/**
 * Builds transcription and LLM providers from plugin settings, keeping
 * provider construction (and its validation) out of the UI and service.
 * @module transcription/factories
 */

import { LLM_PROVIDER_IDS, TRANSCRIPTION_PROVIDER_IDS } from '../constants';
import type { AudioRecorderSettings } from '../settings/Settings';
import { WhisperApiProvider } from './providers/WhisperApiProvider';
import { LocalWhisperProvider } from './providers/LocalWhisperProvider';
import { DeepgramProvider } from './providers/DeepgramProvider';
import { GeminiProvider } from './providers/GeminiProvider';
import type { TranscriptionProvider } from './providers/TranscriptionProvider';
import {
	AnthropicLlmProvider,
	GeminiLlmProvider,
	OpenAiCompatibleLlmProvider,
	type LlmProvider,
} from './llm/LlmProvider';

/** Error raised when settings are insufficient to build a provider. */
export class ProviderConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ProviderConfigError';
	}
}

/**
 * Builds the configured transcription provider, validating required
 * fields and platform support.
 * @param settings - Plugin settings
 */
export function createTranscriptionProvider(
	settings: AudioRecorderSettings,
): TranscriptionProvider {
	if (
		settings.transcriptionProvider ===
		TRANSCRIPTION_PROVIDER_IDS.LOCAL_WHISPER
	) {
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
	}
	if (
		settings.transcriptionProvider === TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM
	) {
		if (!settings.deepgramApiKey) {
			throw new ProviderConfigError(
				'Set the Deepgram API key in settings to transcribe.',
			);
		}
		return new DeepgramProvider({
			baseUrl: settings.deepgramBaseUrl,
			apiKey: settings.deepgramApiKey,
			model: settings.deepgramModel,
		});
	}
	if (settings.transcriptionProvider === TRANSCRIPTION_PROVIDER_IDS.GEMINI) {
		if (!settings.geminiApiKey) {
			throw new ProviderConfigError(
				'Set the Google Gemini API key in settings to transcribe.',
			);
		}
		return new GeminiProvider({
			baseUrl: settings.geminiBaseUrl,
			apiKey: settings.geminiApiKey,
			model: settings.geminiModel,
		});
	}
	if (!settings.whisperApiKey) {
		throw new ProviderConfigError(
			'Set the Whisper API key in settings to transcribe.',
		);
	}
	return new WhisperApiProvider({
		baseUrl: settings.whisperApiBaseUrl,
		apiKey: settings.whisperApiKey,
		model: settings.whisperApiModel,
	});
}

/**
 * Builds the configured LLM post-processing provider. The API key is the
 * shared per-vendor key (OpenAI reuses the Whisper API key, Gemini reuses the
 * Gemini transcription key, Anthropic uses its own), and the model is the
 * provider's own selected id. Every provider requires a key.
 * @param settings - Plugin settings
 */
export function createLlmProvider(
	settings: AudioRecorderSettings,
): LlmProvider {
	const baseUrl = settings.llmBaseUrl;
	if (settings.llmProvider === LLM_PROVIDER_IDS.ANTHROPIC) {
		if (!settings.anthropicApiKey) {
			throw new ProviderConfigError(
				'Set the Anthropic API key in settings.',
			);
		}
		return new AnthropicLlmProvider({
			baseUrl,
			apiKey: settings.anthropicApiKey,
			model: settings.llmAnthropicModel,
		});
	}
	if (settings.llmProvider === LLM_PROVIDER_IDS.GEMINI) {
		if (!settings.geminiApiKey) {
			throw new ProviderConfigError(
				'Set the Google Gemini API key in settings.',
			);
		}
		return new GeminiLlmProvider({
			baseUrl,
			apiKey: settings.geminiApiKey,
			model: settings.llmGeminiModel,
		});
	}
	// OpenAI reuses the Whisper API key as the shared OpenAI vendor key.
	if (!settings.whisperApiKey) {
		throw new ProviderConfigError('Set the OpenAI API key in settings.');
	}
	return new OpenAiCompatibleLlmProvider({
		baseUrl,
		apiKey: settings.whisperApiKey,
		model: settings.llmOpenAiModel,
	});
}

/**
 * Splits a space-separated argument string into individual arguments,
 * dropping empty tokens. (Quoting is intentionally not supported — paths
 * with spaces should be configured via the dedicated path fields.)
 * @param raw - Raw argument string
 */
export function parseArgs(raw: string): string[] {
	return raw
		.split(/\s+/)
		.map((part) => part.trim())
		.filter((part) => part.length > 0);
}
