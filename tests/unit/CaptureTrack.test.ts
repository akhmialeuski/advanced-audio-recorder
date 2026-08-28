/**
 * The two capture primitives behind one interface.
 *
 * The point of the interface is that a session's lifecycle is one loop rather
 * than a branch repeated at every step, so what matters here is that both
 * implementations answer every operation, including the ones that mean nothing
 * to one of them. A no-op that throws, or one that quietly does the other
 * primitive's work, would only show up as a broken recording.
 * @module tests/unit/CaptureTrack.test
 */

import {
	MediaRecorderCaptureTrack,
	PcmCaptureTrack,
	type CaptureTrack,
} from 'src/recording/CaptureTrack';
import type { PcmStreamRecorder } from 'src/recording/PcmStreamRecorder';
import { partial } from '../helpers/doubles';

/** A PCM recorder double reporting what the worklet settled on. */
function makePcmRecorder(
	overrides: Partial<PcmStreamRecorder> = {},
): PcmStreamRecorder {
	return partial<PcmStreamRecorder>({
		channels: 2,
		sampleRate: 48000,
		start: jest.fn(() => Promise.resolve()),
		pause: jest.fn(),
		resume: jest.fn(),
		stop: jest.fn(() => Promise.resolve()),
		...overrides,
	});
}

describe('a PCM capture track', () => {
	it('reports what the worklet negotiated, so the WAV header can describe it', () => {
		const track = new PcmCaptureTrack(makePcmRecorder());

		expect(track.negotiatedChannels).toBe(2);
		expect(track.negotiatedSampleRate).toBe(48000);
	});

	it.each([
		// Every row answers with a promise so the table drives the two
		// asynchronous operations and the two synchronous ones alike.
		{
			name: 'start',
			drive: async (t: CaptureTrack): Promise<void> => {
				await t.start();
			},
		},
		{
			name: 'pause',
			drive: async (t: CaptureTrack): Promise<void> => {
				t.pause();
			},
		},
		{
			name: 'resume',
			drive: async (t: CaptureTrack): Promise<void> => {
				t.resume();
			},
		},
		{
			name: 'stop',
			drive: async (t: CaptureTrack): Promise<void> => {
				await t.stop();
			},
		},
	])('passes $name straight to the recorder', async ({ name, drive }) => {
		const recorder = makePcmRecorder();
		const track = new PcmCaptureTrack(recorder);

		await drive(track);

		expect(recorder[name as 'pause']).toHaveBeenCalledTimes(1);
	});

	it('does nothing on a restart, because it rotates by counting bytes', () => {
		const recorder = makePcmRecorder();
		// Through the interface, which is how a session ever calls it: the
		// class itself declares no parameter because it has no use for one.
		const track: CaptureTrack = new PcmCaptureTrack(recorder);

		track.restart(false);

		expect(recorder.start).not.toHaveBeenCalled();
		expect(recorder.stop).not.toHaveBeenCalled();
	});

	it('does nothing when the device goes, because the worklet stops being fed', () => {
		const recorder = makePcmRecorder();
		const track = new PcmCaptureTrack(recorder);

		track.detachFromDevice();

		expect(recorder.stop).not.toHaveBeenCalled();
	});

	it('releases by stopping, and reports a refusal rather than throwing', async () => {
		const error = new Error('worklet stuck');
		const recorder = makePcmRecorder({
			stop: jest.fn(() => Promise.reject(error)),
		});
		const consoleError = jest
			.spyOn(console, 'error')
			.mockImplementation(() => undefined);
		const track = new PcmCaptureTrack(recorder);

		track.release('on unload');
		await Promise.resolve();

		expect(consoleError).toHaveBeenCalledWith(
			expect.stringContaining('on unload'),
			error,
		);
	});
});

/** A browser track over a stream nothing has started, as a failed start leaves it. */
function makeBrowserTrack(): MediaRecorderCaptureTrack {
	return new MediaRecorderCaptureTrack(
		partial<MediaStream>({}),
		'source',
		48000,
		{ mimeType: 'audio/webm', bitrate: 128000 },
		{ onChunk: jest.fn(), onError: jest.fn() },
	);
}

describe('a browser capture track', () => {
	it('negotiates nothing, because a recorder encodes what the stream carries', () => {
		const track = makeBrowserTrack();

		expect(track.negotiatedChannels).toBeNull();
		expect(track.negotiatedSampleRate).toBeNull();
	});

	it.each([
		{ name: 'pause', drive: (t: CaptureTrack): void => t.pause() },
		{ name: 'resume', drive: (t: CaptureTrack): void => t.resume() },
	])('answers $name before it has a recorder at all', ({ drive }) => {
		const track = makeBrowserTrack();

		expect(() => {
			drive(track);
		}).not.toThrow();
	});

	it('stops instantly when there is no recorder to wait for', async () => {
		const track = makeBrowserTrack();

		await expect(track.stop()).resolves.toBeUndefined();
	});

	it('releases without a recorder and without a bridge', () => {
		const track = makeBrowserTrack();

		expect(() => {
			track.release('after start failure');
		}).not.toThrow();
	});
});
