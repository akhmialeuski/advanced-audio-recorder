/**
 * Audio splitting utilities for dividing recordings into time-based parts.
 * Provides lossless byte-level splitting for PCM WAV files and
 * AudioBuffer slicing for compressed formats that require re-encoding.
 * @module recording/AudioSplitter
 */

import {
	DEFAULT_SPLIT_PART_SUFFIX,
	SPLIT_PART_SUFFIX_PATTERN,
} from '../constants';

/** Bytes per sample for 16-bit PCM data captured by PcmStreamRecorder. */
export const PCM_BYTES_PER_SAMPLE = 2;

/** Seconds in one minute. */
const SECONDS_PER_MINUTE = 60;

/** Byte length of a RIFF chunk header (4-byte id + 4-byte size). */
const RIFF_CHUNK_HEADER_SIZE = 8;

/** Byte offset where RIFF chunks start (after "RIFF<size>WAVE"). */
const RIFF_FIRST_CHUNK_OFFSET = 12;

/** WAVE format codes that store raw, byte-sliceable sample frames. */
const SLICEABLE_WAV_FORMATS = new Set([
	0x0001, // PCM
	0x0003, // IEEE float
	0xfffe, // WAVE_FORMAT_EXTENSIBLE (PCM/float subformats)
]);

/**
 * Layout of a RIFF/WAVE file required for lossless byte-level splitting.
 */
export interface WavLayout {
	/** Byte offset where raw sample data starts (after the data chunk header). */
	dataOffset: number;
	/** Length of the sample data in bytes. */
	dataLength: number;
	/** Bytes of sample data per second of audio. */
	byteRate: number;
	/** Bytes per sample frame across all channels. */
	blockAlign: number;
}

/**
 * Reads a four-character ASCII chunk identifier.
 */
function readChunkId(view: DataView, offset: number): string {
	let id = '';
	for (let i = 0; i < 4; i++) {
		id += String.fromCharCode(view.getUint8(offset + i));
	}
	return id;
}

/**
 * Parses the RIFF/WAVE structure of a file and returns the layout needed
 * for byte-level splitting. Walks chunks instead of assuming a fixed
 * 44-byte header, so WAV files produced by other tools are handled too.
 * @param buffer - Raw WAV file bytes
 * @returns Layout, or null when the file cannot be split losslessly
 */
export function parseWavLayout(buffer: ArrayBuffer): WavLayout | null {
	if (buffer.byteLength < RIFF_FIRST_CHUNK_OFFSET) {
		return null;
	}
	const view = new DataView(buffer);
	if (readChunkId(view, 0) !== 'RIFF' || readChunkId(view, 8) !== 'WAVE') {
		return null;
	}

	let byteRate = 0;
	let blockAlign = 0;
	let formatCode = 0;
	let offset = RIFF_FIRST_CHUNK_OFFSET;

	while (offset + RIFF_CHUNK_HEADER_SIZE <= buffer.byteLength) {
		const chunkId = readChunkId(view, offset);
		const chunkSize = view.getUint32(offset + 4, true);
		const chunkDataOffset = offset + RIFF_CHUNK_HEADER_SIZE;

		if (chunkId === 'fmt ') {
			if (chunkDataOffset + 16 > buffer.byteLength) {
				return null;
			}
			formatCode = view.getUint16(chunkDataOffset, true);
			byteRate = view.getUint32(chunkDataOffset + 8, true);
			blockAlign = view.getUint16(chunkDataOffset + 12, true);
		} else if (chunkId === 'data') {
			const dataLength = Math.min(
				chunkSize,
				buffer.byteLength - chunkDataOffset,
			);
			if (
				!SLICEABLE_WAV_FORMATS.has(formatCode) ||
				byteRate <= 0 ||
				blockAlign <= 0
			) {
				return null;
			}
			return {
				dataOffset: chunkDataOffset,
				dataLength,
				byteRate,
				blockAlign,
			};
		}

		// Chunks are word-aligned: odd sizes are padded with one byte
		offset = chunkDataOffset + chunkSize + (chunkSize % 2);
	}

	return null;
}

/**
 * Splits raw WAV file bytes into standalone WAV files of the given
 * duration without decoding. Each part reuses the original header
 * (everything before the sample data) with patched RIFF and data chunk
 * sizes, so sample format, channels, and rate are preserved exactly.
 * Trailing chunks after the data chunk are dropped.
 * @param buffer - Raw WAV file bytes
 * @param layout - Parsed WAV layout from parseWavLayout
 * @param partDurationSec - Duration of each part in seconds
 * @returns Array of complete WAV files, one per part
 */
