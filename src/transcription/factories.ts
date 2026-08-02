/**
 * Facade over the two provider registries, so callers that just need "the
 * configured provider" have one import instead of reaching into the engine and
 * vendor tables. The construction rules themselves live with each provider's
 * descriptor - which settings fields it reads, what it requires, and what it
 * says when they are missing - so this module holds no per-provider branches.
 * @module transcription/factories
 */

import type { AudioRecorderSettings } from '../settings/settingsSchema';
import type { TranscriptionProvider } from './providers/TranscriptionProvider';
import type { LlmProvider } from './llm/LlmProvider';
import { selectedLlmVendor } from './llm/vendors';
import { vendorConnection } from '../providers/providers';
import { ProviderConfigError } from './providerConfigError';

export { ProviderConfigError } from './providerConfigError';
export { parseArgs } from './providers/engines';
export { createTranscriptionProvider } from './providers/engines';

// Re-exported so the module's two factories keep a symmetric surface even
// though only the transcription one is defined elsewhere.
export type { TranscriptionProvider, LlmProvider };

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
		// The endpoint belongs to the provider the vendor is a capability of,
		// which is the same one its transcription side is reached through.
		baseUrl: vendorConnection(vendor.id).baseUrl(settings),
		apiKey,
		model: vendor.settings.model(settings),
	});
}
