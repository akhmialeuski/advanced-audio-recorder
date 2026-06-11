/**
 * Offline audio encoding module.
 * Converts AudioBuffer to compressed formats using Mediabunny
 * (WebCodecs-backed, with extension encoders for FLAC and MP3).
 * @module recording/AudioEncoder
 */

import {
	Output,
	BufferTarget,
	AudioBufferSource,
	Mp4OutputFormat,
	WebMOutputFormat,
	OggOutputFormat,
	FlacOutputFormat,
	Mp3OutputFormat,
	canEncodeAudio,
} from 'mediabunny';
import type { OutputFormat } from 'mediabunny';
import { bufferToWave } from './WavEncoder';
import { EncodingError } from '../errors';
import {
	FORMAT_WAV,
	FORMAT_WEBM,
	FORMAT_OGG,
	FORMAT_MP3,
	FORMAT_MP4,
	FORMAT_M4A,
	FORMAT_AAC,
	FORMAT_FLAC,
} from '../constants';

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

/** Formats that Mediabunny handles via AudioBufferSource (WebCodecs-backed). */
const WEBCODECS_FORMATS = new Set([
	FORMAT_WEBM,
	FORMAT_OGG,
	FORMAT_MP4,
	FORMAT_M4A,
	FORMAT_AAC,
]);

/** Codec used per format in Mediabunny AudioBufferSource. */
export const FORMAT_CODEC_MAP: Record<string, string> = {
	[FORMAT_WEBM]: 'opus',
	[FORMAT_OGG]: 'opus',
	[FORMAT_MP4]: 'aac',
	[FORMAT_M4A]: 'aac',
	[FORMAT_AAC]: 'aac',
	[FORMAT_FLAC]: 'flac',
	[FORMAT_MP3]: 'mp3',
};

/**
 * Creates the appropriate Mediabunny OutputFormat for the given format.
 */
export function createOutputFormat(format: string): OutputFormat {
	switch (format) {
		case FORMAT_WEBM:
			return new WebMOutputFormat();
		case FORMAT_OGG:
			return new OggOutputFormat();
		case FORMAT_MP4:
		case FORMAT_M4A:
		case FORMAT_AAC:
			return new Mp4OutputFormat();
		case FORMAT_FLAC:
			return new FlacOutputFormat();
		case FORMAT_MP3:
			return new Mp3OutputFormat();
		default:
			throw new EncodingError(`No output format for "${format}"`, format);
	}
}

/**
 * Ensures the encoder for the given format is available, registering
 * the Mediabunny extension encoder (FLAC, MP3) when the platform has
 * no native WebCodecs support. The canEncodeAudio guard makes repeat
 * calls no-ops: a registered extension encoder counts as encodable.
 * @param format - Target audio format
 */
export async function ensureEncoderRegistered(format: string): Promise<void> {
	if (format === FORMAT_FLAC && !(await canEncodeAudio('flac'))) {
		const { registerFlacEncoder } =
			await import('@mediabunny/flac-encoder');
		registerFlacEncoder();
	}
	if (format === FORMAT_MP3 && !(await canEncodeAudio('mp3'))) {
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

	if (format === FORMAT_WAV) {
		onProgress?.(100);
		return bufferToWave(buffer, buffer.length);
	}

	if (
		WEBCODECS_FORMATS.has(format) ||
		format === FORMAT_FLAC ||
		format === FORMAT_MP3
	) {
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
	const codec = FORMAT_CODEC_MAP[format];

	if (!codec) {
		throw new EncodingError(`No codec mapping for "${format}"`, format);
	}

	try {
		await ensureEncoderRegistered(format);

		const outputFormat = createOutputFormat(format);
		const target = new BufferTarget();
		const output = new Output({ format: outputFormat, target });

		const audioSource = new AudioBufferSource({
			codec: codec as 'opus' | 'aac' | 'flac' | 'mp3',
			bitrate,
		});
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
 * WAV and MP3 are always available; WebCodecs formats require
 * AudioEncoder global; FLAC depends on the Mediabunny extension.
 * @param format - Audio format to check
 * @returns true if offline encoding to this format is possible
 */
export function isOfflineEncodingSupported(format: string): boolean {
	if (format === FORMAT_WAV) {
		return true;
	}
	if (format === FORMAT_MP3) {
		return true;
	}
	if (WEBCODECS_FORMATS.has(format)) {
		return typeof AudioEncoder !== 'undefined';
	}
	if (format === FORMAT_FLAC) {
		return true;
	}
	return false;
}

/**
 * Returns a human-readable description of the encoder used for the format.
 * @param format - Audio format
 * @returns Encoder description string
 */
export function getEncoderDescription(format: string): string {
	switch (format) {
		case FORMAT_WAV:
			return 'PCM (built-in)';
		case FORMAT_WEBM:
			return 'AudioEncoder (Opus) + Mediabunny';
		case FORMAT_OGG:
			return 'AudioEncoder (Opus) + Mediabunny';
		case FORMAT_MP4:
		case FORMAT_M4A:
		case FORMAT_AAC:
			return 'AudioEncoder (AAC) + Mediabunny';
		case FORMAT_MP3:
			return 'Mediabunny MP3 Encoder';
		case FORMAT_FLAC:
			return 'Mediabunny FLAC Encoder';
		default:
			return 'Unknown';
	}
}
