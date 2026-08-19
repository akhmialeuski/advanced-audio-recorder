/**
 * Default double for `src/audio/AudioEncoder`, as the recording suites need it.
 *
 * Offline encoding is a mediabunny concern with a TextDecoder requirement jsdom
 * only half satisfies, so the recording suites stub it out. The async probe
 * answers false on purpose: those suites exercise recording, where a format is
 * recordable only when MediaRecorder supports it.
 *
 * Other suites mock this module differently - a conversion test cares which
 * format came back, a capability test cares which formats are supported - and
 * keep their own factory. This is the shared default, not the only one.
 *
 * Usage:
 * ```ts
 * jest.mock('src/audio/AudioEncoder', () =>
 *     require('../mocks/modules/audioEncoder'),
 * );
 * ```
 * @module tests/mocks/modules/audioEncoder
 */

/** Formats the double reports as encodable offline. */
export const OFFLINE_ENCODABLE = [
	'mp3',
	'flac',
	'aac',
	'webm',
	'ogg',
	'mp4',
	'm4a',
];

export const encodeAudioBuffer = jest
	.fn()
	.mockResolvedValue(new Blob(['encoded'], { type: 'audio/webm' }));

export const isOfflineEncodingSupported = jest.fn((format: string): boolean =>
	OFFLINE_ENCODABLE.includes(format),
);

export const probeOfflineEncodingSupport = jest.fn(
	(): Promise<boolean> => Promise.resolve(false),
);
