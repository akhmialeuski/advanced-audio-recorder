/**
 * Double for `src/audio/AudioEncoder` as the streaming conversion needs it: an
 * encoder registered for every format, an output format the Conversion double
 * accepts, and an encoder that takes every source rate.
 *
 * The streaming core, the encoding worker and the conversion ladder all reach
 * these through runStreamingConversion, so one copy keeps them asking the
 * same encoder. A case that wants a refused rate overrides one answer of
 * `encodableSampleRate` rather than restating the double.
 *
 * Usage:
 * ```ts
 * jest.mock('src/audio/AudioEncoder', () =>
 *     require('../mocks/modules/streamingAudioEncoder'),
 * );
 * ```
 * @module tests/mocks/modules/streamingAudioEncoder
 */

export const ensureEncoderRegistered = jest.fn().mockResolvedValue(undefined);

export const createOutputFormat = jest.fn().mockReturnValue({});

/** Leaves a conversion at the rate it came in with. */
export const encodableSampleRate = jest.fn(
	(
		_codec: string,
		question: { sampleRate: number },
	): Promise<number | null> => Promise.resolve(question.sampleRate),
);
