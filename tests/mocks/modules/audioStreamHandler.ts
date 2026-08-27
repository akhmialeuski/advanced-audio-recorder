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
// Answers with the stream indexes whose device is gone; empty by default, so
// a session whose inputs are all present is the case a suite gets for free.
export const missingCaptureIndexes = jest.fn(() => Promise.resolve([]));
// Returns the release function the real one does, so a manager tearing a
// session down calls something rather than tripping over undefined.
export const watchStreamEndings = jest.fn(() => jest.fn());
// The device API as this environment has it. Answered from the ambient
// navigator rather than faked, so a suite that installs a mediaDevices double
// is watched through it and one that installs none is simply not watched -
// both of which are real environments the watcher runs in.
export const audioDeviceApi = jest.fn(
	() => (navigator.mediaDevices as MediaDevices | undefined) ?? null,
);
