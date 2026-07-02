/**
 * Splitting decoded audio into upload-sized chunks for the Whisper API.
 * The planning (how to divide a duration into chunks that stay under the
 * upload limit) is pure and tested; producing the actual 16 kHz mono WAV
 * for each chunk uses the Web Audio API and is kept thin.
 * @module transcription/audioChunks
 */

import { TRANSCRIBE_BYTES_PER_SEC, TRANSCRIBE_SAMPLE_RATE } from '../constants';
import { createWavHeader, WAV_HEADER_SIZE } from '../audio/WavEncoder';
import { decodeAudioBlob } from '../audio/AudioFormatConverter';

/**
 * Encodes mono Float32 samples (range -1..1) into a 16-bit PCM WAV blob.
 * @param samples - Mono sample data
 * @param sampleRate - Sample rate in Hz
 * @returns WAV-encoded bytes
 */
export function encodeMonoWav(
	samples: Float32Array,
	sampleRate: number,
): ArrayBuffer {
	const pcmByteLength = samples.length * 2;
	const header = createWavHeader(1, sampleRate, pcmByteLength);
	const out = new ArrayBuffer(WAV_HEADER_SIZE + pcmByteLength);
	new Uint8Array(out).set(new Uint8Array(header), 0);
	const view = new DataView(out, WAV_HEADER_SIZE);
	for (let i = 0; i < samples.length; i++) {
		const clamped = Math.max(-1, Math.min(1, samples[i]));
		view.setInt16(i * 2, Math.round(clamped * 0x7fff), true);
	}
	return out;
}

/** A planned chunk: its index and start/end offsets in seconds. */
export interface ChunkPlan {
	index: number;
	startSeconds: number;
	endSeconds: number;
}

/**
 * Plans how to divide a duration into chunks that each stay within the
 * upload byte budget once resampled to 16 kHz mono. A non-positive or
 * non-finite duration yields no chunks; a duration that fits in one
 * chunk yields a single chunk covering the whole file.
 * @param totalSeconds - Total audio duration in seconds
 * @param maxBytes - Maximum upload size per chunk in bytes
 * @returns Ordered chunk plans covering the full duration
 */
export function planChunks(
	totalSeconds: number,
	maxBytes: number,
): ChunkPlan[] {
	if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) {
		return [];
	}
	// Budget the PCM payload only, leaving room for the WAV header each chunk
	// carries, so a chunk's encoded size never exceeds the provider limit
	// (it would by 44 bytes if the header were not subtracted).
	const maxChunkSeconds = Math.max(
		1,
		Math.floor((maxBytes - WAV_HEADER_SIZE) / TRANSCRIBE_BYTES_PER_SEC),
	);
	const chunks: ChunkPlan[] = [];
	let start = 0;
	let index = 0;
	while (start < totalSeconds) {
		const end = Math.min(totalSeconds, start + maxChunkSeconds);
		chunks.push({ index, startSeconds: start, endSeconds: end });
		start = end;
		index += 1;
	}
	return chunks;
}

/**
 * Splits a chunk plan into two halves at its midpoint, for retrying a part
 * that overran a provider's output token limit as smaller pieces. The shared
 * midpoint boundary tiles exactly because {@link extractChunkWav} rounds both
 * ends to the same frame. Returns an empty array when the chunk is too short to
 * divide into two halves that each stay at or above `minSeconds`, signalling
 * the caller to stop subdividing.
 * @param chunk - The chunk plan to split
 * @param minSeconds - Smallest half a split may produce
 * @returns Two half-length plans, or [] when the chunk is at the floor
 */
export function splitChunkPlan(
	chunk: ChunkPlan,
	minSeconds: number,
): ChunkPlan[] {
	const duration = chunk.endSeconds - chunk.startSeconds;
	if (duration < 2 * minSeconds) {
		return [];
	}
	const midSeconds = chunk.startSeconds + duration / 2;
	return [
		{
			index: chunk.index * 2,
			startSeconds: chunk.startSeconds,
			endSeconds: midSeconds,
		},
		{
			index: chunk.index * 2 + 1,
			startSeconds: midSeconds,
			endSeconds: chunk.endSeconds,
		},
	];
}

/**
 * Decodes an audio file and resamples it to a single 16 kHz mono PCM
 * channel via an OfflineAudioContext. This is the canonical Whisper input
 * and makes every source format chunk identically.
 * @param data - Encoded audio bytes
 * @returns Mono Float32 samples at 16 kHz
 */
export async function decodeToMono16k(
	data: ArrayBuffer,
): Promise<Float32Array> {
	// Reuse the shared decoder (owns the AudioContext lifecycle and closes it
	// even on failure) instead of re-implementing decode here.
	const decoded = await decodeAudioBlob(data);
	const frameCount = Math.round(decoded.duration * TRANSCRIBE_SAMPLE_RATE);
	if (!Number.isFinite(frameCount) || frameCount <= 0) {
		return new Float32Array(0);
	}
	const offline = new OfflineAudioContext(
		1,
		frameCount,
		TRANSCRIBE_SAMPLE_RATE,
	);
	const source = offline.createBufferSource();
	source.buffer = decoded;
	source.connect(offline.destination);
	source.start();
	const rendered = await offline.startRendering();
	return rendered.getChannelData(0);
}

/**
 * Extracts one chunk of the mono samples as a WAV byte blob, given the
 * chunk's start/end in seconds.
 * @param samples - Full mono 16 kHz samples
 * @param chunk - Chunk plan
 * @returns WAV-encoded bytes for the chunk
 */
export function extractChunkWav(
	samples: Float32Array,
	chunk: ChunkPlan,
): ArrayBuffer {
	// Round both ends the same way so adjacent chunks tile exactly - a shared
	// boundary maps to one frame, with no duplicated or dropped sample.
	const startFrame = Math.min(
		samples.length,
		Math.round(chunk.startSeconds * TRANSCRIBE_SAMPLE_RATE),
	);
	const endFrame = Math.min(
		samples.length,
		Math.round(chunk.endSeconds * TRANSCRIBE_SAMPLE_RATE),
	);
	const slice = samples.subarray(startFrame, Math.max(startFrame, endFrame));
	return encodeMonoWav(slice, TRANSCRIBE_SAMPLE_RATE);
}
