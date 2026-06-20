/**
 * Prepares an audio file for a transcription provider, entirely in memory.
 * The cheap path sends the original container bytes untouched (when the
 * provider accepts them and the file fits its limit); the fallback path
 * decodes to 16 kHz mono and splits into WAV chunks under the limit. No
 * temporary files are written, so preparation works on desktop and mobile
 * alike, and avoiding the decode keeps peak memory at the encoded file
 * size for providers that take the original format.
 * @module transcription/audioPrep
 */

import {
	FORMAT_WAV,
	FORMAT_WEBM,
	FORMAT_OGG,
	FORMAT_MP3,
	FORMAT_MP4,
	FORMAT_M4A,
	FORMAT_AAC,
	FORMAT_FLAC,
	MIME_TYPE_AUDIO_PREFIX,
	TRANSCRIBE_SAMPLE_RATE,
} from '../constants';
import { decodeToMono16k, extractChunkWav, planChunks } from './audioChunks';
import type { ProviderCapabilities } from './providers/TranscriptionProvider';

/** Bytes in one megabyte, for human-readable size messages. */
const BYTES_PER_MB = 1024 * 1024;

/**
 * Raised when a file is too large to send whole to a provider that
 * diarizes across an entire request, so it would have to be chunked —
 * which resets speaker numbering per chunk. Refusing is preferable to
 * silently producing inconsistent speaker labels.
 */
export class WholeFileDiarizationLimitError extends Error {
	constructor(fileBytes: number, limitBytes: number) {
		super(
			`This recording (${String(Math.round(fileBytes / BYTES_PER_MB))} MB) ` +
				`is too large for diarized transcription with this provider, which ` +
				`needs the whole file in one request (limit ` +
				`${String(Math.round(limitBytes / BYTES_PER_MB))} MB). Disable ` +
				`speaker diarization, split the recording, or use a provider with a ` +
				`higher limit.`,
		);
		this.name = 'WholeFileDiarizationLimitError';
	}
}

/** Maps a lowercased file extension to its upload container MIME type. */
const EXTENSION_MIME: Record<string, string> = {
	[FORMAT_WAV]: `${MIME_TYPE_AUDIO_PREFIX}wav`,
	[FORMAT_WEBM]: `${MIME_TYPE_AUDIO_PREFIX}webm`,
	[FORMAT_OGG]: `${MIME_TYPE_AUDIO_PREFIX}ogg`,
	[FORMAT_MP3]: `${MIME_TYPE_AUDIO_PREFIX}mpeg`,
	[FORMAT_MP4]: `${MIME_TYPE_AUDIO_PREFIX}mp4`,
	[FORMAT_M4A]: `${MIME_TYPE_AUDIO_PREFIX}mp4`,
	[FORMAT_AAC]: `${MIME_TYPE_AUDIO_PREFIX}aac`,
	[FORMAT_FLAC]: `${MIME_TYPE_AUDIO_PREFIX}flac`,
};

/**
 * Resolves an upload MIME type for a file extension, defaulting to
 * `audio/<ext>` for anything not explicitly mapped.
 * @param extension - File extension without the dot (case-insensitive)
 * @returns A container MIME type suitable for an upload
 */
export function audioMimeFromExtension(extension: string): string {
	const ext = extension.toLowerCase();
	return EXTENSION_MIME[ext] ?? `${MIME_TYPE_AUDIO_PREFIX}${ext}`;
}

/** How the audio should be prepared for a specific provider. */
export interface AudioPrepOptions {
	/** Hard per-request byte ceiling declared by the provider. */
	maxRequestBytes: number;
	/** Whether the provider accepts the original container bytes. */
	acceptsOriginalContainer: boolean;
	/**
	 * Target chunk size, in bytes, when decoding is required. Ignored on the
	 * whole-file path. Use Number.POSITIVE_INFINITY to produce a single chunk.
	 */
	chunkBytes: number;
	/** Whether speaker diarization is requested for this run. */
	diarize: boolean;
	/**
	 * Whether the provider needs the whole file in one request for stable
	 * speaker numbering. When true and diarization is requested, a file that
	 * must be chunked is rejected rather than silently re-numbered per chunk.
	 */
	diarizesWholeFile: boolean;
}

