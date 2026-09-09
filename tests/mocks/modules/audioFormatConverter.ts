/**
 * The part of `src/audio/AudioFormatConverter` every suite that renders a
 * bitrate row needs, whatever else it stubs.
 *
 * Those suites replace the module to keep real decoding out of a dialog test,
 * and the row then asks it for the rate a conversion encodes at. Three of them
 * answered that question with the same stub written out three times; spreading
 * this one keeps the next suite from writing a fourth.
 *
 * Usage, alongside whatever else the suite stubs:
 * ```ts
 * jest.mock('src/audio/AudioFormatConverter', () => ({
 *     ...require('../mocks/modules/audioFormatConverter'),
 *     decodeAudioBlob: jest.fn(),
 * }));
 * ```
 * @module tests/mocks/modules/audioFormatConverter
 */

/**
 * The rate an offline encode runs at, answered the way the real function does
 * where there is no AudioContext to read: with the rate asked for. A suite
 * about the device's own rate installs one and scripts this instead.
 */
export const offlineEncodeSampleRate = jest.fn(
	(requested: number): number => requested,
);
