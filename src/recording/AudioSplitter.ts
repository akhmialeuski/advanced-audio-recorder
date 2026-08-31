/**
 * Audio splitting utilities for dividing recordings into time-based parts.
 * Provides lossless byte-level splitting for PCM WAV files and
 * AudioBuffer slicing for compressed formats that require re-encoding.
 * @module recording/AudioSplitter
 */

import {
	DEFAULT_SPLIT_CHUNK_MINUTES,
	DEFAULT_SPLIT_PART_SUFFIX,
	MAX_SPLIT_CHUNK_MINUTES,
	MIN_SPLIT_CHUNK_MINUTES,
	SECONDS_PER_MINUTE,
	SPLIT_PART_SUFFIX_PATTERN,
} from '../constants';
import { PCM_BYTES_PER_SAMPLE } from '../audio/pcm';

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
 * Computes the byte length of one lossless WAV part, aligned down to a
 * whole sample frame so parts never cut a frame in half.
 * @param layout - Parsed WAV layout from parseWavLayout
 * @param partDurationSec - Duration of each part in seconds
 * @returns Part size in bytes (multiple of blockAlign, possibly 0)
 */
export function computeWavPartBytes(
	layout: WavLayout,
	partDurationSec: number,
): number {
	const rawPartBytes = Math.floor(layout.byteRate * partDurationSec);
	return Math.floor(rawPartBytes / layout.blockAlign) * layout.blockAlign;
}

/**
 * Builds one standalone WAV part of a byte-level split without decoding.
 * The part reuses the original header (everything before the sample
 * data) with patched RIFF and data chunk sizes, so sample format,
 * channels, and rate are preserved exactly. Trailing chunks after the
 * data chunk are dropped. Parts are built one at a time so callers can
 * keep at most one part buffer alive while writing multi-gigabyte files.
 * @param buffer - Raw WAV file bytes
 * @param layout - Parsed WAV layout from parseWavLayout
 * @param partBytes - Part size in bytes from computeWavPartBytes
 * @param partIndex - 0-based part index
 * @returns Complete WAV file for the requested part
 */
export function buildWavPart(
	buffer: ArrayBuffer,
	layout: WavLayout,
	partBytes: number,
	partIndex: number,
): ArrayBuffer {
	const start = partIndex * partBytes;
	return buildWavPartRange(buffer, layout, start, start + partBytes);
}

/**
 * Builds one standalone WAV part covering an arbitrary byte range of the
 * sample data, which is what an uneven split needs: chapter boundaries divide
 * a recording into parts of different lengths, and the even split above is
 * the special case where every range is the same size.
 *
 * Both ends are clamped to the data the file actually holds, so a range that
 * runs past the end yields the tail rather than a part padded with whatever
 * followed the data chunk.
 * @param buffer - Raw WAV file bytes
 * @param layout - Parsed WAV layout from parseWavLayout
 * @param startByte - First byte of the range, relative to the sample data
 * @param endByte - Byte after the last, relative to the sample data
 * @returns Complete WAV file for the requested range
 */
export function buildWavPartRange(
	buffer: ArrayBuffer,
	layout: WavLayout,
	startByte: number,
	endByte: number,
): ArrayBuffer {
	const start = Math.max(0, Math.min(startByte, layout.dataLength));
	const length = Math.max(0, Math.min(endByte, layout.dataLength) - start);
	const headerLength = layout.dataOffset;

	const part = new ArrayBuffer(headerLength + length);
	const partView = new Uint8Array(part);
	partView.set(new Uint8Array(buffer, 0, headerLength), 0);
	partView.set(
		new Uint8Array(buffer, layout.dataOffset + start, length),
		headerLength,
	);

	const view = new DataView(part);
	// RIFF chunk size: total file length minus the 8-byte RIFF header
	view.setUint32(4, headerLength + length - RIFF_CHUNK_HEADER_SIZE, true);
	// data chunk size: immediately precedes the sample data
	view.setUint32(headerLength - 4, length, true);

	return part;
}

