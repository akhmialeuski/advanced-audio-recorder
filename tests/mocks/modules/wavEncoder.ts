/**
 * Default double for `src/audio/WavEncoder`.
 *
 * Seven suites carried an identical copy of this factory. Assembling a WAV is
 * not what any of them is testing - they need the call to resolve with some
 * bytes so the write chain continues - so the default lives here and a suite
 * that cares about the bytes overrides the mock in its own beforeEach.
 *
 * Usage:
 * ```ts
 * jest.mock('src/audio/WavEncoder', () =>
 *     require('../mocks/modules/wavEncoder'),
 * );
 * ```
 * @module tests/mocks/modules/wavEncoder
 */

/** Byte length of a canonical WAV header, which is all the double returns. */
export const WAV_HEADER_BYTES = 44;

export const assembleWavFromPcmSegmentFiles = jest
	.fn()
	.mockResolvedValue(new ArrayBuffer(WAV_HEADER_BYTES));
