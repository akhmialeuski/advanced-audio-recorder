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
import type {
	AudioPayload,
	ProviderCapabilities,
} from './providers/TranscriptionProvider';

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
}

/** Prepared payloads plus the total duration when it is known. */
export interface PreparedAudio {
	/** Ordered payloads to transcribe; segment offsets are pre-computed. */
	payloads: AudioPayload[];
	/**
	 * Total audio duration in seconds, or null when the original file was
	 * sent untouched (no decode happened, so the duration was never measured).
	 */
	totalSeconds: number | null;
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
 * @returns Prepared payloads and the known total duration
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
					data: raw,
					contentType: fileMime,
					filename: fileName,
					offsetSeconds: 0,
				},
			],
			totalSeconds: null,
		};
	}

	const samples = await decodeToMono16k(raw);
	const totalSeconds = samples.length / TRANSCRIBE_SAMPLE_RATE;
	const plans = planChunks(totalSeconds, options.chunkBytes);
	const payloads: AudioPayload[] = plans.map((plan) => ({
		data: extractChunkWav(samples, plan),
		contentType: `${MIME_TYPE_AUDIO_PREFIX}wav`,
		filename:
			plans.length > 1 ? `audio-${String(plan.index)}.wav` : 'audio.wav',
		offsetSeconds: plan.startSeconds,
	}));
	return { payloads, totalSeconds };
}

/**
 * Computes provider-ready preparation options from capabilities and the
 * user's preferred chunk size. Network providers honor the user's chunk
 * size (bounded by the provider limit); a local provider with no upload
 * limit produces a single chunk.
 * @param capabilities - The provider's declared capabilities
 * @param requiresNetwork - Whether the provider uploads over the network
 * @param userChunkBytes - The user-configured chunk size in bytes
 * @returns Options to pass to {@link prepareAudio}
 */
export function audioPrepOptions(
	capabilities: ProviderCapabilities,
	requiresNetwork: boolean,
	userChunkBytes: number,
): AudioPrepOptions {
	const chunkBytes = requiresNetwork
		? Math.min(capabilities.maxRequestBytes, userChunkBytes)
		: capabilities.maxRequestBytes;
	return {
		maxRequestBytes: capabilities.maxRequestBytes,
		acceptsOriginalContainer: capabilities.acceptsOriginalContainer,
		chunkBytes,
	};
}
