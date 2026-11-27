/**
 * Prepares an audio file for a transcription provider, entirely in memory.
 * The cheap path sends the original container bytes untouched (when the
 * provider reads that container and the file fits its limits); an engine that
 * cuts a stretch out of an uploaded file gets the same bytes once and a time
 * span per part; the fallback path decodes to 16 kHz mono and splits into WAV
 * chunks under the limits. No
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
	type AudioClip,
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
	/**
	 * Whether the provider cuts each part out of the recording uploaded once
	 * (see `ProviderCapabilities.clipsUploadedFile`).
	 */
	clipsUploadedFile: boolean;
	/**
	 * Seconds of the part before it that each later part carries, zero when
	 * parts start where the last one ended. Sent whether or not the run labels
	 * speakers: the shared stretch also shows a drift of the earlier part's
	 * timecodes and holds the sentence the seam cut.
	 */
	leadInSeconds: number;
	/**
	 * The recording's length as its container states it, when the caller
	 * read it. What lets a provider that clips plan its parts with no decode.
	 */
	knownDurationSeconds?: number | undefined;
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
	 * End of this payload on the recording timeline, in seconds. Present when
	 * the recording's length is known (so a part can be labelled and
	 * subdivided by its time range); absent for a file sent whole on trust,
	 * whose true duration is never measured.
	 */
	endSeconds?: number;
	/**
	 * How much of the start of this payload belongs to the part before it, in
	 * seconds. The part's own stretch begins this long after
	 * {@link offsetSeconds}; see {@link ownStartSeconds}. Absent when the
	 * payload starts where its part does.
	 */
	leadInSeconds?: number;
	/**
	 * The stretch of the bytes this part is, when {@link createData} returns
	 * the whole recording and the provider cuts the stretch out itself.
	 */
	clip?: AudioClip;
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

/**
 * Where a part's own stretch of the recording begins: after the lead-in it
 * shares with the part before it, when it has one.
 * @param payload - The prepared part
 * @returns The start of the stretch only this part answers for, in seconds
 */
export function ownStartSeconds(
	payload: Pick<PreparedPayload, 'offsetSeconds' | 'leadInSeconds'>,
): number {
	return payload.offsetSeconds + (payload.leadInSeconds ?? 0);
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
 * Clip path: a provider that cuts a stretch out of an uploaded file (see
 * {@link planClips}) gets the original bytes and a time span per part, with
 * no decode, whenever the recording's length is known. It comes first because
 * it keeps that length: a recording of one part is sent whole with its end,
 * which is what its request's output limit and the check of its answer are
 * sized by, even when its bytes alone would prove it short.
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
	const clipped = planClips(raw, fileName, container, options);
	if (clipped) {
		return clipped;
	}

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

	return decodedParts(await decodeToMono16k(raw), options);
}

/**
 * Plans a decoded recording as WAV parts cut from its samples.
 *
 * The full decoded PCM stays alive for the whole run (~230 MB for an hour at
 * 16 kHz mono, audit finding 6.8): each chunk's WAV is materialized lazily
 * from a non-copying subarray view, and keeping the samples is what lets a
 * part be re-split on demand when a provider overruns its output token
 * budget. A decode-per-chunk scheme would drop the retention but re-decode
 * the file once per chunk; revisit if long-recording memory pressure ever
 * outweighs that trade.
 * @param samples - The recording, mono at 16 kHz
 * @param options - Provider-derived preparation options
 * @returns The planned parts
 */
function decodedParts(
	samples: Float32Array,
	options: AudioPrepOptions,
): PreparedAudio {
	const totalSeconds = samples.length / TRANSCRIBE_SAMPLE_RATE;
	const plans = planChunks(totalSeconds, options.chunkSeconds);
	const multiChunk = plans.length > 1;
	const buildPayload = (
		plan: ChunkPlan,
		filename: string,
		leadIn: number,
	): PreparedPayload => {
		const sent = withLeadIn(plan, leadIn);
		return {
			contentType: WAV_MIME,
			filename,
			offsetSeconds: sent.startSeconds,
			endSeconds: plan.endSeconds,
			...(leadIn > 0 ? { leadInSeconds: leadIn } : {}),
			createData: () => extractChunkWav(samples, sent),
			subdivide: () =>
				splitChunkPlan(plan, MIN_SUBDIVIDE_SECONDS).map((half, at) =>
					buildPayload(
						half,
						`audio-${String(half.index)}.wav`,
						at === 0 ? leadIn : options.leadInSeconds,
					),
				),
		};
	};
	return {
		payloads: plans.map((plan) =>
			buildPayload(
				plan,
				multiChunk ? `audio-${String(plan.index)}.wav` : 'audio.wav',
				leadInFor(plan, options.leadInSeconds),
			),
		),
		diarizationSplitWarning: warnsOfSplit(plans.length, options),
	};
}

/**
 * Whether a run split into this many parts tells the user that speaker
 * labels may differ between them. A run whose later parts carry a lead-in
 * has its labels matched across parts instead.
 * @param partCount - How many parts the recording was planned as
 * @param options - Provider-derived preparation options
 * @returns True when the caller should warn
 */
function warnsOfSplit(
	partCount: number,
	options: Pick<AudioPrepOptions, 'diarize' | 'leadInSeconds'>,
): boolean {
	return (
		options.leadInSeconds === 0 &&
		shouldWarnDiarizationSplit(partCount, options.diarize)
	);
}

/**
 * The lead-in a planned part is sent with: none for the part that opens the
 * recording, which has no part before it.
 * @param plan - The planned part
 * @param leadInSeconds - What a later part carries
 * @returns Seconds of the part before it this part is sent with
 */
