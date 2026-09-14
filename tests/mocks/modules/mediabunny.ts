/**
 * Default double for the `mediabunny` conversion pipeline and its container
 * probe.
 *
 * Three suites carried an identical copy of this factory, and the metadata
 * probe suite a fourth that only added a duration and the input's disposal.
 * None of them tests mediabunny - they test what the plugin asks it to do - so
 * the surface lives here and a suite scripts only the call it asserts on,
 * through the exported spies.
 *
 * Usage:
 * ```ts
 * jest.mock('mediabunny', () => require('../mocks/modules/mediabunny'));
 * import { conversionInit } from '../mocks/modules/mediabunny';
 * ```
 * @module tests/mocks/modules/mediabunny
 */

/** Byte length of the buffer a finished conversion hands back. */
export const CONVERTED_BYTES = 64;

/** The buffer `BufferTarget` exposes once a conversion has run. */
export const convertedBuffer = new ArrayBuffer(CONVERTED_BYTES);

/** `Conversion.init`; script it with the conversion object a test wants. */
export const conversionInit = jest.fn();

/**
 * The audio track the input reports; resolve it with a track descriptor. It is
 * handed the input it was asked of.
 */
export const getPrimaryAudioTrack = jest.fn();

/** `Input.computeDuration`; resolve it with the length the container carries. */
export const computeDuration = jest.fn();

/** `Input.dispose`, for asserting the source was released. */
export const inputDispose = jest.fn();

/**
 * Each input remembers its own disposal and hands itself to the track spy, so
 * a suite can answer a read the way mediabunny does once the input is gone.
 */
export const Input = jest.fn().mockImplementation(() => {
	const input = {
		disposed: false,
		getPrimaryAudioTrack: (): unknown => getPrimaryAudioTrack(input),
		computeDuration: (): unknown => computeDuration(),
		dispose: (): void => {
			input.disposed = true;
			inputDispose();
		},
	};
	return input;
});

export const Output = jest.fn().mockImplementation(() => ({}));

export const BlobSource = jest.fn();

/** The sources a probe reads: bytes already in memory, or a URL read by range. */
export const BufferSource = jest.fn();
export const UrlSource = jest.fn();

export const BufferTarget = jest.fn().mockImplementation(() => ({
	buffer: convertedBuffer,
}));

export const ALL_FORMATS: unknown[] = [];

/**
 * The container writers the format registry builds, one per registered format.
 * Nothing here is called by a test: the registry only needs the constructors
 * to exist, and a suite that pulls the registry in gets them for free rather
 * than repeating the list.
 */
export const Mp4OutputFormat = jest.fn();
export const WebMOutputFormat = jest.fn();
export const OggOutputFormat = jest.fn();
export const FlacOutputFormat = jest.fn();
export const Mp3OutputFormat = jest.fn();
export const WavOutputFormat = jest.fn();

/**
 * The encoding quality mediabunny is asked about, holding the options it was
 * built from so a suite can read back the bitrate a probe enquired about.
 * Mediabunny keeps them private and exposes them only to its own encoder, so
 * the double is what makes the question visible.
 */
export const Quality = jest
	.fn()
	.mockImplementation((options: unknown) => ({ options }));

/**
 * `canEncodeAudio`, the browser's own encoder question. It answers no by
 * default, which is what jsdom really reports, and a suite about which
 * parameters an encoder accepts scripts it.
 */
export const canEncodeAudio = jest.fn(
	(): Promise<boolean> => Promise.resolve(false),
);

/**
 * Stand-in for mediabunny's sample wrapper: the streaming path only ever
 * constructs one and reads back the fields it passed in.
 */
export class AudioSample {
	constructor(init: object) {
		Object.assign(this, init);
	}
}

export const Conversion = {
	init: (...args: unknown[]): unknown => conversionInit(...args),
};