/**
 * Where one second lands in the sample data of a WAV, aligned DOWN to a whole
 * frame.
 *
 * A part that starts mid-frame plays as noise, with the channels swapped for
 * its whole length. Aligning down rather than to the nearest also keeps every
 * part starting at or before its chapter, so no audio falls between two parts.
 * @param layout - Parsed WAV layout from parseWavLayout
 * @returns A function from seconds to a frame-aligned byte offset
 */
export function wavFrameOffset(layout: WavLayout): (seconds: number) => number {
	return (seconds: number) => {
		const raw = Math.floor(layout.byteRate * Math.max(0, seconds));
		return Math.floor(raw / layout.blockAlign) * layout.blockAlign;
	};
}

/**
 * Divides a recording at a list of cut points, carrying each cut through to
 * the range it opens.
 *
 * The cut is carried rather than the index, because the division is not
 * one-to-one with the list it came from: two cuts can land on the same frame,
 * one can sit past the end of the recording, and a recording whose first cut
 * is not at the start has a part before it. Naming the parts by position in
 * the list would then label them with somebody else's chapter.
 *
 * One division serves both split paths, the byte one and the decoded one,
 * which differ only in what a second is worth.
 * @param cuts - Where the parts begin, and what each carries, in any order
 * @param toOffset - Turns seconds into an offset in the unit being divided
 * @param total - Length of the recording in that same unit
 * @returns One range per part, in order, each with the cut that opened it
 */
export function computeCutRanges<T extends { startSeconds: number }>(
	cuts: readonly T[],
	toOffset: (seconds: number) => number,
	total: number,
): { start: number; end: number; cut: T | null }[] {
	const byStart = new Map<number, T | null>([[0, null]]);
	for (const cut of cuts) {
		const start = toOffset(cut.startSeconds);
		// A cut past the end divides nothing, and the first cut on a given
		// offset is the one that names the part it opens.
		if (start >= 0 && start < total && !byStart.get(start)) {
			byStart.set(start, cut);
		}
	}
	const entries = [...byStart.entries()].sort(([a], [b]) => a - b);
	return entries.map(([start, cut], index) => ({
		start,
		end: entries[index + 1]?.[0] ?? total,
		cut,
	}));
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

/**
 * Clamps a configured part duration to the supported range.
 * validateSettings is not invoked on the production load path, so
 * persisted settings may carry out-of-range or non-numeric values.
 * @param minutes - User-configured part duration in minutes
 * @returns Whole minutes within [MIN, MAX], or the default for
 * non-finite input
 */
export function clampSplitMinutes(minutes: number): number {
	if (!Number.isFinite(minutes)) {
		return DEFAULT_SPLIT_CHUNK_MINUTES;
	}
	return Math.min(
		MAX_SPLIT_CHUNK_MINUTES,
		Math.max(MIN_SPLIT_CHUNK_MINUTES, Math.floor(minutes)),
	);
}

/**
 * Sums the byte lengths of a list of buffers.
 * @param buffers - Buffers to measure
 * @returns Total byte length
 */
export function totalByteLength(buffers: ArrayBuffer[]): number {
	return buffers.reduce((sum, buffer) => sum + buffer.byteLength, 0);
}

/**
 * Detaches the trailing `trailingBytes` from the end of a buffer list,
 * mutating the list in place so it keeps only the leading remainder.
 * The boundary may fall inside one buffer or span several buffers.
 * Used to carry auto-split overshoot into the next part.
 * @param buffers - Buffer list to split; mutated in place
 * @param trailingBytes - Number of bytes to detach from the end
 * @returns Detached trailing buffers in their original order
 */
export function detachTrailingBytes(
	buffers: ArrayBuffer[],
	trailingBytes: number,
): ArrayBuffer[] {
	const carry: ArrayBuffer[] = [];
	let remaining = trailingBytes;
	while (remaining > 0 && buffers.length > 0) {
		const last = buffers[buffers.length - 1];
		if (!last) {
			break;
		}
		if (last.byteLength <= remaining) {
			buffers.pop();
			carry.unshift(last);
			remaining -= last.byteLength;
		} else {
			const keepBytes = last.byteLength - remaining;
			buffers[buffers.length - 1] = last.slice(0, keepBytes);
			carry.unshift(last.slice(keepBytes));
			remaining = 0;
		}
	}
	return carry;
}
