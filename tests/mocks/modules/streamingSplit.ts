/**
 * Default double for `src/audio/streamingSplit`.
 *
 * The streamed split decodes through WebCodecs' AudioDecoder, which jsdom does
 * not have, so the split suites that are not about it script whether a source
 * can be streamed. By default it cannot, which is the device the decode-
 * everything path is for; a suite about the streamed route resolves `open`
 * once with a scripted split. The split itself runs on the real mediabunny in
 * `tests/unit/streamingSplit.test.ts`.
 *
 * Everything else is the real module, the error class in particular, because
 * the caller tells a failed streamed part from any other failure by it.
 *
 * Usage:
 * ```ts
 * jest.mock('src/audio/streamingSplit', () =>
 *     require('../mocks/modules/streamingSplit'),
 * );
 * ```
 * @module tests/mocks/modules/streamingSplit
 */

const actual = jest.requireActual<typeof import('src/audio/streamingSplit')>(
	'src/audio/streamingSplit',
);

export const StreamedSplitError = actual.StreamedSplitError;
export const SPLIT_TAIL_SECONDS = actual.SPLIT_TAIL_SECONDS;

/** `StreamedSplit.open`; answers that this device cannot stream the source. */
export const StreamedSplit = {
	open: jest.fn().mockResolvedValue(null),
};