function leadInFor(plan: ChunkPlan, leadInSeconds: number): number {
	return Math.min(leadInSeconds, plan.startSeconds);
}

/**
 * The stretch actually sent for a part: its plan, started early by its
 * lead-in.
 * @param plan - The part's own stretch
 * @param leadIn - Seconds of the part before it to send as well
 * @returns The plan the audio is cut by
 */
function withLeadIn(plan: ChunkPlan, leadIn: number): ChunkPlan {
	return { ...plan, startSeconds: plan.startSeconds - leadIn };
}

/**
 * The length a provider that clips can plan this recording by, or null when
 * it cannot: the provider does not clip, does not read this container, the
 * file is over its byte limit, or nobody read the length.
 * @param byteLength - Encoded file size in bytes
 * @param container - The original container
 * @param options - Provider-derived preparation options
 * @returns The recording's length in seconds, or null
 */
function clippableSeconds(
	byteLength: number,
	container: AudioContainer,
	options: AudioPrepOptions,
): number | null {
	const totalSeconds = options.knownDurationSeconds ?? Number.NaN;
	const applies =
		options.clipsUploadedFile &&
		Number.isFinite(totalSeconds) &&
		totalSeconds > 0 &&
		options.originalContainers.accepts(container) &&
		byteLength <= options.maxRequestBytes;
	return applies ? totalSeconds : null;
}

/**
 * Plans a recording as time spans of its own bytes, for a provider that cuts
 * each span out of the file it was sent once. Nothing is decoded: the spans
 * come from the length the container states, so peak memory stays at the
 * encoded file and the upload is the recording as it was recorded.
 *
 * Null when this path does not apply (see {@link clippableSeconds}), which
 * leaves the decode path, which measures the recording, to plan the parts.
 * @param raw - Encoded file bytes, only ever read
 * @param fileName - Source file name, the upload's name
 * @param container - The original container
 * @param options - Provider-derived preparation options
 * @returns The planned parts, or null when this path does not apply
 */
function planClips(
	raw: ArrayBuffer,
	fileName: string,
	container: AudioContainer,
	options: AudioPrepOptions,
): PreparedAudio | null {
	const totalSeconds = clippableSeconds(raw.byteLength, container, options);
	if (totalSeconds === null) {
		return null;
	}
	const whole: WholeUpload = {
		contentType: container.contentType,
		filename: fileName,
		createData: () => raw,
	};
	const plans = planChunks(totalSeconds, options.chunkSeconds);
	const [single] = plans;
	if (plans.length === 1 && single) {
		// Short enough for one request: the file goes as it is, and its known
		// end is what lets the answer be held against its length. Its request
		// carries an output limit like any other, so an answer cut at it is
		// asked for again as two stretches of the same file.
		return {
			payloads: [
				{
					...whole,
					offsetSeconds: 0,
					endSeconds: totalSeconds,
					subdivide: () =>
						clipHalves(whole, single, 0, options.leadInSeconds),
				},
			],
			diarizationSplitWarning: false,
		};
	}
	return {
		payloads: plans.map((plan) =>
			clipOf(
				whole,
				plan,
				leadInFor(plan, options.leadInSeconds),
				options.leadInSeconds,
			),
		),
		diarizationSplitWarning: warnsOfSplit(plans.length, options),
	};
}

/** The recording as it is uploaded, which every part cut from it is lent. */
type WholeUpload = Pick<
	PreparedPayload,
	'contentType' | 'filename' | 'createData'
>;

/**
 * One stretch of an uploaded recording, as the part the provider cuts out.
 * @param whole - The recording as it is uploaded
 * @param plan - The part's own stretch
 * @param leadIn - Seconds of the part before it that this part is sent with
 * @param laterLeadIn - What a part that follows another carries
 * @returns The part
 */
function clipOf(
	whole: WholeUpload,
	plan: ChunkPlan,
	leadIn: number,
	laterLeadIn: number,
): PreparedPayload {
	const sent = withLeadIn(plan, leadIn);
	return {
		...whole,
		offsetSeconds: sent.startSeconds,
		endSeconds: plan.endSeconds,
		...(leadIn > 0 ? { leadInSeconds: leadIn } : {}),
		clip: { startSeconds: sent.startSeconds, endSeconds: plan.endSeconds },
		subdivide: () => clipHalves(whole, plan, leadIn, laterLeadIn),
	};
}

/**
 * The two halves a stretch is asked for again in, once its answer was cut at
 * the output limit: the first keeps the stretch's own lead-in, and the second
 * follows the first, so it carries the lead-in of a later part. None when a
 * half would be shorter than the floor.
 * @param whole - The recording as it is uploaded
 * @param plan - The stretch to split
 * @param leadIn - The lead-in the stretch itself was sent with
 * @param laterLeadIn - What a part that follows another carries
 * @returns The halves, or none
 */
function clipHalves(
	whole: WholeUpload,
	plan: ChunkPlan,
	leadIn: number,
	laterLeadIn: number,
): PreparedPayload[] {
	return splitChunkPlan(plan, MIN_SUBDIVIDE_SECONDS).map((half, at) =>
		clipOf(whole, half, at === 0 ? leadIn : laterLeadIn, laterLeadIn),
	);
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
		clipsUploadedFile: capabilities.clipsUploadedFile,
		// The lead-in serves every run, labelled or not: the lines both parts
		// hear show how far the earlier one's timecodes drifted, and the
		// sentence the seam cuts is taken whole from the later part.
		leadInSeconds: capabilities.partLeadInSeconds,
	};
}
