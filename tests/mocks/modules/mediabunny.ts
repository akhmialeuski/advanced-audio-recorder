/**
 * Default double for the `mediabunny` conversion pipeline.
 *
 * Three suites carried an identical copy of this factory. None of them tests
 * mediabunny - they test what the plugin asks it to do - so the surface lives
 * here and a suite scripts only the call it asserts on, through the exported
 * spies.
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

/** The audio track the input reports; resolve it with a track descriptor. */
export const getPrimaryAudioTrack = jest.fn();

/** `Input.dispose`, for asserting the source was released. */
export const inputDispose = jest.fn();

export const Input = jest.fn().mockImplementation(() => ({
	getPrimaryAudioTrack: (): unknown => getPrimaryAudioTrack(),
	dispose: inputDispose,
}));

export const Output = jest.fn().mockImplementation(() => ({}));

export const BlobSource = jest.fn();

export const BufferTarget = jest.fn().mockImplementation(() => ({
	buffer: convertedBuffer,
}));

export const ALL_FORMATS: unknown[] = [];

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
