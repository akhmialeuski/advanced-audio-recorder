/**
 * The two records the write path is built around: a track's write target and
 * the session config that governs it.
 *
 * Four suites carried the same eleven-field target literal and three carried
 * the same ten-field session, differing in one or two fields each. Both are
 * plain data the code under test owns, so the shape belongs in one place and a
 * suite names only what it changes.
 * @module tests/helpers/recordingFixtures
 */

import type { RecordingSessionConfig, RecordingTarget } from 'src/types';

/**
 * A track's write target, freshly opened: nothing buffered, nothing written.
 * @param overrides - Fields this test cares about
 * @returns The target
 */
export function createTarget(
	overrides: Partial<RecordingTarget> = {},
): RecordingTarget {
	return {
		fileBaseName: 'recording-Track1-stamp',
		sourceName: 'Track1',
		bufferedChunks: [],
		bufferedBytes: 0,
		segmentIndex: 0,
		segmentPaths: [],
		pendingWrite: Promise.resolve(),
		pcmBuffers: [],
		pcmBufferedBytes: 0,
		pcmChannels: 1,
		pcmSampleRate: 44100,
		partIndex: 0,
		partPaths: [],
		partPcmBytes: 0,
		...overrides,
	};
}

/**
 * The session config for a plain WebM recording with no rotation.
 *
 * The defaults are the quiet case - one container, no splitting, no PCM - so a
 * suite that turns on splitting or PCM says exactly that, and a reader can see
 * which switch the test is about.
 * @param overrides - Fields this test cares about
 * @returns The session config
 */
export function createSession(
	overrides: Partial<RecordingSessionConfig> = {},
): RecordingSessionConfig {
	return {
		chunkRotationBytes: null,
		isWavPcm: false,
		recorderFormat: 'webm',
		outputFormat: 'webm',
		outputMode: 'multiple',
		bitrate: 128000,
		splitEnabled: false,
		partMinutes: 15,
		partSuffix: 'part',
		...overrides,
	};
}
