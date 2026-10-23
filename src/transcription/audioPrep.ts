/**
 * Prepares an audio file for a transcription provider, entirely in memory.
 * The cheap path sends the original container bytes untouched (when the
 * provider reads that container and the file fits its limits); the fallback
 * path decodes to 16 kHz mono and splits into WAV chunks under the limits. No
 * temporary files are written, so preparation works on desktop and mobile
 * alike, and avoiding the decode keeps peak memory at the encoded file
 * size for providers that take the original format.
 *
 * This is the only place a recording is decoded for transcription. Every part
 * it hands out is already in a container its engine reads, so a provider only
 * uploads; and each part rebuilds its bytes from what preparation kept rather
 * than from the caller's buffer, so the same part can be sent again - after a
 * refusal the run waits out, or for the advanced second pass - without
 * anything having been used up by the first send.
 * @module transcription/audioPrep
 */

import {
	MIN_AUDIO_BYTES_PER_SEC,
	MIN_SUBDIVIDE_SECONDS,
	TRANSCRIBE_SAMPLE_RATE,
	WAV_MIME,
} from '../constants';
import { audioMimeForExtension } from '../audio/formatRegistry';
import { isDecodableSize, tooLargeMessage } from '../platform/capabilities';
import {
	decodeToMono16k,
	extractChunkWav,
	planChunks,
	secondsWithinRequestBytes,
	splitChunkPlan,
	type ChunkPlan,
} from './audioChunks';
import {
	DurationCapCheck,
	type AudioContainer,
	type ContainerSupport,
	type ProviderCapabilities,
} from './providers/TranscriptionProvider';

/**
 * Names the container of a file by its extension, in both of the units an
 * engine states its list in. The MIME type defaults to `audio/<ext>` for an
 * extension the format registry does not map.
 * @param extension - File extension without the dot (case-insensitive)
 * @returns The container, with its MIME type and its lowercase extension
 */
export function audioContainerFromExtension(extension: string): AudioContainer {
	const lower = extension.toLowerCase();
	return { contentType: audioMimeForExtension(lower), extension: lower };
}

