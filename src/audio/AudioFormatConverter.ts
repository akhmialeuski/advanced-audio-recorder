/**
 * Audio format conversion and track processing utilities.
 * Handles format resolution, blob conversion, and multi-track merging.
 * @module audio/AudioFormatConverter
 */

import type { RecordingTarget } from '../types';
import { encodeAudioBuffer, isOfflineEncodingSupported } from './AudioEncoder';
import { runStreamingConversion } from './streamingConversion';
import {
	CHANNEL_MODE_SOURCE,
	downmixAudioBuffer,
	type ChannelMode,
} from './downmix';
import { autoClosing } from '../utils/disposables';
import { isDecodableSize, tooLargeMessage } from '../platform/capabilities';
import {
	MIME_TYPE_AUDIO_PREFIX,
	PLUGIN_LOG_PREFIX,
	FORMAT_WAV,
} from '../constants';
import { COMPRESSED_INTERMEDIATE_FORMATS } from './formatRegistry';
import {
	buildMimeType,
	directRecordingMimeType,
} from './AudioCapabilityDetector';
import type { EncodingWorkerClient } from './EncodingWorkerClient';

/**
 * Progress callback receiving percentage (0-100).
 */
export type FormatProgressCallback = (percent: number) => void;

/**
 * Function that builds a Blob from a RecordingTarget.
 */
export type TrackBlobBuilder = (
	target: RecordingTarget,
) => Promise<Blob | null>;

/**
 * Resolves the recorder format and MIME type for MediaRecorder.
 * If the output format is not natively supported, selects an
 * intermediate compressed format (WebM, OGG, or MP4 - in registry
 * order, so opus containers are preferred where they exist and iOS
 * falls back to its only recordable container, audio/mp4).
 * @param format - Effective output format of the session
 * @returns Recorder format string and MIME type
 */
export function resolveRecorderFormat(format: string): {
	recorderFormat: string;
	mimeType: string;
} {
	const outputFormat = format.toLowerCase();

	// Check if MediaRecorder supports this format directly (via its
	// plain or canonical container MIME - m4a records as audio/mp4)
	const nativeMime = directRecordingMimeType(outputFormat);
	if (outputFormat !== FORMAT_WAV && nativeMime !== null) {
		return { recorderFormat: outputFormat, mimeType: nativeMime };
	}

	// WAV and offline-only formats need an intermediate compressed format
	for (const format of COMPRESSED_INTERMEDIATE_FORMATS) {
		const mimeType = buildMimeType(format);
		if (MediaRecorder.isTypeSupported(mimeType)) {
			return { recorderFormat: format, mimeType };
		}
	}
	throw new Error(
		`Output format "${outputFormat}" requires an intermediate compressed format, but none of ${COMPRESSED_INTERMEDIATE_FORMATS.join(
			', ',
		)} is supported in this browser.`,
	);
}

/**
 * Checks if a format requires offline encoding (not natively
 * supported by MediaRecorder) and the recorder uses an intermediate format.
 * @param format - Target output format
 * @param activeRecorderFormat - Format currently used by MediaRecorder
 * @returns true if offline-only encoding is needed
 */
export function isOfflineOnlyFormat(
	format: string,
	activeRecorderFormat: string,
): boolean {
	return (
		format !== FORMAT_WAV &&
		activeRecorderFormat !== format &&
		isOfflineEncodingSupported(format)
	);
}

/**
 * Converts a compressed audio blob to WAV format through the
 * streaming mediabunny pipeline (with the decode-and-re-encode
 * fallback of convertBlobToFormat). PCM output has no bitrate.
 * @param recordedBlob - Compressed audio blob
 * @returns WAV blob
 */
export async function convertBlobToWav(
	recordedBlob: Blob,
	options: BlobConversionOptions = {},
): Promise<Blob> {
	return convertBlobToFormat(recordedBlob, FORMAT_WAV, 0, undefined, options);
}

