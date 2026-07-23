/**
 * Core data model for transcripts. A transcript is an ordered list of
 * timed segments, each optionally attributed to a speaker, plus the
 * detected language and provenance metadata. The model is provider- and
 * UI-agnostic so the formatting, file, and diarization logic can be unit
 * tested without any network or DOM dependency.
 * @module transcription/TranscriptTypes
 */

/**
 * A single word with its own timing, when the provider returns
 * word-level timestamps. Optional - many providers return segments only.
 */
export interface TranscriptWord {
	/** Start offset in seconds from the beginning of the audio. */
	start: number;
	/** End offset in seconds from the beginning of the audio. */
	end: number;
	/** The word text (no surrounding whitespace). */
	text: string;
}

/**
 * A contiguous span of transcribed speech.
 */
export interface TranscriptSegment {
	/** Start offset in seconds from the beginning of the audio. */
	start: number;
	/** End offset in seconds from the beginning of the audio. */
	end: number;
	/** The transcribed text for this span. */
	text: string;
	/**
	 * Speaker identifier when diarization is available (e.g. "Speaker 1"),
	 * or undefined when speakers are not distinguished.
	 */
	speaker?: string;
	/** Optional word-level timings within this segment. */
	words?: TranscriptWord[];
}

/**
 * A fully assembled transcript.
 */
export interface Transcript {
	/** Detected or requested language as a BCP-47 / ISO code, when known. */
	language?: string;
	/** Ordered, non-overlapping (by start) segments. */
	segments: TranscriptSegment[];
	/** Distinct speaker labels present in the segments, in first-seen order. */
	speakers: string[];
	/** Provenance: which engine/model produced the transcript. */
	model?: string;
	/** ISO-8601 timestamp of when the transcript was produced. */
	createdAt?: string;
	/** Vault path of the source audio file, when known. */
	sourcePath?: string;
}

/**
 * Billing-relevant usage a provider reported for one transcription
 * request. Every field is optional: an engine reports only what its API
 * returns (Deepgram/Whisper bill by audio duration, Gemini by tokens),
 * and a missing field means "not reported", never zero.
 */
export interface TranscriptionUsage {
	/** Billed audio duration in seconds, when the provider reports it. */
	audioSeconds?: number;
	/** Total billed input (prompt) tokens, when the provider reports them. */
	inputTokens?: number;
	/**
	 * Portion of {@link inputTokens} that is audio-modality, when the
	 * provider breaks the prompt down by modality (Gemini reports this in
	 * `usageMetadata.promptTokensDetails`). Audio tokens are billed at a
	 * different rate than the text prompt, so the split lets the cost model
	 * price each modality correctly instead of charging the whole prompt at
	 * the audio rate. Undefined means the split is unknown.
	 */
	audioInputTokens?: number;
	/** Billed output tokens, when the provider reports them. */
	outputTokens?: number;
}

/** Format used to serialize a transcript to a sidecar/export file. */
export type TranscriptFileFormat = 'json' | 'srt' | 'vtt' | 'txt';

/**
 * Every transcript file format, in output preference order (JSON first: it
 * is lossless and carries the detected language). The single source both
 * discovery and sidecar validation enumerate, so adding a member to the
 * union only needs this one list updated alongside it.
 */
export const TRANSCRIPT_FILE_FORMATS: readonly TranscriptFileFormat[] = [
	'json',
	'srt',
	'vtt',
	'txt',
];

/**
 * Where the transcript output is written.
 * - `note`: render the full transcript Markdown into the active note.
 * - `file`: write a sidecar transcript file next to the audio.
 * - `both`: render into the note and write a sidecar file.
 * - `link`: write a sidecar file and insert a link to it into the note.
 */
export type TranscriptDestination = 'note' | 'file' | 'both' | 'link';
