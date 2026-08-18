/**
 * The recording manager as the e2e suites see it: every method a spy, and an
 * idle recorder that answers zero to every live reading.
 *
 * Its own module because five suites need the same double and `jest.mock` is
 * hoisted per file - a shared factory can be delegated to in one line, while a
 * shared object could not be referenced from inside the hoisted call.
 * @module tests/mocks/modules/recordingManager
 */

import { RecordingStatus } from 'src/types';

/** Every method the plugin calls on its recording manager, as a spy. */
export interface RecorderDouble {
	toggleRecording: jest.Mock;
	togglePauseResume: jest.Mock;
	stopRecording: jest.Mock;
	cleanup: jest.Mock;
	updateSettings: jest.Mock;
	getStatus: jest.Mock;
	canDropMarker: jest.Mock;
	captureMarkerDraft: jest.Mock;
	getElapsedMs: jest.Mock;
	getRecordedBytes: jest.Mock;
	getInputLevel: jest.Mock;
}

export const RecordingManager = jest.fn(
	(): RecorderDouble => ({
		toggleRecording: jest.fn().mockResolvedValue(undefined),
		togglePauseResume: jest.fn(),
		stopRecording: jest.fn().mockResolvedValue(undefined),
		cleanup: jest.fn(),
		updateSettings: jest.fn(),
		getStatus: jest.fn(() => RecordingStatus.Idle),
		canDropMarker: jest.fn(() => false),
		captureMarkerDraft: jest.fn(() => null),
		getElapsedMs: jest.fn(() => 0),
		getRecordedBytes: jest.fn(() => 0),
		getInputLevel: jest.fn(() => 0),
	}),
);
