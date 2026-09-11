/**
 * Default double for `src/transcription/audioChunks`.
 *
 * Three suites carried an identical copy of this factory. None of them tests
 * decoding - they test what an engine does with the bytes that come back - and
 * the real decode needs an `OfflineAudioContext` jsdom has no engine for, so
 * the two helpers that touch Web Audio answer with fixed bytes here.
 *
 * Everything else is the real module. The size arithmetic in particular has to
 * be: `uploadContainer` refuses a decode whose WAV would exceed one request,
 * and a stubbed {@link monoWavByteLength} would let that branch pass against a
 * number the encoder never produces.
 *
 * Usage:
 * ```ts
 * jest.mock('src/transcription/audioChunks', () =>
 *     require('../mocks/modules/audioChunks'),
 * );
 * ```
 * @module tests/mocks/modules/audioChunks
 */

const actual = jest.requireActual<
	typeof import('src/transcription/audioChunks')
>('src/transcription/audioChunks');

/** Samples a decode answers with, small enough to keep the fixtures readable. */
export const DECODED_SAMPLE_COUNT = 4;

/** Byte length the encoded WAV double hands back. */
export const ENCODED_WAV_BYTES = 16;

export const planChunks = actual.planChunks;
export const splitChunkPlan = actual.splitChunkPlan;
export const secondsWithinRequestBytes = actual.secondsWithinRequestBytes;
export const monoWavByteLength = actual.monoWavByteLength;

/**
 * A decode result of a given length, for a test about how long a recording is.
 *
 * Only the sample count is read on that path - it is what the duration and the
 * encoded size are computed from, and the encoder is a double here - so the
 * samples themselves are never allocated. Three hours of them would be 691 MB,
 * which is the reason a stand-in exists rather than a real array, and it lives
 * here because this module already owns what a decode answers with.
 * @param count - Samples the decode should report
 * @returns A decode result of that length
 */
export function decodedSamples(count: number): Float32Array {
	return { length: count } as unknown as Float32Array;
}

export const decodeToMono16k = jest
	.fn()
	.mockResolvedValue(decodedSamples(DECODED_SAMPLE_COUNT));
export const encodeMonoWav = jest
	.fn()
	.mockReturnValue(new ArrayBuffer(ENCODED_WAV_BYTES));
export const extractChunkWav = jest
	.fn()
	.mockReturnValue(new ArrayBuffer(ENCODED_WAV_BYTES));