/**
 * Like {@link convertBlobToWav} but returns the raw bytes, for callers
 * that hand the result straight to vault.createBinary. On the streaming
 * path this skips a Blob wrap plus a full read-back of the converted
 * audio (two whole-file copies).
 * @param recordedBlob - Compressed audio blob
 * @returns WAV bytes
 */
export async function convertBlobToWavBuffer(
	recordedBlob: Blob,
	options: BlobConversionOptions = {},
): Promise<ArrayBuffer> {
	return convertBlobToFormatBuffer(
		recordedBlob,
		FORMAT_WAV,
		0,
		undefined,
		options,
	);
}

/**
 * Decodes compressed audio bytes into an AudioBuffer.
 * Decodes exactly once: decodeAudioData resamples to the context rate
 * by spec, so the previous probe-then-redecode-at-native-rate approach
 * produced an identical buffer while doubling decode time and peak
 * memory (two full PCM copies of the recording).
 * @param arrayBuffer - Encoded audio file bytes
 * @param action - What the user asked for, named as a verb phrase, for the
 *   refusal when the file will not fit under the decode ceiling. Named by the
 *   caller because only the caller knows it: the ceiling belongs here, where
 *   the allocation is, but "decode" is the name of the allocation and not of
 *   anything anybody asked for, and it is what a desktop user converting an
 *   oversized file was told
 * @returns Decoded AudioBuffer
 */
export async function decodeAudioBlob(
	arrayBuffer: ArrayBuffer,
	action = 'open',
): Promise<AudioBuffer> {
	// Asked here rather than by each caller. The ceiling exists because this
	// call is the allocation - it expands the file to full PCM in memory - and
	// on a phone exceeding it is not a catchable error but the OS killing the
	// WebView. Applied per caller it was applied per caller who remembered:
	// the waveform, cleanup, the splitter and the metadata read all asked,
	// and conversion, added later, did not. Asked before the context is built,
	// because the allocation starts there.
	if (!isDecodableSize(arrayBuffer.byteLength)) {
		throw new Error(tooLargeMessage(action));
	}
	// Closed even when decoding fails (corrupted/unsupported input),
	// otherwise the AudioContext leaks
	await using audioContext = autoClosing(new AudioContext());
	return await audioContext.decodeAudioData(arrayBuffer);
}

/**
 * Options controlling blob-to-format conversion behavior.
 */
export interface BlobConversionOptions {
	/**
	 * Allows copying the audio packets without re-encoding (remux)
	 * when the input codec already matches the target codec. Remux
	 * ignores the requested bitrate, so it is only safe when the
	 * input is known to be encoded at that bitrate already (the
	 * recording pipeline configures the recorder with the session
	 * bitrate). Conversions driven by an explicit user bitrate
	 * choice must leave this off so the selection is always honored.
	 */
	allowRemux?: boolean;
	/**
	 * Encoding worker to offload the conversion to. When absent or
	 * unavailable, the conversion runs on the main thread.
	 */
	workerClient?: EncodingWorkerClient | null;
	/**
	 * Channel layout for the converted audio: keep the source layout
	 * or downmix to mono (mix or one picked channel). Applied by every
	 * execution path - worker, streaming, and decode fallback.
	 */
	channelMode?: ChannelMode;
}

/**
 * How a ladder step's result reaches the caller.
 *
 * The three steps do not agree on a shape: the worker and the decode fallback
 * hand back a Blob, while the streaming step hands back the bytes it muxed.
 * Whichever shape a caller wants, one of the two has to be converted, and
 * naming both conversions here is what lets the ladder be written once. It also
 * keeps each conversion off the path that never needed it, so the caller that
 * wants bytes still does not wrap a Blob it would immediately read back.
 */
interface LadderResult<T> {
	/** Delivers a step that produced a Blob. */
	fromBlob(blob: Blob): Promise<T>;
	/** Delivers a step that produced raw bytes. */
	fromBuffer(buffer: ArrayBuffer, targetFormat: string): Promise<T>;
}