export function splitWavBuffer(
	buffer: ArrayBuffer,
	layout: WavLayout,
	partDurationSec: number,
): ArrayBuffer[] {
	const rawPartBytes = Math.floor(layout.byteRate * partDurationSec);
	const partBytes =
		Math.floor(rawPartBytes / layout.blockAlign) * layout.blockAlign;
	if (partBytes <= 0) {
		return [];
	}

	const parts: ArrayBuffer[] = [];
	const headerLength = layout.dataOffset;

	for (let start = 0; start < layout.dataLength; start += partBytes) {
		const length = Math.min(partBytes, layout.dataLength - start);
		const part = new ArrayBuffer(headerLength + length);
		const partBytesView = new Uint8Array(part);
		partBytesView.set(new Uint8Array(buffer, 0, headerLength), 0);
		partBytesView.set(
			new Uint8Array(buffer, layout.dataOffset + start, length),
			headerLength,
		);

		const view = new DataView(part);
		// RIFF chunk size: total file length minus the 8-byte RIFF header
		view.setUint32(4, headerLength + length - RIFF_CHUNK_HEADER_SIZE, true);
		// data chunk size: immediately precedes the sample data
		view.setUint32(headerLength - 4, length, true);

		parts.push(part);
	}

	return parts;
}

/**
 * Copies a sample range of all channels into a new AudioBuffer.
 * @param source - Source buffer to slice
 * @param startSample - First sample index (inclusive)
 * @param endSample - Last sample index (exclusive), clamped to length
 * @returns New AudioBuffer containing the requested range
 */
export function sliceAudioBuffer(
	source: AudioBuffer,
	startSample: number,
	endSample: number,
): AudioBuffer {
	const start = Math.max(0, startSample);
	const end = Math.min(source.length, endSample);
	const part = new AudioBuffer({
		numberOfChannels: source.numberOfChannels,
		length: Math.max(0, end - start),
		sampleRate: source.sampleRate,
	});
	for (let channel = 0; channel < source.numberOfChannels; channel++) {
		const channelData = source.getChannelData(channel);
		part.copyToChannel(channelData.subarray(start, end), channel);
	}
	return part;
}

/**
 * Computes how many parts a recording of the given size yields.
 * @param totalUnits - Total size (samples, bytes, etc.)
 * @param unitsPerPart - Size of one part in the same units
 * @returns Number of parts (the last one may be shorter)
 */
export function computePartCount(
	totalUnits: number,
	unitsPerPart: number,
): number {
	if (unitsPerPart <= 0 || totalUnits <= 0) {
		return 0;
	}
	return Math.ceil(totalUnits / unitsPerPart);
}

/**
 * Computes the byte limit of one auto-split part for raw int16 PCM capture.
 * @param partMinutes - Part duration in minutes
 * @param sampleRate - Sample rate in Hz
 * @param channels - Number of audio channels
 * @returns Part size in bytes (always a multiple of the PCM frame size)
 */
export function computePcmPartLimitBytes(
	partMinutes: number,
	sampleRate: number,
	channels: number,
): number {
	return (
		partMinutes *
		SECONDS_PER_MINUTE *
		sampleRate *
		channels *
		PCM_BYTES_PER_SAMPLE
	);
}

/**
 * Builds a part file name: `${baseName}-${suffix}${partNumber}.${extension}`.
 * @param baseName - File name without extension
 * @param suffix - Part suffix (validated/sanitized by the caller)
 * @param partNumber - 1-based part number
 * @param extension - File extension without the dot
 * @returns Complete part file name
 */
export function buildPartFileName(
	baseName: string,
	suffix: string,
	partNumber: number,
	extension: string,
): string {
	return `${baseName}-${suffix}${String(partNumber)}.${extension}`;
}

/**
 * Returns the suffix when it is safe for file names and regex patterns,
 * otherwise falls back to the default suffix.
 * @param suffix - User-configured part suffix
 * @returns Safe part suffix
 */
export function sanitizePartSuffix(suffix: string): string {
	return SPLIT_PART_SUFFIX_PATTERN.test(suffix)
		? suffix
		: DEFAULT_SPLIT_PART_SUFFIX;
}
