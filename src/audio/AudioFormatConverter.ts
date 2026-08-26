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
 * Converts a compressed audio blob to the target format on the main
 * thread through the shared streaming conversion core (see
 * streamingConversion.ts, also used by the encoding worker).
 * @param recordedBlob - Intermediate compressed blob
 * @param targetFormat - Desired output format
 * @param bitrate - Bitrate in bits per second
 * @param allowRemux - Allow packet copy when the codecs match
 * @param onProgress - Optional encoding progress callback (0-100)
 * @returns Re-encoded blob in the target format
 * @throws Error when the target format has no codec mapping, the
 * input has no audio track, or the conversion cannot process the
 * audio track (the caller falls back to decode and re-encode)
 */
async function convertBlobWithConversion(
	recordedBlob: Blob,
	targetFormat: string,
	bitrate: number,
	allowRemux: boolean,
	onProgress?: FormatProgressCallback,
	channelMode: ChannelMode = CHANNEL_MODE_SOURCE,
): Promise<Blob> {
	const resultBuffer = await runStreamingConversion(
		recordedBlob,
		targetFormat,
		bitrate,
		allowRemux,
		onProgress,
		channelMode,
	);
	return new Blob([resultBuffer], {
		type: `${MIME_TYPE_AUDIO_PREFIX}${targetFormat}`,
	});
}

/**
 * Decodes an intermediate blob and re-encodes it to the target format.
 * Tries the streaming Conversion pipeline first and falls back to the
 * full decode-then-encode path on any failure, so every format keeps
 * working even when the input container is not readable by mediabunny.
 * @param recordedBlob - Intermediate compressed blob
 * @param targetFormat - Desired output format
 * @param bitrate - Bitrate in bits per second
 * @param onProgress - Optional encoding progress callback (0-100)
 * @param options - Conversion behavior options
 * @returns Re-encoded blob in the target format
 */
export async function convertBlobToFormat(
	recordedBlob: Blob,
	targetFormat: string,
	bitrate: number,
	onProgress?: FormatProgressCallback,
	options: BlobConversionOptions = {},
): Promise<Blob> {
	// Worker first: the demux/transcode/mux loop is pure computation
	// and runs off the UI thread when the worker is available
	const channelMode = options.channelMode ?? CHANNEL_MODE_SOURCE;
	const workerClient =
		options.workerClient && options.workerClient.isAvailable()
			? options.workerClient
			: null;
	if (workerClient) {
		try {
			return await workerClient.convertBlob(
				recordedBlob,
				targetFormat,
				bitrate,
				options.allowRemux ?? false,
				channelMode,
				onProgress,
			);
		} catch (error) {
			console.warn(
				`${PLUGIN_LOG_PREFIX} Worker conversion failed, falling back to the main thread:`,
				error,
			);
		}
	}

	try {
		return await convertBlobWithConversion(
			recordedBlob,
			targetFormat,
			bitrate,
			options.allowRemux ?? false,
			onProgress,
			channelMode,
		);
	} catch (error) {
		console.warn(
			`${PLUGIN_LOG_PREFIX} Streaming conversion failed, falling back to decode and re-encode:`,
			error,
		);
	}

	const arrayBuffer = await recordedBlob.arrayBuffer();
	const decodedBuffer = await decodeAudioBlob(arrayBuffer, 'convert');

	return encodeAudioBuffer(
		downmixAudioBuffer(decodedBuffer, channelMode),
		{ format: targetFormat, bitrate },
		onProgress,
	);
}

/**
 * Like {@link convertBlobToFormat} but returns the raw bytes, for callers
 * that hand the result straight to vault.createBinary. The streaming path
 * returns its buffer directly instead of wrapping it in a Blob that the
 * caller would immediately read back out - two avoided copies of the
 * whole converted file. The worker and decode fallbacks still produce a
 * Blob internally and read it once, exactly as the Blob-returning path's
 * callers did before.
 * @param recordedBlob - Intermediate compressed blob
 * @param targetFormat - Desired output format
 * @param bitrate - Bitrate in bits per second
 * @param onProgress - Optional encoding progress callback (0-100)
 * @param options - Conversion behavior options
 * @returns Re-encoded bytes in the target format
 */
export async function convertBlobToFormatBuffer(
	recordedBlob: Blob,
	targetFormat: string,
	bitrate: number,
	onProgress?: FormatProgressCallback,
	options: BlobConversionOptions = {},
): Promise<ArrayBuffer> {
	const channelMode = options.channelMode ?? CHANNEL_MODE_SOURCE;
	const workerClient =
		options.workerClient && options.workerClient.isAvailable()
			? options.workerClient
			: null;
	if (workerClient) {
		try {
			const converted = await workerClient.convertBlob(
				recordedBlob,
				targetFormat,
				bitrate,
				options.allowRemux ?? false,
				channelMode,
				onProgress,
			);
			return await converted.arrayBuffer();
		} catch (error) {
			console.warn(
				`${PLUGIN_LOG_PREFIX} Worker conversion failed, falling back to the main thread:`,
				error,
			);
		}
	}

	try {
		return await runStreamingConversion(
			recordedBlob,
			targetFormat,
			bitrate,
			options.allowRemux ?? false,
			onProgress,
			channelMode,
		);
	} catch (error) {
		console.warn(
			`${PLUGIN_LOG_PREFIX} Streaming conversion failed, falling back to decode and re-encode:`,
			error,
		);
	}

	const arrayBuffer = await recordedBlob.arrayBuffer();
	const decodedBuffer = await decodeAudioBlob(arrayBuffer, 'convert');
	const encoded = await encodeAudioBuffer(
		downmixAudioBuffer(decodedBuffer, channelMode),
		{ format: targetFormat, bitrate },
		onProgress,
	);
	return encoded.arrayBuffer();
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
