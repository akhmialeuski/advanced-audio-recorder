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

/**
 * The container ceiling, taken from the real module.
 *
 * A double that left it out would hand `undefined` to the recording manager,
 * whose "is this file filling up" comparison then answers no for every size,
 * and the suites would pass against a warning that can never fire. It is a
 * constant of the WAV format rather than behaviour worth faking, so the double
 * borrows the real one.
 */
export const WAV_PCM_WARNING_BYTES = jest.requireActual<
	typeof import('src/audio/WavEncoder')
>('src/audio/WavEncoder').WAV_PCM_WARNING_BYTES;

/**
 * The container refusal, taken from the real module for the same reason.
 *
 * Callers tell it from other failures with `instanceof`, so a double declaring
 * a class of its own would make every one of those checks answer no and the
 * suites would pass against a branch that can never be taken.
 */
export const WavSizeLimitError = jest.requireActual<
	typeof import('src/audio/WavEncoder')
>('src/audio/WavEncoder').WavSizeLimitError;

/**
 * The refusal's wording, taken from the real module for the same reason again.
 *
 * The finalizer puts it in the notice naming the tracks it could not write, so
 * a double omitting it would have those suites assert against "undefined" and
 * pass whatever the sentence said.
 */
export const WAV_SIZE_LIMIT_MESSAGE = jest.requireActual<
	typeof import('src/audio/WavEncoder')
>('src/audio/WavEncoder').WAV_SIZE_LIMIT_MESSAGE;

export const assembleWavFromPcmSegmentFiles = jest
	.fn()
	.mockResolvedValue(new ArrayBuffer(WAV_HEADER_BYTES));
