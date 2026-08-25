/**
 * Facade over the two provider registries, so callers that just need "the
 * configured provider" have one import instead of reaching into the engine and
 * vendor tables. The construction rules themselves live with each provider's
 * descriptor - which settings fields it reads, what it requires, and what it
 * says when they are missing - so this module holds no per-provider branches.
 * @module transcription/factories
 */

import type {
	AudioRecorderSettings,
	LlmProviderId,
} from '../settings/settingsSchema';
import type { TranscriptionProvider } from './providers/TranscriptionProvider';
import type { LlmProvider } from './llm/LlmProvider';
import { jobVendorId, llmVendor } from './llm/vendors';
import { accountRequiresKey, vendorConnection } from '../providers/providers';
import { ProviderConfigError } from './providerConfigError';

export { ProviderConfigError } from './providerConfigError';
export { parseArgs } from './providers/engines';
export { createTranscriptionProvider } from './providers/engines';

// Re-exported so the module's two factories keep a symmetric surface even
// though only the transcription one is defined elsewhere.
export type { TranscriptionProvider, LlmProvider };

/**
 * Builds an LLM provider from a vendor's descriptor: which settings field
 * holds its key and model, and how to construct it, are vendor facts owned by
 * the registry rather than branches here. A run needs both halves of the
 * configuration, so a missing key and an empty catalogue are refused with the
 * reason rather than sent to the endpoint as a request that cannot succeed.
 *
 * The vendor is a parameter because each LLM-driven job picks its own engine
 * (see {@link module:transcription/llm/vendors}'s `LLM_JOBS`): a caller names
 * the engine its job is configured to call rather than getting whichever one
 * post-processing happens to point at.
 * @param settings - Plugin settings
 * @param vendorId - Engine to build, defaulting to the post-processing one
 */
export function createLlmProvider(
	settings: AudioRecorderSettings,
	vendorId: LlmProviderId = jobVendorId(settings, 'postProcess'),
): LlmProvider {
	const vendor = llmVendor(vendorId);
	// The endpoint belongs to the provider the vendor is a capability of,
	// which is the same one its transcription side is reached through.
	const connection = vendorConnection(vendor.id);
	const apiKey = vendor.settings.apiKey(settings);
	// The same rule the transcription factory follows, read from the same
	// registry: only the vendor's own endpoint is refused without a key, so a
	// Base URL pointed at a local server is reachable with the field empty.
	if (!apiKey && accountRequiresKey(connection, settings)) {
		throw new ProviderConfigError(vendor.missingKeyMessage);
	}
	const model = vendor.settings.model(settings);
	if (!model) {
		throw new ProviderConfigError(vendor.missingModelMessage);
	}
	return vendor.create({
		baseUrl: connection.baseUrl(settings),
		apiKey,
		model,
	});
}