/** Delivers the conversion as a Blob, for callers that play or upload it. */
const AS_BLOB: LadderResult<Blob> = {
	fromBlob: (blob) => Promise.resolve(blob),
	fromBuffer: (buffer, targetFormat) =>
		Promise.resolve(
			new Blob([buffer], {
				type: `${MIME_TYPE_AUDIO_PREFIX}${targetFormat}`,
			}),
		),
};

/** Delivers the conversion as bytes, for callers that write it to the vault. */
const AS_BUFFER: LadderResult<ArrayBuffer> = {
	fromBlob: (blob) => blob.arrayBuffer(),
	fromBuffer: (buffer) => Promise.resolve(buffer),
};

/**
 * Runs the three ways of producing the target format in order of cost,
 * stopping at the first that succeeds: the encoding worker, the streaming
 * Conversion pipeline on the main thread, and a full decode followed by a
 * re-encode.
 *
 * Each step down is a real loss - the worker keeps the demux and transcode
 * loop off the UI thread, and streaming keeps memory bounded - so a step is
 * only abandoned when it throws, and it says in the log why. The last step
 * throws to the caller: by then there is nothing left to fall back to.
 * @param recordedBlob - Intermediate compressed blob
 * @param targetFormat - Desired output format
 * @param bitrate - Bitrate in bits per second
 * @param onProgress - Optional encoding progress callback (0-100)
 * @param options - Conversion behavior options
 * @param deliver - How each step's result reaches the caller
 * @returns The converted audio in the shape `deliver` produces
 */
async function runConversionLadder<T>(
	recordedBlob: Blob,
	targetFormat: string,
	bitrate: number,
	onProgress: FormatProgressCallback | undefined,
	options: BlobConversionOptions,
	deliver: LadderResult<T>,
): Promise<T> {
	const channelMode = options.channelMode ?? CHANNEL_MODE_SOURCE;
	const allowRemux = options.allowRemux ?? false;
	const workerClient =
		options.workerClient && options.workerClient.isAvailable()
			? options.workerClient
			: null;

	if (workerClient) {
		try {
			return await deliver.fromBlob(
				await workerClient.convertBlob(
					recordedBlob,
					targetFormat,
					bitrate,
					allowRemux,
					channelMode,
					onProgress,
				),
			);
		} catch (error) {
			console.warn(
				`${PLUGIN_LOG_PREFIX} Worker conversion failed, falling back to the main thread:`,
				error,
			);
		}
	}

	try {
		return await deliver.fromBuffer(
			await runStreamingConversion(
				recordedBlob,
				targetFormat,
				bitrate,
				allowRemux,
				onProgress,
				channelMode,
			),
			targetFormat,
		);
	} catch (error) {
		console.warn(
			`${PLUGIN_LOG_PREFIX} Streaming conversion failed, falling back to decode and re-encode:`,
			error,
		);
	}

	const arrayBuffer = await recordedBlob.arrayBuffer();
	const decodedBuffer = await decodeAudioBlob(arrayBuffer, 'convert');
	return deliver.fromBlob(
		await encodeAudioBuffer(
			downmixAudioBuffer(decodedBuffer, channelMode),
			{ format: targetFormat, bitrate },
			onProgress,
		),
	);
}

/**
 * Converts an intermediate blob to the target format, returning a Blob.
 * @param recordedBlob - Intermediate compressed blob
 * @param targetFormat - Desired output format
 * @param bitrate - Bitrate in bits per second
 * @param onProgress - Optional encoding progress callback (0-100)
 * @param options - Conversion behavior options
 * @returns Re-encoded blob in the target format
 */
export function convertBlobToFormat(
	recordedBlob: Blob,
	targetFormat: string,
	bitrate: number,
	onProgress?: FormatProgressCallback,
	options: BlobConversionOptions = {},
): Promise<Blob> {
	return runConversionLadder(
		recordedBlob,
		targetFormat,
		bitrate,
		onProgress,
		options,
		AS_BLOB,
	);
}

