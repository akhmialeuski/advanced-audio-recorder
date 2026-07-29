/**
 * Builds transcription and LLM providers from plugin settings, keeping
 * provider construction (and its validation) out of the UI and service.
 * @module transcription/factories
 */

import { MS_PER_MINUTE, TRANSCRIPTION_PROVIDER_IDS } from '../constants';
import type { AudioRecorderSettings } from '../settings/settingsSchema';
import { WhisperApiProvider } from './providers/WhisperApiProvider';
import { LocalWhisperProvider } from './providers/LocalWhisperProvider';
import { DeepgramProvider } from './providers/DeepgramProvider';
import { GeminiProvider } from './providers/GeminiProvider';
import type { TranscriptionProvider } from './providers/TranscriptionProvider';
import type { LlmProvider } from './llm/LlmProvider';
import { selectedLlmVendor } from './llm/vendors';

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
	// Per-request timeout cap shared by every network provider, from the
	// user-configured limit (minutes). Local whisper.cpp makes no HTTP request,
	// so it ignores this.
	const requestTimeoutMs =
		settings.transcriptionTimeoutMinutes * MS_PER_MINUTE;
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
			requestTimeoutMs,
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
			requestTimeoutMs,
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
		requestTimeoutMs,
	});
}

/**
 * Builds the configured LLM post-processing provider from the selected
 * vendor's descriptor: which settings field holds its key and model, and how
 * to construct it, are vendor facts owned by the registry rather than branches
 * here. Every vendor requires a key.
 * @param settings - Plugin settings
 */
export function createLlmProvider(
	settings: AudioRecorderSettings,
): LlmProvider {
	const vendor = selectedLlmVendor(settings);
	const apiKey = vendor.settings.apiKey(settings);
	if (!apiKey) {
		throw new ProviderConfigError(vendor.missingKeyMessage);
	}
	return vendor.create({
		baseUrl: settings.llmBaseUrl,
		apiKey,
		model: vendor.settings.model(settings),
	});
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