/** How the audio should be prepared for a specific provider. */
export interface AudioPrepOptions {
	/** Hard per-request byte ceiling declared by the provider. */
	maxRequestBytes: number;
	/**
	 * Longest recording, in seconds, the provider transcribes in one request.
	 * A decoded recording is split at it; whether a file sent in its own
	 * container has to prove itself within it first is {@link durationCapCheck}.
	 * Number.POSITIVE_INFINITY disables the duration gate (the whole-file
	 * decision then rests on bytes alone).
	 */
	maxRequestSeconds: number;
	/** How {@link maxRequestSeconds} is held against an undecoded file. */
	durationCapCheck: DurationCapCheck;
	/** Which original containers the provider reads as they stand. */
	originalContainers: ContainerSupport;
	/** The engine's name, which a refusal names the operation by. */
	engineLabel: string;
	/**
	 * Longest part, in seconds, produced when decoding is required. Ignored on
	 * the whole-file path. Use Number.POSITIVE_INFINITY to produce a single
	 * part.
	 */
	chunkSeconds: number;
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
 * Whether a file goes to the provider as it stands, in one request: its
 * container is one the provider reads, its bytes fit one request, and its
 * length is either proven within the duration cap by its size or left to the
 * endpoint to enforce. Pure, so the decision is unit tested without audio.
 * @param byteLength - Encoded file size in bytes
 * @param container - The file's container
 * @param options - Provider-derived preparation options
 * @returns True when the original bytes are sent whole, with no decode
 */
export function sendsWholeFile(
	byteLength: number,
	container: AudioContainer,
	options: Pick<
		AudioPrepOptions,
		| 'durationCapCheck'
		| 'maxRequestBytes'
		| 'maxRequestSeconds'
		| 'originalContainers'
	>,
): boolean {
	return (
		options.originalContainers.accepts(container) &&
		byteLength <= options.maxRequestBytes &&
		(options.durationCapCheck === DurationCapCheck.LeftToEndpoint ||
			withinDurationCap(byteLength, options.maxRequestSeconds))
	);
}

/**
 * Refuses, before any allocation, a file this platform cannot decode.
 *
 * Asked here although the decoder asks it too, because only here is it known
 * why the file has to be decoded at all. When the engine does not read the
 * file's container, converting to one it does read avoids the decode entirely,
 * and that is better advice than splitting the file. The decode itself expands
 * the file to full PCM, and on a phone exceeding the ceiling is not a catchable
 * error but the OS killing the WebView, so the question comes first.
 * @param byteLength - Encoded file size in bytes
 * @param container - The file's container
 * @param options - Provider-derived preparation options
 * @throws When the file is too large to decode on this platform
 */
function assertDecodable(
	byteLength: number,
	container: AudioContainer,
	options: Pick<AudioPrepOptions, 'engineLabel' | 'originalContainers'>,
): void {
	if (isDecodableSize(byteLength)) {
		return;
	}
	const { acceptedNames } = options.originalContainers;
	if (acceptedNames && !options.originalContainers.accepts(container)) {
		throw new Error(
			tooLargeMessage(`transcribe with ${options.engineLabel}`, {
				desktopAdvice:
					`Record or convert it to ${acceptedNames}, ` +
					'which this engine uploads without decoding.',
			}),
		);
	}
	throw new Error(tooLargeMessage('transcribe'));
}

/**
 * Prepares an audio file into provider-ready payloads.
 *
 * Whole-file path: when {@link sendsWholeFile} holds - the provider reads the
 * original container, the encoded file is within its byte limit, and its length
 * is within the duration cap or left to the endpoint - the original bytes are
 * sent as one payload. No decode, so peak memory is just the file size and any
 * whole-file diarization stays consistent.
 *
 * Decode path: otherwise (a container the provider does not read, an
 * over-limit file, or a recording too long for one request) the file is decoded
 * to 16 kHz mono and split into WAV chunks bounded by `chunkSeconds` (a single
 * chunk when it still fits, e.g. a duration cap the byte proxy could not rule
 * out cheaply). A diarized split is flagged so the caller can warn that speaker
 * numbering may reset between parts.
 *
 * The decode path always emits WAV, even for a single part that fits whole and
 * is in a container the provider reads. Re-sending the original bytes would
 * save the WAV size, but the decode has already taken them (see `raw`); the
 * only cost is a larger upload for the uncommon case of an imported accepted
 * container (mp3/aac/etc.) big enough to miss the cheap whole-file proof yet
 * short enough to fit.
 *
 * The bytes are the run's to give. On the whole-file path they are only read,
 * and every send of the part reads the same buffer. On the decode path they are
 * handed to the browser's decoder, which transfers its input and leaves the
 * caller holding an empty, detached buffer - so a caller passes bytes it will
 * not read again, as the transcribe dialog does with the ones it read for its
 * estimate. Decoding a copy instead would keep them readable at the price of a
 * second copy of the file for the length of the decode, which on a phone is
 * close to the ceiling the decode is bounded by. Nothing downstream needs the
 * original once it is decoded: every part rebuilds its WAV from the kept
 * samples each time it is materialized.
 * @param raw - Encoded file bytes; taken by the decode when one is needed
 * @param fileName - Source file name (used as the upload filename)
 * @param container - The original container, by MIME type and extension
 * @param options - Provider-derived preparation options
 * @returns Prepared payloads ready to transcribe
 * @throws When the file must be decoded and is too large to decode here
 */
export async function prepareAudio(
	raw: ArrayBuffer,
	fileName: string,
	container: AudioContainer,
	options: AudioPrepOptions,
): Promise<PreparedAudio> {
	if (sendsWholeFile(raw.byteLength, container, options)) {
		return {
			payloads: [
				{
					contentType: container.contentType,
					filename: fileName,
					offsetSeconds: 0,
					createData: () => raw,
				},
			],
			diarizationSplitWarning: false,
		};
	}

	assertDecodable(raw.byteLength, container, options);

	// The full decoded PCM stays alive for the whole run (~230 MB for an
	// hour at 16 kHz mono, audit finding 6.8): each chunk's WAV is
	// materialized lazily from a non-copying subarray view, and keeping the
	// samples is what lets a part be re-split on demand when a provider
	// overruns its output token budget. A decode-per-chunk scheme would
	// drop the retention but re-decode the file once per chunk; revisit if
	// long-recording memory pressure ever outweighs that trade.
	const samples = await decodeToMono16k(raw);
	const totalSeconds = samples.length / TRANSCRIBE_SAMPLE_RATE;
	const plans = planChunks(totalSeconds, options.chunkSeconds);
	const multiChunk = plans.length > 1;
	// Build a payload for a plan, retaining the decoded samples so the part can
	// be re-split on demand when a provider overruns its output token budget.
	const buildPayload = (
		plan: ChunkPlan,
		filename: string,
	): PreparedPayload => ({
		contentType: WAV_MIME,
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
 * user's preferred chunk size.
 *
 * Two different limits arrive here and only one of them is about bytes. A
 * per-request duration cap (Gemini, Voxtral) is already the answer the planner
 * needs, so it is passed through as it stands: the whole-file threshold and
 * the split size then agree, and a recording of exactly the cap goes in one
 * request.
 * Converting it into bytes and back used to cost it the WAV header allowance,
 * which is a whole second at 16 kHz mono, so fifteen minutes came out as a
 * part of 899 seconds and a part of one. The user's byte-oriented chunk size
 * targets the Whisper API's 25 MB request limit and does not apply to such a
 * provider.
 *
 * A byte limit is converted, header allowance and all. A network provider
 * honors the user's chunk size within the provider limit; a local provider
 * with no upload limit produces a single part.
 * @param capabilities - The provider's declared capabilities
 * @param engineLabel - The engine's name, for a refusal to name it by
 * @param requiresNetwork - Whether the provider uploads over the network
 * @param userChunkBytes - The user-configured chunk size in bytes
 * @param diarize - Whether speaker diarization is requested for this run
 * @returns Options to pass to {@link prepareAudio}
 */
export function audioPrepOptions(
	capabilities: ProviderCapabilities,
	engineLabel: string,
	requiresNetwork: boolean,
	userChunkBytes: number,
	diarize: boolean,
): AudioPrepOptions {
	const byteBudget = requiresNetwork
		? Math.min(capabilities.maxRequestBytes, userChunkBytes)
		: capabilities.maxRequestBytes;
	const chunkSeconds = Number.isFinite(capabilities.maxRequestSeconds)
		? Math.min(
				capabilities.maxRequestSeconds,
				secondsWithinRequestBytes(capabilities.maxRequestBytes),
			)
		: secondsWithinRequestBytes(byteBudget);
	return {
		maxRequestBytes: capabilities.maxRequestBytes,
		maxRequestSeconds: capabilities.maxRequestSeconds,
		durationCapCheck: capabilities.durationCapCheck,
		originalContainers: capabilities.originalContainers,
		engineLabel,
		chunkSeconds,
		diarize,
	};
}
