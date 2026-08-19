/**
 * The PCM capture recorder as the RecordingManager suites see it: a mono
 * 44.1 kHz source whose start, stop, pause and resume are spies.
 *
 * The real one owns an AudioWorklet, which jsdom has no equivalent for; what
 * the manager owes it is the call sequence and the arguments each recorder was
 * built with, which is what this records. A test reads the chunk callback or
 * the channel mode off `PcmStreamRecorder.mock.calls` rather than installing a
 * factory of its own.
 * @module tests/mocks/modules/pcmStreamRecorder
 */

import type { ChannelMode } from 'src/audio/downmix';

/** The surface RecordingManager drives on a PCM recorder, as spies. */
export interface PcmRecorderDouble {
	channels: number;
	sampleRate: number;
	start: jest.Mock;
	stop: jest.Mock;
	pause: jest.Mock;
	resume: jest.Mock;
}

export const PcmStreamRecorder = jest.fn(
	(
		_stream: MediaStream,
		_sampleRate: number,
		_onChunk: (data: ArrayBuffer) => void,
		_channelMode?: ChannelMode,
	): PcmRecorderDouble => ({
		channels: 1,
		sampleRate: 44100,
		start: jest.fn().mockResolvedValue(undefined),
		stop: jest.fn().mockResolvedValue(undefined),
		pause: jest.fn(),
		resume: jest.fn(),
	}),
);
