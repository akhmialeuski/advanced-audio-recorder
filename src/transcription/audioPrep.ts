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
	MIN_AUDIO_BYTES_PER_SEC,
	MIN_SUBDIVIDE_SECONDS,
	TRANSCRIBE_BYTES_PER_SEC,
	TRANSCRIBE_SAMPLE_RATE,
	MIME_TYPE_AUDIO_PREFIX,
} from '../constants';
import { audioMimeForExtension } from '../audio/formatRegistry';
import {
	decodeToMono16k,
	extractChunkWav,
	planChunks,
	splitChunkPlan,
	type ChunkPlan,
} from './audioChunks';
import type { ProviderCapabilities } from './providers/TranscriptionProvider';

/**
 * Resolves an upload MIME type for a file extension, defaulting to
 * `audio/<ext>` for anything not explicitly mapped.
 * @param extension - File extension without the dot (case-insensitive)
 * @returns A container MIME type suitable for an upload
 */
export function audioMimeFromExtension(extension: string): string {
	return audioMimeForExtension(extension.toLowerCase());
}

/** How the audio should be prepared for a specific provider. */
export interface AudioPrepOptions {
	/** Hard per-request byte ceiling declared by the provider. */
	maxRequestBytes: number;
	/**
	 * Longest recording, in seconds, the provider transcribes in one request.
	 * A recording longer than this is decoded and split even when its bytes fit
	 * {@link maxRequestBytes}. Number.POSITIVE_INFINITY disables the duration
	 * gate (the whole-file decision then rests on bytes alone).
	 */
	maxRequestSeconds: number;
	/** Whether the provider accepts the original container bytes. */
	acceptsOriginalContainer: boolean;
	/**
	 * Target chunk size, in bytes, when decoding is required. Ignored on the
	 * whole-file path. Use Number.POSITIVE_INFINITY to produce a single chunk.
	 */
	chunkBytes: number;
	/** Whether speaker diarization is requested for this run. */
	diarize: boolean;
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
	/**
	 * End of this payload on the recording timeline, in seconds. Present on the
	 * decode path (so a part can be labelled and subdivided by its time range);
	 * absent on the whole-file path, whose true duration is never measured.
	 */
	endSeconds?: number;
	/** Builds the upload bytes; invoked once, right before uploading. */
	createData(): ArrayBuffer | Promise<ArrayBuffer>;
	/**
	 * Splits this payload into smaller payloads covering the same audio, for a
	 * provider that overran its output token budget on this part. Present only on
	 * the decode path (the decoded samples are still in memory); returns the
	 * smaller payloads, or [] when the part is already at the minimum
	 * subdividable length.
	 */
	subdivide?: () => PreparedPayload[];
}

/** Prepared payloads ready to transcribe. */
export interface PreparedAudio {
	/** Ordered payloads to transcribe; segment offsets are pre-computed. */
	payloads: PreparedPayload[];
	/**
	 * True when a diarized run had to be split across multiple parts (too large
	 * or too long for one request), so speaker numbering can reset between parts
	 * - every provider numbers speakers per request once the recording is split.
	 * The caller surfaces this to the user rather than letting the inconsistency
	 * pass silently.
	 */
	diarizationSplitWarning: boolean;
}

/**
 * Whether a diarized run was split across more than one part, in which case
 * speaker numbering can differ between parts. Once a recording is split, every
 * provider numbers speakers per request, so even a whole-file diarizer loses
 * cross-part consistency. Pure so the warning condition is unit tested without
 * decoding audio.
 * @param chunkCount - Number of parts the audio was split into
 * @param diarize - Whether speaker diarization was requested
 * @returns True when speaker labels may be inconsistent across parts
 */
export function shouldWarnDiarizationSplit(
	chunkCount: number,
	diarize: boolean,
): boolean {
	return diarize && chunkCount > 1;
}

/**
 * Whether a file's byte size alone proves it is within a provider's per-request
 * duration cap, so it can be sent whole without first decoding it to measure
 * its true length. Uses a conservative minimum bitrate ({@link
 * MIN_AUDIO_BYTES_PER_SEC}): below `cap * minBitrate` bytes even the most
 * heavily compressed audio cannot exceed the cap. An infinite cap is always
 * satisfied. A larger file is not necessarily too long - it just cannot be
 * proven short cheaply, so it falls through to the decode path, which measures
 * the exact duration.
 * @param byteLength - Encoded file size in bytes
 * @param maxRequestSeconds - Provider per-request duration cap in seconds
 * @returns True when the byte size guarantees the recording is within the cap
 */
