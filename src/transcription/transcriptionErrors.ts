/**
 * Shared transcription error types that the pipeline reacts to by type rather
 * than by matching message text. Kept provider-neutral so both the provider
 * implementations that throw them and the orchestrating service that catches
 * them depend on this module, not on each other.
 * @module transcription/transcriptionErrors
 */

/**
 * Thrown when a provider stopped because it hit its output token limit, so the
 * returned transcript is incomplete. The orchestrator treats this as
 * recoverable: transcribing the same audio in smaller pieces keeps each part's
 * output under the cap. The message is provider-supplied and already names the
 * reported token usage, so it can be surfaced unchanged when subdivision is no
 * longer possible.
 */
export class TranscriptTruncatedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'TranscriptTruncatedError';
	}
}
