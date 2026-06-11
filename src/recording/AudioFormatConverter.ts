/**
 * Audio format conversion and track processing utilities.
 * Handles format resolution, blob conversion, and multi-track merging.
 * @module recording/AudioFormatConverter
 */

import type { RecordingTarget } from '../types';
import type { AudioRecorderSettings } from '../settings/Settings';
import { bufferToWave } from './WavEncoder';
import { encodeAudioBuffer, isOfflineEncodingSupported } from './AudioEncoder';
import { MIME_TYPE_AUDIO_PREFIX } from '../constants';
import {
	buildMimeType,
	FORMAT_WEBM,
	FORMAT_OGG,
	FORMAT_WAV,
} from './AudioCapabilityDetector';

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
 * intermediate compressed format (WebM or OGG).
 * @param settings - Plugin settings
 * @returns Recorder format string and MIME type
 */
export function resolveRecorderFormat(settings: AudioRecorderSettings): {
	recorderFormat: string;
	mimeType: string;
} {
	const outputFormat = settings.recordingFormat.toLowerCase();

	// Check if MediaRecorder natively supports this format
	const nativeMime = buildMimeType(outputFormat);
	if (
		outputFormat !== FORMAT_WAV &&
		MediaRecorder.isTypeSupported(nativeMime)
	) {
		return { recorderFormat: outputFormat, mimeType: nativeMime };
	}

	// WAV and offline-only formats need an intermediate compressed format
	const preferredCompressedFormats = [FORMAT_WEBM, FORMAT_OGG];
	for (const format of preferredCompressedFormats) {
		const mimeType = buildMimeType(format);
		if (MediaRecorder.isTypeSupported(mimeType)) {
			return { recorderFormat: format, mimeType };
		}
	}
	throw new Error(
		`Output format "${outputFormat}" requires an intermediate compressed format, but neither WebM nor OGG is supported in this browser.`,
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
 * Returns the MIME type string for the active recorder format.
 * @param activeRecorderFormat - Format currently used by MediaRecorder
 * @returns MIME type string (e.g., "audio/webm")
 */
export function getRecorderMediaType(activeRecorderFormat: string): string {
	return `${MIME_TYPE_AUDIO_PREFIX}${activeRecorderFormat}`;
}

/**
 * Decodes a compressed audio blob to WAV format.
 * @param recordedBlob - Compressed audio blob
 * @returns WAV blob
 */
export async function convertBlobToWav(recordedBlob: Blob): Promise<Blob> {
	const audioContext = new AudioContext();
	try {
		const arrayBuffer = await recordedBlob.arrayBuffer();
		const decodedBuffer = await audioContext.decodeAudioData(arrayBuffer);
		return bufferToWave(decodedBuffer, decodedBuffer.length);
	} finally {
		await audioContext.close();
	}
}

/**
 * Decodes compressed audio bytes into an AudioBuffer.
 * Decodes exactly once: decodeAudioData resamples to the context rate
 * by spec, so the previous probe-then-redecode-at-native-rate approach
 * produced an identical buffer while doubling decode time and peak
 * memory (two full PCM copies of the recording).
 * @param arrayBuffer - Encoded audio file bytes
 * @returns Decoded AudioBuffer
 */
export async function decodeAudioBlob(
	arrayBuffer: ArrayBuffer,
): Promise<AudioBuffer> {
	const audioContext = new AudioContext();
	try {
		return await audioContext.decodeAudioData(arrayBuffer);
	} finally {
		// Close even when decoding fails (corrupted/unsupported input),
		// otherwise the AudioContext leaks
		await audioContext.close();
	}
}

/**
 * Decodes an intermediate blob and re-encodes it to the target format.
 * @param recordedBlob - Intermediate compressed blob
 * @param targetFormat - Desired output format
 * @param bitrate - Bitrate in bits per second
 * @param onProgress - Optional encoding progress callback (0-100)
 * @returns Re-encoded blob in the target format
 */
export async function convertBlobToFormat(
	recordedBlob: Blob,
	targetFormat: string,
	bitrate: number,
	onProgress?: FormatProgressCallback,
): Promise<Blob> {
	const arrayBuffer = await recordedBlob.arrayBuffer();
	const decodedBuffer = await decodeAudioBlob(arrayBuffer);

	return encodeAudioBuffer(
		decodedBuffer,
		{ format: targetFormat, bitrate },
		onProgress,
	);
}

/**
 * Combines buffered chunks into a single blob, optionally converting
 * to WAV if the recording format requires it.
 * @param chunks - Buffered audio chunks
 * @param recorderMediaType - MIME type of the recorder
 * @param recordingFormat - Target recording format from settings
 * @returns Combined audio blob
 */
export async function buildOutputBlob(
	chunks: Blob[],
	recorderMediaType: string,
	recordingFormat: string,
): Promise<Blob> {
	const recordedBlob = new Blob(chunks, { type: recorderMediaType });
	if (recordingFormat !== FORMAT_WAV) {
		return recordedBlob;
	}
	return convertBlobToWav(recordedBlob);
}

/**
 * Merges multiple audio tracks into a single mixed audio blob.
 * @param chunkTargets - Recording targets for each track
 * @param settings - Plugin settings
 * @param isWavPcmRecording - Whether recording uses PCM/WAV path
 * @param buildPcmTrackWavBlob - Function to build WAV blob from PCM target
 * @param buildTrackBlob - Function to build blob from MediaRecorder target
 * @param onProgress - Optional progress callback (percent, description)
 * @returns Merged audio blob in the target format
 */
export async function mergeAudioTracks(
	chunkTargets: RecordingTarget[],
	settings: AudioRecorderSettings,
	isWavPcmRecording: boolean,
	buildPcmTrackWavBlob: TrackBlobBuilder,
	buildTrackBlob: TrackBlobBuilder,
	onProgress?: (percent: number, description: string) => void,
): Promise<Blob> {
	const audioContext = new AudioContext();
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
	const offlineContext = new OfflineAudioContext(
		2,
		audioContext.sampleRate * longestDuration,
		audioContext.sampleRate,
	);

	validBuffers.forEach((buffer) => {
		const source = offlineContext.createBufferSource();
		source.buffer = buffer;
		source.connect(offlineContext.destination);
		source.start(0);
	});

	const renderedBuffer = await offlineContext.startRendering();
	await audioContext.close();

	const targetFormat = settings.recordingFormat;
	if (
		targetFormat !== FORMAT_WAV &&
		isOfflineEncodingSupported(targetFormat)
	) {
		return encodeAudioBuffer(
			renderedBuffer,
			{
				format: targetFormat,
				bitrate: settings.bitrate,
			},
			(percent) => {
				onProgress?.(
					40 + Math.round(percent * 0.2),
					'Encoding audio...',
				);
			},
		);
	}
	return bufferToWave(renderedBuffer, renderedBuffer.length);
}
