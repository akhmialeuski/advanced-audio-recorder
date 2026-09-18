/**
 * WAV header utilities for assembling WAV files from the raw PCM
 * segments captured by the streaming recording path. AudioBuffer
 * encoding goes through mediabunny (see AudioEncoder), which handles
 * WAVE output natively.
 *
 * Which representation the samples are in is the caller's to say, through
 * {@link module:audio/pcm.PcmSampleFormat}: the header states the width, the
 * rate that width implies, and - for floating point samples - the format tag
 * and the extra chunk the WAVE specification requires of every non-PCM
 * representation.
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
import { PCM_SAMPLE_BITS, PCM_SAMPLE_BYTES, PcmSampleFormat } from './pcm';

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
 * WAV header size in bytes for the integer representations, whose `fmt `
 * chunk needs no extension and which carry no `fact` chunk.
 */
export const WAV_HEADER_SIZE = 44;

/** Byte length of a RIFF chunk header (4-byte id + 4-byte size). */
const RIFF_CHUNK_HEADER_SIZE = 8;

/** Size in bytes of the PCM "fmt " subchunk body (WAV spec). */
const WAV_FMT_CHUNK_SIZE = 16;

/**
 * Size in bytes of the "fmt " subchunk body of a non-PCM representation.
 *
 * Two bytes longer than the PCM one, holding the `cbSize` count of the
 * extension that follows it. Nothing follows it here, so the count is zero,
 * but the field itself is what tells a reader the chunk describes something
 * other than integer PCM.
 */
const WAV_FMT_CHUNK_SIZE_NON_PCM = 18;

/** Size in bytes of the "fact" subchunk body: one sample-frame count. */
const WAV_FACT_CHUNK_SIZE = 4;

/** WAV format tag for uncompressed integer PCM (WAV spec). */
const WAV_FORMAT_PCM = 1;

/** WAV format tag for uncompressed IEEE floating point samples (WAV spec). */
const WAV_FORMAT_IEEE_FLOAT = 3;

/**
 * Whether this representation is one the WAVE specification treats as
 * something other than plain integer PCM, and therefore requires both the
 * extended `fmt ` chunk and a `fact` chunk of.
 * @param format - Sample representation
 */
function isNonPcmFormat(format: PcmSampleFormat): boolean {
	return format === PcmSampleFormat.Float32;
}

/**
 * Bytes of header a WAV of this representation carries before its samples.
 * @param format - Sample representation the file holds
 * @returns Byte offset where the sample data starts
 */
export function wavHeaderSize(
	format: PcmSampleFormat = PcmSampleFormat.Int16,
): number {
	return isNonPcmFormat(format)
		? WAV_HEADER_SIZE +
				(WAV_FMT_CHUNK_SIZE_NON_PCM - WAV_FMT_CHUNK_SIZE) +
				RIFF_CHUNK_HEADER_SIZE +
				WAV_FACT_CHUNK_SIZE
		: WAV_HEADER_SIZE;
}

/**
 * Largest PCM payload a RIFF header can describe.
 *
 * Both size fields are unsigned 32-bit. The data field holds the payload
 * alone, while the RIFF field holds the payload plus the rest of the header
 * (everything after its own 8 bytes), so the RIFF field is the one that
 * overflows first and it is what this bound is taken from.
 *
 * Stated for the integer representations, whose header is the shortest; a
 * representation carrying more header has correspondingly less room, which
 * {@link wavMaxPcmBytes} answers exactly.
 */
export const WAV_MAX_PCM_BYTES = 0xffffffff - (WAV_HEADER_SIZE - 8);

/**
 * Largest PCM payload a WAV of this representation can describe.
 * @param format - Sample representation the file holds
 * @returns The payload ceiling in bytes
 */
export function wavMaxPcmBytes(
	format: PcmSampleFormat = PcmSampleFormat.Int16,
): number {
	return 0xffffffff - (wavHeaderSize(format) - RIFF_CHUNK_HEADER_SIZE);
}

/**
 * Share of {@link WAV_MAX_PCM_BYTES} a recording may reach before the user is
 * told. Far enough below the ceiling that a warning still leaves time to act:
 * at 48 kHz stereo the remaining tenth is around half an hour of capture.
 */
const WAV_PCM_WARNING_RATIO = 0.9;

/**
 * PCM size at which a recording is warned that the container is filling up.
 *
 * One figure for every representation. The ceilings differ by the fourteen
 * bytes of header a floating point file carries, which is nothing against the
 * four hundred megabytes of slack the warning already leaves.
 */
export const WAV_PCM_WARNING_BYTES = Math.floor(
	WAV_MAX_PCM_BYTES * WAV_PCM_WARNING_RATIO,
);

/**
 * What a caller is told when the audio outgrew the container.
 *
 * Recovery is deliberately not offered as the way out, though the segments it
 * reads are exactly what survives: it assembles through this same module, so
 * it meets this same refusal and reports the track as one it could not
 * recover. Naming it would send the user round a loop that cannot end, and the
 * only thing that does end it is a session that was split as it was recorded.
 */
