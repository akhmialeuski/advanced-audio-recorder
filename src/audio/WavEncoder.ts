/**
 * WAV header utilities for assembling WAV files from raw int16 PCM
 * segments captured by the streaming recording path. AudioBuffer
 * encoding goes through mediabunny (see AudioEncoder), which handles
 * WAVE output natively.
 * @module audio/WavEncoder
 */

import type { App } from 'obsidian';

/**
 * Writes a string to a DataView at the specified offset.
 * @param view - The DataView to write to
 * @param offset - The byte offset
 * @param str - The string to write
 */
function writeString(view: DataView, offset: number, str: string): void {
	for (let i = 0; i < str.length; i++) {
		view.setUint8(offset + i, str.charCodeAt(i));
	}
}

/**
 * Creates a WAV header info object for debugging.
 * @param numChannels - Number of audio channels
 * @param sampleRate - Sample rate in Hz
 * @param dataLength - Length of audio data in bytes
 * @returns Header information object
 */
export function getWavHeaderInfo(
	numChannels: number,
	sampleRate: number,
	dataLength: number,
): { headerSize: number; totalSize: number; byteRate: number } {
	return {
		headerSize: 44,
		totalSize: dataLength + 44,
		byteRate: sampleRate * 2 * numChannels,
	};
}

/**
 * WAV header size in bytes.
 */
export const WAV_HEADER_SIZE = 44;

/**
 * Bits per sample for 16-bit PCM.
 */
const BITS_PER_SAMPLE = 16;

/**
 * Creates a 44-byte WAV file header for raw int16 PCM data.
 * @param numChannels - Number of audio channels
 * @param sampleRate - Sample rate in Hz
 * @param pcmDataLength - Total length of PCM data in bytes
 * @returns ArrayBuffer containing the WAV header
 */
export function createWavHeader(
	numChannels: number,
	sampleRate: number,
	pcmDataLength: number,
): ArrayBuffer {
	const header = new ArrayBuffer(WAV_HEADER_SIZE);
	const view = new DataView(header);
	const byteRate = sampleRate * numChannels * (BITS_PER_SAMPLE / 8);
	const blockAlign = numChannels * (BITS_PER_SAMPLE / 8);
	let offset = 0;

	// RIFF header
	writeString(view, offset, 'RIFF');
	offset += 4;
	view.setUint32(offset, WAV_HEADER_SIZE - 8 + pcmDataLength, true);
	offset += 4;
	writeString(view, offset, 'WAVE');
	offset += 4;

	// fmt subchunk
	writeString(view, offset, 'fmt ');
	offset += 4;
	view.setUint32(offset, 16, true); // Subchunk1Size
	offset += 4;
	view.setUint16(offset, 1, true); // AudioFormat (PCM)
	offset += 2;
	view.setUint16(offset, numChannels, true);
	offset += 2;
	view.setUint32(offset, sampleRate, true);
	offset += 4;
	view.setUint32(offset, byteRate, true);
	offset += 4;
	view.setUint16(offset, blockAlign, true);
	offset += 2;
	view.setUint16(offset, BITS_PER_SAMPLE, true);
	offset += 2;

	// data subchunk header
	writeString(view, offset, 'data');
	offset += 4;
	view.setUint32(offset, pcmDataLength, true);

	return header;
}

/**
 * Assembles a complete WAV file from raw int16 PCM data segments.
 * Concatenates all segments after a proper WAV header.
 * @param segments - Array of raw interleaved int16 PCM data buffers
 * @param numChannels - Number of audio channels
 * @param sampleRate - Sample rate in Hz
 * @returns ArrayBuffer containing the complete WAV file
 */
export function assembleWavFromPcmSegments(
	segments: ArrayBuffer[],
	numChannels: number,
	sampleRate: number,
): ArrayBuffer {
	const totalPcmSize = segments.reduce((sum, buf) => sum + buf.byteLength, 0);

	const header = createWavHeader(numChannels, sampleRate, totalPcmSize);
	const wavBuffer = new ArrayBuffer(WAV_HEADER_SIZE + totalPcmSize);
	const wavView = new Uint8Array(wavBuffer);

	// Copy header
	wavView.set(new Uint8Array(header), 0);

	// Copy PCM segments
	let offset = WAV_HEADER_SIZE;
	for (const segment of segments) {
		wavView.set(new Uint8Array(segment), offset);
		offset += segment.byteLength;
	}

	return wavBuffer;
}

/**
 * Assembles a complete WAV file from flushed int16 PCM segment files.
 * When the vault adapter can report file sizes, the final buffer is
 * allocated once and the segments stream into it sequentially - peak
 * memory is the final file plus one segment, instead of two full
 * copies of the recording. Falls back to read-all-then-assemble for
 * adapters without stat support.
 * @param segmentPaths - Segment files in capture order (vault-relative)
 * @param numChannels - Number of audio channels
 * @param sampleRate - Sample rate in Hz
 * @param app - Obsidian App instance
 * @returns ArrayBuffer containing the complete WAV file
 * @throws Error when a segment grew between stat and read
 */
export async function assembleWavFromPcmSegmentFiles(
	segmentPaths: string[],
	numChannels: number,
	sampleRate: number,
	app: App,
): Promise<ArrayBuffer> {
	const adapter = app.vault.adapter;
	if (typeof adapter.stat === 'function') {
		const stats = await Promise.all(
			segmentPaths.map((path) => adapter.stat(path)),
		);
		if (stats.every((stat) => stat != null)) {
			const totalPcmSize = stats.reduce(
				(sum, stat) => sum + (stat?.size ?? 0),
				0,
			);
			const wavBuffer = new ArrayBuffer(WAV_HEADER_SIZE + totalPcmSize);
			const wavView = new Uint8Array(wavBuffer);
			let offset = WAV_HEADER_SIZE;
			for (const path of segmentPaths) {
				const segment = await adapter.readBinary(path);
				if (offset + segment.byteLength > wavView.byteLength) {
					throw new Error('PCM segment changed during WAV assembly');
				}
				wavView.set(new Uint8Array(segment), offset);
				offset += segment.byteLength;
			}
			// The header is written last with the actual byte count, in
			// case a segment shrank between stat and read
			const header = createWavHeader(
				numChannels,
				sampleRate,
				offset - WAV_HEADER_SIZE,
			);
			wavView.set(new Uint8Array(header), 0);
			return offset === wavBuffer.byteLength
				? wavBuffer
				: wavBuffer.slice(0, offset);
		}
	}

	// Fallback for adapters without stat(): read everything, then
	// assemble (two full copies of the recording in memory)
	const segments = await Promise.all(
		segmentPaths.map((path) => adapter.readBinary(path)),
	);
	return assembleWavFromPcmSegments(segments, numChannels, sampleRate);
}
