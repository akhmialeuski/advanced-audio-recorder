/**
 * Offline audio encoding module.
 * Converts AudioBuffer to compressed formats using Mediabunny
 * (WebCodecs-backed, with extension encoders for FLAC and MP3).
 * @module audio/AudioEncoder
 */

import {
	Output,
	BufferTarget,
	AudioBufferSource,
	canEncodeAudio,
} from 'mediabunny';
import type { OutputFormat, AudioCodec } from 'mediabunny';
import { EncodingError } from '../errors';
import { FORMAT_MP3, FORMAT_FLAC } from '../constants';
import {
	AUDIO_FORMAT_IDS,
	FORMAT_REGISTRY,
	getFormatDescriptor,
} from './formatRegistry';

/**
 * Options for offline audio encoding.
 */
export interface EncodingOptions {
	/** Target audio format. */
	format: string;
	/** Bitrate in bits per second. */
	bitrate: number;
}

/**
 * Progress callback receiving percentage (0-100).
 */
export type ProgressCallback = (percent: number) => void;

/**
 * Codec used per format in Mediabunny AudioBufferSource. A view over
 * the format registry, kept as an export because the streaming
 * conversion pipeline (and its worker) resolve codecs through it.
 */
export const FORMAT_CODEC_MAP: Record<string, AudioCodec> = Object.fromEntries(
	AUDIO_FORMAT_IDS.map((id) => [id, FORMAT_REGISTRY[id].codec]),
);

/**
 * Creates the appropriate Mediabunny OutputFormat for the given format.
 */
export function createOutputFormat(format: string): OutputFormat {
	const descriptor = getFormatDescriptor(format);
	if (!descriptor) {
		throw new EncodingError(`No output format for "${format}"`, format);
	}
	return descriptor.createOutputFormat();
}

/**
 * Ensures the encoder for the given format is available, registering
 * the Mediabunny extension encoder (FLAC, MP3) when the platform has
 * no native WebCodecs support. The canEncodeAudio guard makes repeat
 * calls no-ops: a registered extension encoder counts as encodable.
 * @param format - Target audio format
 */
export async function ensureEncoderRegistered(format: string): Promise<void> {
	if (
		format === FORMAT_FLAC &&
		!(await canEncodeAudio(FORMAT_REGISTRY[FORMAT_FLAC].codec))
	) {
		const { registerFlacEncoder } =
			await import('@mediabunny/flac-encoder');
		registerFlacEncoder();
	}
	if (
		format === FORMAT_MP3 &&
		!(await canEncodeAudio(FORMAT_REGISTRY[FORMAT_MP3].codec))
	) {
		const { registerMp3Encoder } = await import('@mediabunny/mp3-encoder');
		registerMp3Encoder();
	}
}

/**
 * Encodes an AudioBuffer to the specified format.
 * Routes to the appropriate encoder based on format.
 * @param buffer - Source AudioBuffer to encode
 * @param options - Encoding configuration
 * @param onProgress - Optional progress callback (0-100)
 * @returns Blob containing the encoded audio
 */
export async function encodeAudioBuffer(
	buffer: AudioBuffer,
	options: EncodingOptions,
	onProgress?: ProgressCallback,
): Promise<Blob> {
	const { format } = options;

	if (getFormatDescriptor(format)) {
		return encodeWithMediabunny(buffer, options, onProgress);
	}

	throw new EncodingError(`Unsupported format: ${format}`, format);
}

/**
 * Encodes AudioBuffer using Mediabunny (WebCodecs-backed for Opus/AAC,
 * extension-backed for FLAC and MP3).
 */
async function encodeWithMediabunny(
	buffer: AudioBuffer,
	options: EncodingOptions,
	onProgress?: ProgressCallback,
): Promise<Blob> {
	const { format, bitrate } = options;
	const descriptor = getFormatDescriptor(format);

	if (!descriptor) {
		throw new EncodingError(`No codec mapping for "${format}"`, format);
	}
	const codec = descriptor.codec;

	try {
		await ensureEncoderRegistered(format);

		const outputFormat = createOutputFormat(format);
		const target = new BufferTarget();
		const output = new Output({ format: outputFormat, target });

		// PCM is uncompressed: passing a bitrate is invalid for it
		const audioSource = new AudioBufferSource(
			descriptor.isPcm ? { codec } : { codec, bitrate },
		);
		output.addAudioTrack(audioSource);

		await output.start();
		onProgress?.(10);

		await audioSource.add(buffer);
		onProgress?.(80);

		await output.finalize();
		onProgress?.(100);

		const mimeType = `audio/${format}`;
		const resultBuffer = target.buffer;
		if (!resultBuffer) {
			throw new EncodingError('Encoding produced no output', format);
		}
		return new Blob([resultBuffer], { type: mimeType });
	} catch (error) {
		if (error instanceof EncodingError) {
			throw error;
		}
		throw new EncodingError(
			error instanceof Error ? error.message : String(error),
			format,
			error,
		);
	}
}

/**
 * Checks whether offline encoding is supported for the given format.
 * WAV is always available; MP3 and FLAC are always available through
 * the bundled Mediabunny extension encoders; WebCodecs formats
 * require the AudioEncoder global.
 * @param format - Audio format to check
 * @returns true if offline encoding to this format is possible
 */
export function isOfflineEncodingSupported(format: string): boolean {
	const descriptor = getFormatDescriptor(format);
	if (!descriptor) {
		return false;
	}
	if (descriptor.requiresWebCodecs) {
		return typeof AudioEncoder !== 'undefined';
	}
	return true;
}
