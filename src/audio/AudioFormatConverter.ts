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
 * tracks with matching sample rates) - and should be revisited if the
 * streaming mixer ever grows resampling support for mismatched rates.
 * @param chunkTargets - Recording targets for each track
 * @param targetFormat - Resolved encodable output format
 * @param bitrate - Encoder bitrate in bits per second
 * @param isWavPcmRecording - Whether recording uses PCM/WAV path
 * @param buildPcmTrackWavBlob - Function to build WAV blob from PCM target
 * @param buildTrackBlob - Function to build blob from MediaRecorder target
 * @param onProgress - Optional progress callback (percent, description)
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
): Promise<Blob> {
	const audioContext = new AudioContext();
	let renderedBuffer: AudioBuffer;
	try {
		const buffers = await Promise.all(
			chunkTargets.map(async (target) => {
				const blob = isWavPcmRecording
					? await buildPcmTrackWavBlob(target)
					: await buildTrackBlob(target);
				if (!blob) {
					return null;
				}
				const arrayBuffer = await blob.arrayBuffer();
				return audioContext.decodeAudioData(arrayBuffer);
			}),
		);

		const validBuffers = buffers.filter(
			(buffer): buffer is AudioBuffer => buffer !== null,
		);
		if (validBuffers.length === 0) {
			throw new Error('No audio data recorded');
		}

		const longestDuration = Math.max(
			...validBuffers.map((buffer) => buffer.duration),
		);
		// Mix in mono when every input is mono: a stereo render would just
		// duplicate the mix into both channels while doubling encode time
		// and file size. Any stereo input keeps the stereo render.
		const channelCount = Math.min(
			2,
			Math.max(...validBuffers.map((buffer) => buffer.numberOfChannels)),
		);
		const offlineContext = new OfflineAudioContext(
			channelCount,
			audioContext.sampleRate * longestDuration,
			audioContext.sampleRate,
		);

		validBuffers.forEach((buffer) => {
			const source = offlineContext.createBufferSource();
			source.buffer = buffer;
			source.connect(offlineContext.destination);
			source.start(0);
		});

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
		renderedBuffer,
		{
			format: targetFormat,
			bitrate,
		},
		(percent) => {
			onProgress?.(40 + Math.round(percent * 0.2), 'Encoding audio...');
		},
	);
}
