/**
 * The error raised when settings are insufficient to build a provider. Kept in
 * a leaf module of its own so both provider registries (transcription engines
 * and LLM vendors) and the factory facade over them can raise it without
 * importing each other.
 * @module transcription/providerConfigError
 */

/** Error raised when settings are insufficient to build a provider. */
export class ProviderConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ProviderConfigError';
	}
}
