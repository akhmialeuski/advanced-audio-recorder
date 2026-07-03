/**
 * Unit tests for AudioStreamHandler utilities.
 * @module tests/unit/AudioStreamHandler.test
 */

import {
	getAudioStreams,
	getOrderedTrackSources,
} from '../../src/recording/AudioStreamHandler';
import { AudioStreamError } from '../../src/errors';
import { DEFAULT_SETTINGS } from '../../src/settings/Settings';

/** Builds a MediaStream stub whose tracks record stop() calls. */
function fakeStream(): { stream: MediaStream; stop: jest.Mock } {
	const stop = jest.fn();
	const stream = {
		getTracks: () => [{ stop }],
	} as unknown as MediaStream;
	return { stream, stop };
}

describe('AudioStreamHandler', () => {
	describe('getAudioStreams (multi-track partial failure)', () => {
		const originalMediaDevices = navigator.mediaDevices;
		let getUserMedia: jest.Mock;

		const multiTrackSettings = {
			...DEFAULT_SETTINGS,
			enableMultiTrack: true,
			maxTracks: 2,
			trackAudioSources: new Map([
				[1, { deviceId: 'device-1' }],
				[2, { deviceId: 'device-2' }],
			]),
		};

		beforeEach(() => {
			getUserMedia = jest.fn();
			Object.defineProperty(navigator, 'mediaDevices', {
				value: { getUserMedia },
				configurable: true,
			});
		});

		afterEach(() => {
			Object.defineProperty(navigator, 'mediaDevices', {
				value: originalMediaDevices,
				configurable: true,
			});
		});

		it('returns all streams in track order when every device opens', async () => {
			const first = fakeStream();
			const second = fakeStream();
			getUserMedia
				.mockResolvedValueOnce(first.stream)
				.mockResolvedValueOnce(second.stream);

			const result = await getAudioStreams(multiTrackSettings);

			expect(result.streams).toEqual([first.stream, second.stream]);
			expect(result.trackOrder.map((s) => s.trackNumber)).toEqual([1, 2]);
			expect(first.stop).not.toHaveBeenCalled();
			expect(second.stop).not.toHaveBeenCalled();
		});

		it('stops already-opened microphones when another track fails', async () => {
			const opened = fakeStream();
			getUserMedia.mockImplementation(
				(constraints: { audio: { deviceId?: { exact: string } } }) => {
					if (constraints.audio.deviceId?.exact === 'device-1') {
						return Promise.resolve(opened.stream);
					}
					return Promise.reject(
						new DOMException('denied', 'NotAllowedError'),
					);
				},
			);

			await expect(getAudioStreams(multiTrackSettings)).rejects.toThrow(
				AudioStreamError,
			);

			// The successfully opened microphone must be released; with the
			// old Promise.all the stream never reached the caller and stayed
			// captured until app restart.
			expect(opened.stop).toHaveBeenCalledTimes(1);
		});
	});

	describe('getOrderedTrackSources', () => {
		it('should return sources in track order regardless of Map insertion order', () => {
			const settings = {
				...DEFAULT_SETTINGS,
				enableMultiTrack: true,
				maxTracks: 3,
				trackAudioSources: new Map([
					[2, { deviceId: 'device-2' }],
					[1, { deviceId: 'device-1' }],
					[3, { deviceId: 'device-3' }],
				]),
			};

			const ordered = getOrderedTrackSources(settings);

			expect(ordered.map((source) => source.trackNumber)).toEqual([
				1, 2, 3,
			]);
			expect(ordered.map((source) => source.deviceId)).toEqual([
				'device-1',
				'device-2',
				'device-3',
			]);
		});

		it('should skip tracks without selected devices', () => {
			const settings = {
				...DEFAULT_SETTINGS,
				enableMultiTrack: true,
				maxTracks: 3,
				trackAudioSources: new Map([
					[1, { deviceId: 'device-1' }],
					[3, { deviceId: '' }],
				]),
			};

			const ordered = getOrderedTrackSources(settings);

			expect(ordered.map((source) => source.trackNumber)).toEqual([1]);
		});
	});
});
