/**
 * Default double for `src/recording/AudioStreamHandler`.
 *
 * Six suites in the RecordingManager family carried an identical copy. None of
 * them is testing stream acquisition; they need it out of the way so the
 * recorder can be driven directly. `getAudioStreams` deliberately has no
 * default result - a suite that starts a recording states what the microphone
 * gave it.
 *
 * Usage:
 * ```ts
 * jest.mock('src/recording/AudioStreamHandler', () =>
 *     require('./helpers/../../mocks/modules/audioStreamHandler'),
 * );
 * ```
 * @module tests/mocks/modules/audioStreamHandler
 */

export const getAudioStreams = jest.fn();
export const getAudioSourceName = jest.fn().mockResolvedValue('TestDevice');
export const stopAllStreams = jest.fn();
export const validateSelectedDevices = jest.fn();