/**
 * Like {@link convertBlobToFormat} but returns the raw bytes, for callers that
 * hand the result straight to vault.createBinary. The streaming step returns
 * its buffer directly instead of wrapping it in a Blob the caller would
 * immediately read back out - two avoided copies of the whole converted file.
 * @param recordedBlob - Intermediate compressed blob
 * @param targetFormat - Desired output format
 * @param bitrate - Bitrate in bits per second
 * @param onProgress - Optional encoding progress callback (0-100)
 * @param options - Conversion behavior options
 * @returns Re-encoded bytes in the target format
 */
export function convertBlobToFormatBuffer(
	recordedBlob: Blob,
	targetFormat: string,
	bitrate: number,
	onProgress?: FormatProgressCallback,
	options: BlobConversionOptions = {},
): Promise<ArrayBuffer> {
	return runConversionLadder(
		recordedBlob,
		targetFormat,
		bitrate,
		onProgress,
		options,
		AS_BUFFER,
	);
}

/** How one merged track is placed: its multiplier into each output channel. */
export interface TrackLevels {
	/** Multiplier into the left, or only, output channel. */
	left: number;
	/** Multiplier into the right output channel. */
	right: number;
}

/** A track left where it was captured, which is what an unplaced one is. */
const CENTRED: TrackLevels = { left: 1, right: 1 };

/**
 * Where the tracks of a merge sit, and whether they are levelled first.
 *
 * Handed in rather than read here, because where a track sits belongs to the
 * recording session and the rules that turn decibels and a position into
 * multipliers belong beside the streaming mixer that already applies them. A
 * session merged by either route then comes out the same, which is the whole
 * point: these controls were silently ignored on this route, so a level and a
 * position set on a session recorded to anything but desktop WAV did nothing.
 */
export interface MergePlacement {
	/**
	 * Multipliers into each output channel, one per target and aligned with
	 * them. A track with no entry stays where it was captured.
	 */
	readonly levels: readonly TrackLevels[];
	/**
	 * Brings one track to the shared level from the level it was measured at,
	 * given as a share of full scale. Absent when the session does not align
	 * levels, which is what makes alignment cost nothing when it is off.
	 */
	readonly normalize?: ((rms: number) => number) | undefined;
}

/** One decoded track, with the placement its own target carries. */
interface PlacedTrack {
	buffer: AudioBuffer;
	levels: TrackLevels;
}

/**
 * How loud one decoded track is, as a share of full scale, across every
 * channel it carries.
 * @param buffer - The decoded track
 * @returns Its root mean square, between 0 and 1
 */
function bufferRms(buffer: AudioBuffer): number {
	let sum = 0;
	let count = 0;
	for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
		const data = buffer.getChannelData(channel);
		for (const sample of data) {
			sum += sample * sample;
		}
		count += data.length;
	}
	return count === 0 ? 0 : Math.sqrt(sum / count);
}

/**
 * Spreads a mono track across the two channels of a stereo mix at its own
 * multiplier for each side, which is what panning one means: a mono buffer
 * has one channel and nowhere to put a side.
 * @param buffer - The mono track
 * @param left - Multiplier into the left channel
 * @param right - Multiplier into the right channel
 * @param context - Builds the two-channel buffer
 * @returns A stereo buffer holding the placed track
 */
function spreadMonoToStereo(
	buffer: AudioBuffer,
	left: number,
	right: number,
	context: BaseAudioContext,
): AudioBuffer {
	const source = buffer.getChannelData(0);
	const spread = context.createBuffer(2, buffer.length, buffer.sampleRate);
	const leftChannel = spread.getChannelData(0);
	const rightChannel = spread.getChannelData(1);
	// Walked as a view rather than by index: iterating a typed array yields a
	// number, where an indexed read yields one that might be missing and
	// needs a fallback no sample can ever reach.
	let frame = 0;
	for (const sample of source) {
		leftChannel[frame] = sample * left;
		rightChannel[frame] = sample * right;
		frame++;
	}
	return spread;
}

