/**
 * Splitting decoded audio into upload-sized chunks for the Whisper API.
 * The planning (how to divide a duration into chunks that stay under the
 * upload limit) is pure and tested; producing the actual 16 kHz mono WAV
 * for each chunk uses the Web Audio API and is kept thin.
 *
 * The resampling stays with the OfflineAudioContext rather than moving to
 * mediabunny's resampler, which interpolates linearly with no low-pass filter
 * in front, so taking 48 kHz down to 16 kHz through it folds what lies above
 * 8 kHz back into the band speech recognition listens to. Which engine's
 * resampler is the better one is a measurement nobody has made here, and
 * swapping one for the other changes the audio every engine transcribes, so
 * the one the uploads were always built with is kept. The WAV itself is
 * written by WavEncoder, the plugin's one hand-written WAV writer.
 * @module transcription/audioChunks
 */

import { TRANSCRIBE_BYTES_PER_SEC, TRANSCRIBE_SAMPLE_RATE } from '../constants';
import { encodeFloatsAsInt16Wav, WAV_HEADER_SIZE } from '../audio/WavEncoder';
import { decodeAudioBlob } from '../audio/AudioFormatConverter';

/**
 * Encodes mono Float32 samples (range -1..1) into the 16-bit PCM WAV a
 * transcription upload carries, without blocking the UI on a large chunk.
 * @param samples - Mono sample data
 * @param sampleRate - Sample rate in Hz
 * @returns WAV-encoded bytes
 */
export function encodeMonoWav(
	samples: Float32Array,
	sampleRate: number,
): Promise<ArrayBuffer> {
	return encodeFloatsAsInt16Wav([samples], sampleRate);
}

/** A planned chunk: its index and start/end offsets in seconds. */
export interface ChunkPlan {
	index: number;
	startSeconds: number;
	endSeconds: number;
}

/**
 * The longest chunk, in seconds, whose encoded WAV stays within a provider's
 * per-request byte limit.
 *
 * The header every chunk carries is subtracted before the division, because
 * the limit is on the request and the header is part of it: a chunk sized to
 * the limit exceeds it by those 44 bytes otherwise.
 *
 * This is the conversion for a byte-shaped limit alone. A provider whose limit
 * is a duration already states the answer, and putting it through here would
 * cost it a second - which is exactly how a fifteen-minute recording used to
 * become a fourteen-fifty-nine part and a one-second one (see
 * {@link audioPrepOptions}).
 * @param maxBytes - Maximum request size in bytes
 * @returns Longest chunk duration in whole seconds, at least one
 */
export function secondsWithinRequestBytes(maxBytes: number): number {
	return Math.max(
		1,
		Math.floor((maxBytes - WAV_HEADER_SIZE) / TRANSCRIBE_BYTES_PER_SEC),
	);
}

/**
 * Plans how to divide a duration into chunks no longer than the provider takes
 * in one request. A non-positive or non-finite duration yields no chunks; a
 * duration within the limit yields a single chunk covering the whole file.
 *
 * The parts come out equal rather than full-then-remainder. A greedy walk
 * leaves whatever is left over as its own request, and just past the limit
 * that remainder is seconds long: a whole extra call, its instruction tokens
 * paid in full, for audio that carries almost nothing - and on a diarized run,
 * a speaker numbering that restarts for it.
 * @param totalSeconds - Total audio duration in seconds
 * @param maxChunkSeconds - Longest chunk the provider accepts, in seconds
 * @returns Ordered chunk plans covering the full duration
 */
export function planChunks(
	totalSeconds: number,
	maxChunkSeconds: number,
): ChunkPlan[] {
	if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) {
		return [];
	}
	// An unbounded limit divides to zero here, which is one part after the
	// floor: the whole recording, which is what no limit means.
	const count = Math.max(1, Math.ceil(totalSeconds / maxChunkSeconds));
	const chunkSeconds = totalSeconds / count;
	const chunks: ChunkPlan[] = [];
	for (let index = 0; index < count; index++) {
		chunks.push({
			index,
			startSeconds: index * chunkSeconds,
			// The last end is the duration itself rather than a multiple of
			// the part length, so the plans cover the recording exactly
			// whatever the division did to the last decimal place.
			endSeconds:
				index === count - 1 ? totalSeconds : (index + 1) * chunkSeconds,
		});
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
	const decoded = await decodeAudioBlob(data, 'transcribe');
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
): Promise<ArrayBuffer> {
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
