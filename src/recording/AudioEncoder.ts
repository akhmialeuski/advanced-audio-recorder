/**
 * Offline audio encoding module.
 * Converts AudioBuffer to compressed formats using Mediabunny (WebCodecs)
 * and lamejs (MP3).
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
} from 'mediabunny';
import type { OutputFormat } from 'mediabunny';
import { Mp3Encoder } from 'lamejs';
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
const FORMAT_CODEC_MAP: Record<string, string> = {
	[FORMAT_WEBM]: 'opus',
	[FORMAT_OGG]: 'opus',
	[FORMAT_MP4]: 'aac',
	[FORMAT_M4A]: 'aac',
	[FORMAT_AAC]: 'aac',
	[FORMAT_FLAC]: 'flac',
};

/** MP3 encoding chunk size (MPEG standard frame). */
const MP3_SAMPLES_PER_FRAME = 1152;

/**
 * Creates the appropriate Mediabunny OutputFormat for the given format.
 */
function createOutputFormat(format: string): OutputFormat {
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
		default:
			throw new EncodingError(`No output format for "${format}"`, format);
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

	if (format === FORMAT_MP3) {
		return encodeWithLamejs(buffer, options, onProgress);
	}

	if (WEBCODECS_FORMATS.has(format) || format === FORMAT_FLAC) {
		return encodeWithMediabunny(buffer, options, onProgress);
	}

	throw new EncodingError(`Unsupported format: ${format}`, format);
}

/**
 * Encodes AudioBuffer using Mediabunny (WebCodecs-backed for Opus/AAC,
 * extension-backed for FLAC).
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
		// FLAC requires the encoder extension to be loaded first
		if (format === FORMAT_FLAC) {
			await import('@mediabunny/flac-encoder');
		}

		const outputFormat = createOutputFormat(format);
		const target = new BufferTarget();
		const output = new Output({ format: outputFormat, target });

		const audioSource = new AudioBufferSource({
			codec: codec as 'opus' | 'aac' | 'flac',
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
 * Converts Float32Array channel data to Int16Array for lamejs.
 */
function floatTo16BitPCM(input: Float32Array): Int16Array {
	const output = new Int16Array(input.length);
	for (let i = 0; i < input.length; i++) {
		const s = Math.max(-1, Math.min(1, input[i]));
		output[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
	}
	return output;
}

/**
 * Encodes AudioBuffer to MP3 using lamejs.
 * Async ensures synchronous encoding errors become rejected Promises,
 * matching the Promise<Blob> contract expected by callers.
 */
async function encodeWithLamejs(
	buffer: AudioBuffer,
	options: EncodingOptions,
	onProgress?: ProgressCallback,
): Promise<Blob> {
	const { bitrate } = options;
	const bitrateKbps = Math.round(bitrate / 1000);
	const channels = buffer.numberOfChannels;
	const sampleRate = buffer.sampleRate;

	try {
		const encoder = new Mp3Encoder(channels, sampleRate, bitrateKbps);
		const mp3Chunks: Uint8Array[] = [];

		const left = floatTo16BitPCM(buffer.getChannelData(0));
		const right =
			channels >= 2
				? floatTo16BitPCM(buffer.getChannelData(1))
				: undefined;

		const totalSamples = left.length;
		let samplesProcessed = 0;

		for (let i = 0; i < totalSamples; i += MP3_SAMPLES_PER_FRAME) {
			const end = Math.min(i + MP3_SAMPLES_PER_FRAME, totalSamples);
			const leftChunk = left.subarray(i, end);
			const rightChunk = right?.subarray(i, end);

			const mp3buf = encoder.encodeBuffer(leftChunk, rightChunk);
			if (mp3buf.length > 0) {
				mp3Chunks.push(new Uint8Array(mp3buf));
			}

			samplesProcessed = end;
			if (onProgress && totalSamples > 0) {
				onProgress(Math.round((samplesProcessed / totalSamples) * 90));
			}
		}

		const finalBuf = encoder.flush();
		if (finalBuf.length > 0) {
			mp3Chunks.push(new Uint8Array(finalBuf));
		}

		onProgress?.(100);
		return new Blob(mp3Chunks as BlobPart[], { type: 'audio/mp3' });
	} catch (error) {
		throw new EncodingError(
			error instanceof Error ? error.message : String(error),
			FORMAT_MP3,
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
			return 'lamejs (MP3)';
		case FORMAT_FLAC:
			return 'Mediabunny FLAC Encoder';
		default:
			return 'Unknown';
	}
}