export const WAV_SIZE_LIMIT_MESSAGE =
	'This recording is too long for a WAV file, which cannot exceed 4 GB. ' +
	'The captured audio is kept as raw segments, but it cannot be assembled ' +
	'into one WAV. Enable auto-split in the recording settings so a long ' +
	'recording is saved as parts.';

/**
 * The refusal of audio that outgrew the container.
 *
 * A type of its own because a caller has to be able to tell it from a failure
 * of the way it happened to be building the file. A mix that can be attempted
 * another way answers a failure by trying that way, and this is the one
 * failure where the other way is no better: the ceiling belongs to the audio,
 * not to the route taken to encode it, so every route reaches it.
 */
export class WavSizeLimitError extends Error {
	constructor() {
		super(WAV_SIZE_LIMIT_MESSAGE);
		this.name = 'WavSizeLimitError';
	}
}

/**
 * Refuses a PCM payload the container cannot describe.
 *
 * Asked before the allocation on every path that builds a WAV, because both
 * outcomes of asking later are a loss: `setUint32` drops the high bits without
 * a word and writes a file players read as truncated, and an allocation past
 * the engine's own ceiling throws only after the recording has stopped. Asked
 * here, the refusal costs nothing and the PCM segments are still on disk.
 * @param pcmByteLength - Total PCM payload in bytes
 * @param format - Sample representation the file holds
 * @throws WavSizeLimitError when the payload does not fit a WAV container
 */
function assertPcmFitsWav(
	pcmByteLength: number,
	format: PcmSampleFormat,
): void {
	if (pcmByteLength > wavMaxPcmBytes(format)) {
		throw new WavSizeLimitError();
	}
}

/**
 * Creates a WAV header info object for debugging.
 * @param numChannels - Number of audio channels
 * @param sampleRate - Sample rate in Hz
 * @param dataLength - Length of audio data in bytes
 * @param format - Sample representation the file holds
 * @returns Header information object
 */
export function getWavHeaderInfo(
	numChannels: number,
	sampleRate: number,
	dataLength: number,
	format: PcmSampleFormat = PcmSampleFormat.Int16,
): { headerSize: number; totalSize: number; byteRate: number } {
	const headerSize = wavHeaderSize(format);
	return {
		headerSize,
		totalSize: dataLength + headerSize,
		byteRate: sampleRate * PCM_SAMPLE_BYTES[format] * numChannels,
	};
}

/**
 * Creates the WAV file header for raw PCM data of the given representation.
 *
 * Integer samples produce the canonical 44-byte header. Floating point ones
 * produce a longer one: the format tag says IEEE float, the `fmt ` chunk
 * carries the `cbSize` field every non-PCM representation is declared with,
 * and a `fact` chunk states the sample-frame count, which the specification
 * requires of such a file and which strict readers take the length from.
 * @param numChannels - Number of audio channels
 * @param sampleRate - Sample rate in Hz
 * @param pcmDataLength - Total length of PCM data in bytes
 * @param format - Sample representation the file holds
 * @returns ArrayBuffer containing the WAV header
 * @throws WavSizeLimitError when the PCM data is too large for the container
 */
export function createWavHeader(
	numChannels: number,
	sampleRate: number,
	pcmDataLength: number,
	format: PcmSampleFormat = PcmSampleFormat.Int16,
): ArrayBuffer {
	assertPcmFitsWav(pcmDataLength, format);
	const nonPcm = isNonPcmFormat(format);
	const headerSize = wavHeaderSize(format);
	const header = new ArrayBuffer(headerSize);
	const view = new DataView(header);
	const blockAlign = numChannels * PCM_SAMPLE_BYTES[format];
	const byteRate = sampleRate * blockAlign;
	let offset = 0;

	// RIFF header
	writeString(view, offset, 'RIFF');
	offset += 4;
	view.setUint32(offset, headerSize - 8 + pcmDataLength, true);
	offset += 4;
	writeString(view, offset, 'WAVE');
	offset += 4;

	// fmt subchunk
	writeString(view, offset, 'fmt ');
	offset += 4;
	view.setUint32(
		offset,
		nonPcm ? WAV_FMT_CHUNK_SIZE_NON_PCM : WAV_FMT_CHUNK_SIZE,
		true,
	);
	offset += 4;
	view.setUint16(
		offset,
		nonPcm ? WAV_FORMAT_IEEE_FLOAT : WAV_FORMAT_PCM,
		true,
	);
	offset += 2;
	view.setUint16(offset, numChannels, true);
	offset += 2;
	view.setUint32(offset, sampleRate, true);
	offset += 4;
	view.setUint32(offset, byteRate, true);
	offset += 4;
	view.setUint16(offset, blockAlign, true);
	offset += 2;
	view.setUint16(offset, PCM_SAMPLE_BITS[format], true);
	offset += 2;

	if (nonPcm) {
		// cbSize: no extension follows, and the field saying so is itself
		// what declares the chunk a non-PCM one.
		view.setUint16(offset, 0, true);
		offset += 2;
		// fact subchunk: the sample-frame count, which a reader that takes
		// the length from it rather than from the data chunk needs.
		writeString(view, offset, 'fact');
		offset += 4;
		view.setUint32(offset, WAV_FACT_CHUNK_SIZE, true);
		offset += 4;
		view.setUint32(
			offset,
			blockAlign > 0 ? Math.floor(pcmDataLength / blockAlign) : 0,
			true,
		);
		offset += 4;
	}

	// data subchunk header
	writeString(view, offset, 'data');
	offset += 4;
	view.setUint32(offset, pcmDataLength, true);

	return header;
}

