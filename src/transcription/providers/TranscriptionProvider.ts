/**
 * Transcription provider abstraction. A provider turns one audio payload
 * into timed segments. The orchestrating service prepares the audio
 * (reading the file, optionally decoding and chunking) according to each
 * provider's declared capabilities, so providers only implement a single
 * request - keeping API, local, and future providers interchangeable.
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
	/**
	 * Optional abort signal for the provider's HTTP requests. Providers on
	 * CORS-capable endpoints pass it through so a cancel aborts the upload
	 * mid-flight; providers that cannot abort (requestUrl-only endpoints,
	 * the local CLI) ignore it and remain cancel-between-chunks only.
	 */
	signal?: AbortSignal;
}

/**
 * One unit of audio handed to a provider for a single request. The
 * orchestrator either passes the whole original file (when the provider
 * accepts the container format and the file fits its limit) or a decoded
 * 16 kHz mono WAV chunk. Segment timings returned by the provider are
 * relative to this payload; the service re-bases them by `offsetSeconds`.
 */
export interface AudioPayload {
	/** Encoded bytes to send (original container bytes, or a WAV chunk). */
	data: ArrayBuffer;
	/** MIME type of the bytes (e.g. 'audio/wav', 'audio/webm'). */
	contentType: string;
	/** Filename hint for multipart uploads. */
	filename: string;
	/** Offset of this payload from the start of the recording, in seconds. */
	offsetSeconds: number;
}

/**
 * What a provider can accept in a single request. The service uses these
 * to decide whether to send the original file untouched or to decode and
 * split it into chunks that stay within the provider's limit.
 */
export interface ProviderCapabilities {
	/**
	 * Maximum bytes the provider accepts in one request. Use
	 * Number.POSITIVE_INFINITY for an effectively unbounded local provider.
	 */
	maxRequestBytes: number;
	/**
	 * Longest recording, in seconds, the provider transcribes reliably in one
	 * request. A recording longer than this is decoded and split into parts
	 * even when its byte size fits {@link maxRequestBytes}, because inference
	 * time and the output transcript grow with audio duration, not bytes. Use
	 * Number.POSITIVE_INFINITY when the provider has no practical per-request
	 * duration limit (a whole-file API like Deepgram, or a local engine).
	 */
	maxRequestSeconds: number;
	/**
	 * Whether the provider accepts the original container bytes (any common
	 * audio format). When false, the provider needs decoded 16 kHz mono WAV.
	 */
	acceptsOriginalContainer: boolean;
	/**
	 * Whether the provider can return speaker labels at all. Gates the
	 * diarization UI and the diarize request: an engine that cannot diarize
	 * (OpenAI's Whisper, local whisper.cpp) must not offer an enabled toggle,
	 * since the request would be silently ignored and mislead the user.
	 */
	supportsDiarization: boolean;
}

/** A provider that transcribes a single audio payload. */
export interface TranscriptionProvider {
	/** Stable identifier for diagnostics. */
	readonly id: string;
	/** Human-readable label. */
	readonly label: string;
	/** Whether the provider makes network calls (affects availability). */
	readonly requiresNetwork: boolean;
	/** What the provider accepts in a single request. */
	readonly capabilities: ProviderCapabilities;
	/**
	 * Transcribes one audio payload.
	 * @param payload - The audio bytes and their metadata
	 * @param options - Transcription options
	 * @returns Language and timed segments for this payload
	 */
	transcribe(
		payload: AudioPayload,
		options: TranscribeOptions,
	): Promise<WhisperResult>;
}