/**
 * One prepared upload unit whose bytes are produced on demand. The heavy
 * `createData()` is called once, immediately before the unit is uploaded,
 * so only a single chunk's bytes are materialized at a time instead of all
 * chunks at once.
 */
export interface PreparedPayload {
	/** MIME type of the bytes (e.g. 'audio/wav', 'audio/webm'). */
	contentType: string;
	/** Filename hint for multipart uploads. */
	filename: string;
	/** Offset of this payload from the start of the recording, in seconds. */
	offsetSeconds: number;
	/** Builds the upload bytes; invoked once, right before uploading. */
	createData(): ArrayBuffer;
}

/** Prepared payloads ready to transcribe. */
export interface PreparedAudio {
	/** Ordered payloads to transcribe; segment offsets are pre-computed. */
	payloads: PreparedPayload[];
}

/**
 * Prepares an audio file into provider-ready payloads.
 *
 * Whole-file path: when the provider accepts the original container and the
 * encoded file is within its limit, the original bytes are sent as one
 * payload — no decode, so peak memory is just the file size and any
 * whole-file diarization stays consistent.
 *
 * Decode path: otherwise the file is decoded to 16 kHz mono and split into
 * WAV chunks bounded by `chunkBytes` (one chunk when `chunkBytes` is
 * infinite, e.g. a local engine with no upload limit).
 * @param raw - Encoded file bytes
 * @param fileName - Source file name (used as the upload filename)
 * @param fileMime - MIME type for the original container
 * @param options - Provider-derived preparation options
 * @returns Prepared payloads ready to transcribe
 */
export async function prepareAudio(
	raw: ArrayBuffer,
	fileName: string,
	fileMime: string,
	options: AudioPrepOptions,
): Promise<PreparedAudio> {
	if (
		options.acceptsOriginalContainer &&
		raw.byteLength <= options.maxRequestBytes
	) {
		return {
			payloads: [
				{
					contentType: fileMime,
					filename: fileName,
					offsetSeconds: 0,
					createData: () => raw,
				},
			],
		};
	}

	// The file must be decoded and split. A provider that diarizes across the
	// whole request cannot keep speaker numbering stable once chunked, so
	// refuse rather than emit a transcript with reset speakers per chunk.
	if (options.diarize && options.diarizesWholeFile) {
		throw new WholeFileDiarizationLimitError(
			raw.byteLength,
			options.maxRequestBytes,
		);
	}

	const samples = await decodeToMono16k(raw);
	const totalSeconds = samples.length / TRANSCRIBE_SAMPLE_RATE;
	const plans = planChunks(totalSeconds, options.chunkBytes);
	const multiChunk = plans.length > 1;
	const payloads: PreparedPayload[] = plans.map((plan) => ({
		contentType: `${MIME_TYPE_AUDIO_PREFIX}wav`,
		filename: multiChunk ? `audio-${String(plan.index)}.wav` : 'audio.wav',
		offsetSeconds: plan.startSeconds,
		createData: () => extractChunkWav(samples, plan),
	}));
	return { payloads };
}

/**
 * Computes provider-ready preparation options from capabilities and the
 * user's preferred chunk size. Network providers honor the user's chunk
 * size (bounded by the provider limit); a local provider with no upload
 * limit produces a single chunk.
 * @param capabilities - The provider's declared capabilities
 * @param requiresNetwork - Whether the provider uploads over the network
 * @param userChunkBytes - The user-configured chunk size in bytes
 * @param diarize - Whether speaker diarization is requested for this run
 * @returns Options to pass to {@link prepareAudio}
 */
export function audioPrepOptions(
	capabilities: ProviderCapabilities,
	requiresNetwork: boolean,
	userChunkBytes: number,
	diarize: boolean,
): AudioPrepOptions {
	const chunkBytes = requiresNetwork
		? Math.min(capabilities.maxRequestBytes, userChunkBytes)
		: capabilities.maxRequestBytes;
	return {
		maxRequestBytes: capabilities.maxRequestBytes,
		acceptsOriginalContainer: capabilities.acceptsOriginalContainer,
		chunkBytes,
		diarize,
		diarizesWholeFile: capabilities.diarizesWholeFile,
	};
}