/**
 * Allocates a complete WAV file buffer with the header already written.
 * Callers fill the PCM region (starting at wavHeaderSize(format)) afterwards.
 * @param numChannels - Number of audio channels
 * @param sampleRate - Sample rate in Hz
 * @param pcmByteLength - Total length of PCM data in bytes
 * @param format - Sample representation the file holds
 * @returns ArrayBuffer sized for header plus PCM, header written
 * @throws WavSizeLimitError when the PCM data is too large for the container
 */
export function createWavFileBuffer(
	numChannels: number,
	sampleRate: number,
	pcmByteLength: number,
	format: PcmSampleFormat = PcmSampleFormat.Int16,
): ArrayBuffer {
	assertPcmFitsWav(pcmByteLength, format);
	const wavBuffer = new ArrayBuffer(wavHeaderSize(format) + pcmByteLength);
	new Uint8Array(wavBuffer).set(
		new Uint8Array(
			createWavHeader(numChannels, sampleRate, pcmByteLength, format),
		),
		0,
	);
	return wavBuffer;
}

/**
 * Assembles a complete WAV file from raw PCM data segments.
 * Concatenates all segments after a proper WAV header.
 * @param segments - Array of raw interleaved PCM data buffers
 * @param numChannels - Number of audio channels
 * @param sampleRate - Sample rate in Hz
 * @param format - Sample representation the segments hold
 * @returns ArrayBuffer containing the complete WAV file
 * @throws WavSizeLimitError when the segments together are too large for a
 *   WAV container
 */
export function assembleWavFromPcmSegments(
	segments: ArrayBuffer[],
	numChannels: number,
	sampleRate: number,
	format: PcmSampleFormat = PcmSampleFormat.Int16,
): ArrayBuffer {
	const totalPcmSize = segments.reduce((sum, buf) => sum + buf.byteLength, 0);

	const wavBuffer = createWavFileBuffer(
		numChannels,
		sampleRate,
		totalPcmSize,
		format,
	);
	const wavView = new Uint8Array(wavBuffer);

	// Copy PCM segments
	let offset = wavHeaderSize(format);
	for (const segment of segments) {
		wavView.set(new Uint8Array(segment), offset);
		offset += segment.byteLength;
	}

	return wavBuffer;
}

/**
 * Assembles a complete WAV file from flushed PCM segment files.
 * When the vault adapter can report file sizes, the final buffer is
 * allocated once and the segments stream into it sequentially - peak
 * memory is the final file plus one segment, instead of two full
 * copies of the recording. Falls back to read-all-then-assemble for
 * adapters without stat support.
 * @param segmentPaths - Segment files in capture order (vault-relative)
 * @param numChannels - Number of audio channels
 * @param sampleRate - Sample rate in Hz
 * @param app - Obsidian App instance
 * @param format - Sample representation the segments hold
 * @returns ArrayBuffer containing the complete WAV file
 * @throws Error when a segment grew between stat and read
 * @throws WavSizeLimitError when the segments together are too large for a
 *   WAV container
 */
export async function assembleWavFromPcmSegmentFiles(
	segmentPaths: string[],
	numChannels: number,
	sampleRate: number,
	app: App,
	format: PcmSampleFormat = PcmSampleFormat.Int16,
): Promise<ArrayBuffer> {
	const adapter = app.vault.adapter;
	const headerSize = wavHeaderSize(format);
	if (typeof adapter.stat === 'function') {
		const stats = await Promise.all(
			segmentPaths.map((path) => adapter.stat(path)),
		);
		if (stats.every((stat) => stat != null)) {
			const totalPcmSize = stats.reduce(
				(sum, stat) => sum + (stat?.size ?? 0),
				0,
			);
			assertPcmFitsWav(totalPcmSize, format);
			const wavBuffer = new ArrayBuffer(headerSize + totalPcmSize);
			const wavView = new Uint8Array(wavBuffer);
			let offset = headerSize;
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
				offset - headerSize,
				format,
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
	return assembleWavFromPcmSegments(
		segments,
		numChannels,
		sampleRate,
		format,
	);
}
