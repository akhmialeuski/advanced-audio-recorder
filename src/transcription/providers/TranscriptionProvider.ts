/**
 * Transcription provider abstraction. A provider turns one chunk of
 * 16 kHz mono WAV audio into timed segments. The orchestrating service
 * handles decoding, chunking, and stitching, so providers only implement
 * single-chunk transcription — keeping API, local, and future providers
 * interchangeable.
 * @module transcription/providers/TranscriptionProvider
 */

import type { WhisperResult } from './whisperResponse';

/** Options for a single transcription call. */
export interface TranscribeOptions {
	/** Language hint (BCP-47/ISO), or undefined to auto-detect. */
	language?: string;
	/** Request speaker diarization when the provider supports it. */
	diarize: boolean;
	/** Request word-level timestamps when supported. */
	wordTimestamps: boolean;
}

/** A provider that transcribes a single audio chunk. */
export interface TranscriptionProvider {
	/** Stable identifier for diagnostics. */
	readonly id: string;
	/** Human-readable label. */
	readonly label: string;
	/** Whether the provider makes network calls (affects availability). */
	readonly requiresNetwork: boolean;
	/**
	 * Transcribes one chunk of 16 kHz mono WAV audio.
	 * @param audio - WAV-encoded chunk bytes
	 * @param options - Transcription options
	 * @returns Language and timed segments for this chunk
	 */
	transcribe(
		audio: ArrayBuffer,
		options: TranscribeOptions,
	): Promise<WhisperResult>;
}