export function withinDurationCap(
	byteLength: number,
	maxRequestSeconds: number,
): boolean {
	if (!Number.isFinite(maxRequestSeconds)) {
		return true;
	}
	return byteLength <= maxRequestSeconds * MIN_AUDIO_BYTES_PER_SEC;
}

/**
 * Prepares an audio file into provider-ready payloads.
 *
 * Whole-file path: when the provider accepts the original container, the
 * encoded file is within its byte limit, and the byte size proves the
 * recording is within the provider's per-request duration cap, the original
 * bytes are sent as one payload - no decode, so peak memory is just the file
 * size and any whole-file diarization stays consistent.
 *
 * Decode path: otherwise (an unsupported container, an over-limit file, or a
 * recording too long for one request) the file is decoded to 16 kHz mono and
 * split into WAV chunks bounded by `chunkBytes` (a single chunk when it still
 * fits, e.g. a duration cap the byte proxy could not rule out cheaply). A
 * diarized split is flagged so the caller can warn that speaker numbering may
 * reset between parts.
 *
 * The decode path always emits WAV, even for a single part that fits whole.
 * Re-sending the original bytes instead would save the WAV size on an accepted
 * compressed container, but it would force a second decode in a provider that
 * decodes containers it does not accept (Gemini re-decodes mp4/webm) - and
 * those are this plugin's own recording formats, the common case. Emitting WAV
 * keeps the recorded-file path to a single decode; the only cost is a larger
 * upload for the uncommon case of an imported accepted container (mp3/aac/etc.)
 * big enough to miss the cheap whole-file proof yet short enough to fit.
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
		raw.byteLength <= options.maxRequestBytes &&
		withinDurationCap(raw.byteLength, options.maxRequestSeconds)
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
			diarizationSplitWarning: false,
		};
	}

	// The full decoded PCM stays alive for the whole run (~230 MB for an
	// hour at 16 kHz mono, audit finding 6.8): each chunk's WAV is
	// materialized lazily from a non-copying subarray view, and keeping the
	// samples is what lets a part be re-split on demand when a provider
	// overruns its output token budget. A decode-per-chunk scheme would
	// drop the retention but re-decode the file once per chunk; revisit if
	// long-recording memory pressure ever outweighs that trade.
	const samples = await decodeToMono16k(raw);
	const totalSeconds = samples.length / TRANSCRIBE_SAMPLE_RATE;
	const plans = planChunks(totalSeconds, options.chunkBytes);
	const multiChunk = plans.length > 1;
	// Build a payload for a plan, retaining the decoded samples so the part can
	// be re-split on demand when a provider overruns its output token budget.
	const buildPayload = (
		plan: ChunkPlan,
		filename: string,
	): PreparedPayload => ({
		contentType: `${MIME_TYPE_AUDIO_PREFIX}wav`,
		filename,
		offsetSeconds: plan.startSeconds,
		endSeconds: plan.endSeconds,
		createData: () => extractChunkWav(samples, plan),
		subdivide: () =>
			splitChunkPlan(plan, MIN_SUBDIVIDE_SECONDS).map((half) =>
				buildPayload(half, `audio-${String(half.index)}.wav`),
			),
	});
	const payloads: PreparedPayload[] = plans.map((plan) =>
		buildPayload(
			plan,
			multiChunk ? `audio-${String(plan.index)}.wav` : 'audio.wav',
		),
	);
	return {
		payloads,
		diarizationSplitWarning: shouldWarnDiarizationSplit(
			plans.length,
			options.diarize,
		),
	};
}

/**
 * Computes provider-ready preparation options from capabilities and the
 * user's preferred chunk size. A provider with a per-request duration cap
 * (Gemini) sizes its parts by that cap, so the whole-file threshold and the
 * split size agree and a recording just over the cap divides into even parts;
 * the user's byte-oriented chunk size targets the Whisper API's 25 MB request
 * limit and does not apply. Otherwise a network provider honors the user's
 * chunk size (bounded by the provider limit) and a local provider with no
 * upload limit produces a single chunk.
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
	const chunkBytes = Number.isFinite(capabilities.maxRequestSeconds)
		? Math.min(
				capabilities.maxRequestSeconds * TRANSCRIBE_BYTES_PER_SEC,
				capabilities.maxRequestBytes,
			)
		: requiresNetwork
			? Math.min(capabilities.maxRequestBytes, userChunkBytes)
			: capabilities.maxRequestBytes;
	return {
		maxRequestBytes: capabilities.maxRequestBytes,
		maxRequestSeconds: capabilities.maxRequestSeconds,
		acceptsOriginalContainer: capabilities.acceptsOriginalContainer,
		chunkBytes,
		diarize,
	};
}
