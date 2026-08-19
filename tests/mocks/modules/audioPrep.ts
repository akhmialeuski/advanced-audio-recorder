/**
 * Default double for `src/transcription/audioPrep`.
 *
 * Two suites carried the same factory. Neither tests audio preparation - they
 * test what the service does with what it gets back - and the real thing needs
 * a Web Audio decode jsdom has no engine for.
 *
 * `prepareAudio` deliberately has no default result: a test that runs the
 * service states what came out of preparation.
 *
 * Usage:
 * ```ts
 * jest.mock('src/transcription/audioPrep', () =>
 *     require('../mocks/modules/audioPrep'),
 * );
 * ```
 * @module tests/mocks/modules/audioPrep
 */

export const prepareAudio = jest.fn();
export const audioMimeFromExtension = jest.fn(() => 'audio/webm');
export const audioPrepOptions = jest.fn(() => ({}));