/**
 * Multiplies a track's channels in place, the first by the left figure and
 * the second, where there is one, by the right.
 * @param buffer - The track to scale
 * @param left - Multiplier for the first channel
 * @param right - Multiplier for the second channel
 */
function scaleChannels(buffer: AudioBuffer, left: number, right: number): void {
	for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
		// The first channel takes the left figure and every other the right,
		// which is exactly the pair for the one and two channel tracks a mix
		// is made of. A source carrying more is downmixed by the graph, and
		// the two figures are equal whenever nothing was panned at all.
		const factor = channel === 0 ? left : right;
		const data = buffer.getChannelData(channel);
		let frame = 0;
		for (const sample of data) {
			data[frame] = sample * factor;
			frame++;
		}
	}
}

/**
 * Interleaved channels the merge is rendered at.
 *
 * Mono when every input is mono and nothing is panned: a stereo render would
 * duplicate the mix into both channels while doubling encode time and file
 * size. A track placed off centre takes the mix to stereo whatever its own
 * channel count, which is the rule the streaming mixer's layout applies too -
 * two mono microphones one to each side is the reason panning exists.
 * @param tracks - The decoded tracks with their placement
 * @returns 1 or 2
 */
function mergeChannelCount(tracks: readonly PlacedTrack[]): number {
	if (tracks.some((track) => track.levels.left !== track.levels.right)) {
		return 2;
	}
	return Math.min(
		2,
		Math.max(...tracks.map((track) => track.buffer.numberOfChannels)),
	);
}

/**
 * Applies each track's placement to the samples it is summed from.
 *
 * Written onto the decoded buffers rather than built as a graph of gain and
 * panner nodes, because the panning here is the balance law the streaming
 * mixer uses, where the centre leaves both sides at full level. A
 * StereoPannerNode applies the constant-power law instead, which would put
 * the centre at 0.707 and quieten by 3 dB every mix nobody panned. One rule
 * shared with the other route is worth more than the node count.
 *
 * A track nothing was asked of is handed back untouched, so the common
 * session pays nothing for the capability and its mix is the sum it has
 * always been.
 * @param tracks - The decoded tracks with the placement each carries
 * @param channelCount - Interleaved channels of the mix
 * @param context - Builds the buffer a panned mono track needs
 * @param normalize - Brings a track to the shared level, when aligning
 * @returns The buffers to sum, in the order given
 */
function placeTracks(
	tracks: readonly PlacedTrack[],
	channelCount: number,
	context: BaseAudioContext,
	normalize: ((rms: number) => number) | undefined,
): AudioBuffer[] {
	return tracks.map((track) => {
		const level = normalize ? normalize(bufferRms(track.buffer)) : 1;
		const left = track.levels.left * level;
		const right = track.levels.right * level;
		if (left === 1 && right === 1) {
			return track.buffer;
		}
		if (channelCount === 2 && track.buffer.numberOfChannels === 1) {
			return spreadMonoToStereo(track.buffer, left, right, context);
		}
		scaleChannels(track.buffer, left, right);
		return track.buffer;
	});
}

/**
 * Brings a rendered mix onto the output range, in place.
 *
 * The sum of several tracks routinely lands past full scale, and clipping it
 * is what turns two people talking at once into distortion. Scaling the whole
 * mix by one factor instead keeps the balance between the tracks and costs
 * only level, which is the trade the streaming mixer makes for the same
 * reason. A mix that never reached full scale is left exactly as it was
 * rendered.
 * @param buffer - The rendered mix
 * @returns The same buffer, scaled where it needed it
 */
function applyHeadroom(buffer: AudioBuffer): AudioBuffer {
	const channels: Float32Array[] = [];
	let peak = 0;
	for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
		const data = buffer.getChannelData(channel);
		channels.push(data);
		for (const sample of data) {
			peak = Math.max(peak, Math.abs(sample));
		}
	}
	if (peak <= 1) {
		return buffer;
	}
	const scale = 1 / peak;
	for (const data of channels) {
		let frame = 0;
		for (const sample of data) {
			data[frame] = sample * scale;
			frame++;
		}
	}
	return buffer;
}

