/**
 * WAV header utilities for assembling WAV files from raw int16 PCM
 * segments captured by the streaming recording path. AudioBuffer
 * encoding goes through mediabunny (see AudioEncoder), which handles
 * WAVE output natively.
 *
 * The container has a hard ceiling and this module is where it is enforced:
 * a RIFF header states both its own size and its payload's in 32-bit fields,
 * so a WAV file cannot describe more than four gigabytes. RF64 is the
 * standard extension that lifts it into 64-bit fields, and it is deliberately
 * not implemented: auto-split already answers the long recording, all the way
 * through to the player and the splitter, while none of the transcription
 * engines these files are handed to afterwards read RF64. A recording that
 * would overflow is refused before the allocation instead, with the captured
 * PCM segments left on disk.
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
 * Largest PCM payload a RIFF header can describe.
 *
 * Both size fields are unsigned 32-bit. The data field holds the payload
 * alone, while the RIFF field holds the payload plus the rest of the header
 * (everything after its own 8 bytes), so the RIFF field is the one that
 * overflows first and it is what this bound is taken from.
 */
export const WAV_MAX_PCM_BYTES = 0xffffffff - (WAV_HEADER_SIZE - 8);

/**
 * Share of {@link WAV_MAX_PCM_BYTES} a recording may reach before the user is
 * told. Far enough below the ceiling that a warning still leaves time to act:
 * at 48 kHz stereo the remaining tenth is around half an hour of capture.
 */
const WAV_PCM_WARNING_RATIO = 0.9;

/** PCM size at which a recording is warned that the container is filling up. */
export const WAV_PCM_WARNING_BYTES = Math.floor(
	WAV_MAX_PCM_BYTES * WAV_PCM_WARNING_RATIO,
);

/** What a caller is told when the audio outgrew the container. */
export const WAV_SIZE_LIMIT_MESSAGE =
	'This recording is too long for a WAV file, which cannot exceed 4 GB. ' +
	'Enable auto-split in the recording settings so a long recording is ' +
	'saved as parts; the captured audio is kept and can be recovered.';

/**
 * Refuses a PCM payload the container cannot describe.
 *
 * Asked before the allocation on every path that builds a WAV, because both
 * outcomes of asking later are a loss: `setUint32` drops the high bits without
 * a word and writes a file players read as truncated, and an allocation past
 * the engine's own ceiling throws only after the recording has stopped. Asked
 * here, the refusal costs nothing and the PCM segments are still on disk.
 * @param pcmByteLength - Total PCM payload in bytes
 * @throws Error when the payload does not fit a WAV container
 */
function assertPcmFitsWav(pcmByteLength: number): void {
	if (pcmByteLength > WAV_MAX_PCM_BYTES) {
		throw new Error(WAV_SIZE_LIMIT_MESSAGE);
	}
}

/**
 * Bits per sample for 16-bit PCM.
 */
const BITS_PER_SAMPLE = 16;

/** Size in bytes of the PCM "fmt " subchunk body (WAV spec). */
const WAV_FMT_CHUNK_SIZE = 16;

/** WAV format tag for uncompressed integer PCM (WAV spec). */
const WAV_FORMAT_PCM = 1;

/**
 * Creates a 44-byte WAV file header for raw int16 PCM data.
 * @param numChannels - Number of audio channels
 * @param sampleRate - Sample rate in Hz
 * @param pcmDataLength - Total length of PCM data in bytes
 * @returns ArrayBuffer containing the WAV header
 * @throws Error when the PCM data is too large for the container
 */
export function createWavHeader(
	numChannels: number,
	sampleRate: number,
	pcmDataLength: number,
): ArrayBuffer {
	assertPcmFitsWav(pcmDataLength);
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
	view.setUint32(offset, WAV_FMT_CHUNK_SIZE, true);
	offset += 4;
	view.setUint16(offset, WAV_FORMAT_PCM, true);
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
 * Allocates a complete WAV file buffer with the header already written.
 * Callers fill the PCM region (starting at WAV_HEADER_SIZE) afterwards.
 * @param numChannels - Number of audio channels
 * @param sampleRate - Sample rate in Hz
 * @param pcmByteLength - Total length of PCM data in bytes
 * @returns ArrayBuffer sized for header plus PCM, header written
 * @throws Error when the PCM data is too large for the container
 */
export function createWavFileBuffer(
	numChannels: number,
	sampleRate: number,
	pcmByteLength: number,
): ArrayBuffer {
	assertPcmFitsWav(pcmByteLength);
	const wavBuffer = new ArrayBuffer(WAV_HEADER_SIZE + pcmByteLength);
	new Uint8Array(wavBuffer).set(
		new Uint8Array(createWavHeader(numChannels, sampleRate, pcmByteLength)),
		0,
	);
	return wavBuffer;
}

/**
 * Assembles a complete WAV file from raw int16 PCM data segments.
 * Concatenates all segments after a proper WAV header.
 * @param segments - Array of raw interleaved int16 PCM data buffers
 * @param numChannels - Number of audio channels
 * @param sampleRate - Sample rate in Hz
 * @returns ArrayBuffer containing the complete WAV file
 * @throws Error when the segments together are too large for a WAV container
 */
export function assembleWavFromPcmSegments(
	segments: ArrayBuffer[],
	numChannels: number,
	sampleRate: number,
): ArrayBuffer {
	const totalPcmSize = segments.reduce((sum, buf) => sum + buf.byteLength, 0);

	const wavBuffer = createWavFileBuffer(
		numChannels,
		sampleRate,
		totalPcmSize,
	);
	const wavView = new Uint8Array(wavBuffer);

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
 * @throws Error when a segment grew between stat and read, or when the
 *   segments together are too large for a WAV container
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
			assertPcmFitsWav(totalPcmSize);
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