/**
 * Merges multiple audio tracks into a single mixed audio blob. The
 * caller resolves the encodable target format (and names the output
 * file from it), so it is passed in instead of being recomputed from
 * live settings - a settings change during the potentially long mix
 * could otherwise make the file extension and the encoded content
 * diverge.
 *
 * Memory: every track is decoded to a full AudioBuffer and mixed through
 * an OfflineAudioContext, so peak memory scales with total session PCM
 * (audit finding 6.4). This path is a deliberate fallback - it is reached
 * only when the streaming mix cannot apply (tryStreamMixToWav covers PCM
 * tracks written as WAV) - and should be revisited if the streaming mixer
 * ever learns to write a compressed format.
 * @param chunkTargets - Recording targets for each track
 * @param targetFormat - Resolved encodable output format
 * @param bitrate - Encoder bitrate in bits per second
 * @param isWavPcmRecording - Whether recording uses PCM/WAV path
 * @param buildPcmTrackWavBlob - Function to build WAV blob from PCM target
 * @param buildTrackBlob - Function to build blob from MediaRecorder target
 * @param onProgress - Optional progress callback (percent, description)
 * @param placement - Where the tracks sit; absent leaves them as captured
 * @returns Merged audio blob in the target format
 */
export async function mergeAudioTracks(
	chunkTargets: RecordingTarget[],
	targetFormat: string,
	bitrate: number,
	isWavPcmRecording: boolean,
	buildPcmTrackWavBlob: TrackBlobBuilder,
	buildTrackBlob: TrackBlobBuilder,
	onProgress?: (percent: number, description: string) => void,
	placement?: MergePlacement,
): Promise<Blob> {
	const audioContext = new AudioContext();
	let renderedBuffer: AudioBuffer;
	try {
		const decoded = await Promise.all(
			chunkTargets.map(async (target, index) => {
				const blob = isWavPcmRecording
					? await buildPcmTrackWavBlob(target)
					: await buildTrackBlob(target);
				if (!blob) {
					return null;
				}
				const arrayBuffer = await blob.arrayBuffer();
				return {
					buffer: await audioContext.decodeAudioData(arrayBuffer),
					// Read against the target's own index, before the tracks
					// that recorded nothing are dropped: the placement is
					// aligned with the targets, and filtering first shifts
					// every track after a silent one into another's place.
					levels: placement?.levels[index] ?? CENTRED,
				};
			}),
		);

		const tracks = decoded.filter(
			(track): track is PlacedTrack => track !== null,
		);
		if (tracks.length === 0) {
			throw new Error('No audio data recorded');
		}

		const longestDuration = Math.max(
			...tracks.map((track) => track.buffer.duration),
		);
		const channelCount = mergeChannelCount(tracks);
		const offlineContext = new OfflineAudioContext(
			channelCount,
			audioContext.sampleRate * longestDuration,
			audioContext.sampleRate,
		);

		for (const buffer of placeTracks(
			tracks,
			channelCount,
			offlineContext,
			placement?.normalize,
		)) {
			const source = offlineContext.createBufferSource();
			source.buffer = buffer;
			source.connect(offlineContext.destination);
			source.start(0);
		}

		renderedBuffer = await offlineContext.startRendering();
	} finally {
		// Close on every path: empty input, a failed decode, and a
		// failed render otherwise leak the AudioContext. A close failure
		// must not mask the original error.
		await audioContext.close().catch((error: unknown) => {
			console.warn(
				`${PLUGIN_LOG_PREFIX} Failed to close AudioContext after track merge:`,
				error,
			);
		});
	}

	return encodeAudioBuffer(
		applyHeadroom(renderedBuffer),
		{
			format: targetFormat,
			bitrate,
		},
		(percent) => {
			onProgress?.(40 + Math.round(percent * 0.2), 'Encoding audio...');
		},
	);
}
