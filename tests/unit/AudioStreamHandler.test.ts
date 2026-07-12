/**
 * Unit tests for AudioStreamHandler utilities.
 * @module tests/unit/AudioStreamHandler.test
 */

import {
	channelSelectionAvailable,
	deviceMaxChannels,
	getAudioInputDeviceSnapshot,
	getAudioStreams,
	getOrderedTrackSources,
} from 'src/recording/AudioStreamHandler';
import { AudioStreamError } from 'src/errors';
import { DEFAULT_SETTINGS } from 'src/settings/settingsSchema';

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
				[
					1,
					{ deviceId: 'device-1', channelMode: 'mono-left' as const },
				],
				[2, { deviceId: 'device-2', channelMode: 'source' as const }],
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
			expect(result.trackOrder.map((s) => s.channelMode)).toEqual([
				'mono-left',
				'source',
			]);
			expect(first.stop).not.toHaveBeenCalled();
			expect(second.stop).not.toHaveBeenCalled();
		});

		it('snapshots each device and channel mode before acquisition awaits', async () => {
			let resolveStream: ((stream: MediaStream) => void) | undefined;
			const pendingStream = new Promise<MediaStream>((resolve) => {
				resolveStream = resolve;
			});
			getUserMedia.mockReturnValue(pendingStream);
			const settings = {
				...multiTrackSettings,
				maxTracks: 1,
				trackAudioSources: new Map([
					[
						1,
						{
							deviceId: 'device-before',
							channelMode: 'mono-left' as const,
						},
					],
				]),
			};

			const acquisition = getAudioStreams(settings);
			settings.trackAudioSources.set(1, {
				deviceId: 'device-after',
				channelMode: 'mono-right',
			});
			const stream = fakeStream().stream;
			resolveStream?.(stream);

			const result = await acquisition;
			expect(result.trackOrder).toEqual([
				{
					trackNumber: 1,
					deviceId: 'device-before',
					channelMode: 'mono-left',
				},
			]);
			expect(getUserMedia).toHaveBeenCalledWith(
				expect.objectContaining({
					audio: expect.objectContaining({
						deviceId: { exact: 'device-before' },
					}),
				}),
			);
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
					[
						2,
						{
							deviceId: 'device-2',
							channelMode: 'mono-right' as const,
						},
					],
					[
						1,
						{
							deviceId: 'device-1',
							channelMode: 'mono-left' as const,
						},
					],
					[
						3,
						{
							deviceId: 'device-3',
							channelMode: 'source' as const,
						},
					],
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
			expect(ordered.map((source) => source.channelMode)).toEqual([
				'mono-left',
				'mono-right',
				'source',
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

	describe('device channel capabilities', () => {
		function fakeInputDevice(options: {
			deviceId: string;
			channelCount?: number | { max?: number };
			throwOnCapabilities?: boolean;
			withoutCapabilities?: boolean;
		}): MediaDeviceInfo {
			const device: Record<string, unknown> = {
				deviceId: options.deviceId,
				kind: 'audioinput',
				label: options.deviceId,
				groupId: '',
			};
			if (!options.withoutCapabilities) {
				device.getCapabilities = (): { channelCount?: unknown } => {
					if (options.throwOnCapabilities) {
						throw new Error('no permission');
					}
					return options.channelCount === undefined
						? {}
						: { channelCount: options.channelCount };
				};
			}
			return device as unknown as MediaDeviceInfo;
		}

		describe('deviceMaxChannels', () => {
			it('reads the maximum of a channel-count range', () => {
				const device = fakeInputDevice({
					deviceId: 'stereo',
					channelCount: { max: 2 },
				});

				expect(deviceMaxChannels(device)).toBe(2);
			});

			it('accepts a plain numeric channel count', () => {
				const device = fakeInputDevice({
					deviceId: 'mono',
					channelCount: 1,
				});

				expect(deviceMaxChannels(device)).toBe(1);
			});

			it.each([
				[
					'a device without getCapabilities',
					fakeInputDevice({
						deviceId: 'plain',
						withoutCapabilities: true,
					}),
				],
				['empty capabilities', fakeInputDevice({ deviceId: 'empty' })],
				[
					'a range without max',
					fakeInputDevice({
						deviceId: 'openrange',
						channelCount: {},
					}),
				],
				['a missing device', undefined],
			])('returns null for %s', (_case, device) => {
				expect(deviceMaxChannels(device)).toBeNull();
			});

			it('returns null when getCapabilities throws', () => {
				const device = fakeInputDevice({
					deviceId: 'locked',
					throwOnCapabilities: true,
				});

				expect(deviceMaxChannels(device)).toBeNull();
			});
		});

		describe('channelSelectionAvailable', () => {
			it('keeps the selection for multichannel and unknown devices', () => {
				expect(channelSelectionAvailable(2)).toBe(true);
				expect(channelSelectionAvailable(6)).toBe(true);
				expect(channelSelectionAvailable(null)).toBe(true);
				expect(channelSelectionAvailable(undefined)).toBe(true);
			});

			it('removes the selection only for known-mono devices', () => {
				expect(channelSelectionAvailable(1)).toBe(false);
			});
		});

		describe('getAudioInputDeviceSnapshot', () => {
			const originalMediaDevices = navigator.mediaDevices;

			afterEach(() => {
				Object.defineProperty(navigator, 'mediaDevices', {
					value: originalMediaDevices,
					configurable: true,
				});
			});

			it('maps every audio input to its channel limit', async () => {
				Object.defineProperty(navigator, 'mediaDevices', {
					value: {
						enumerateDevices: jest.fn().mockResolvedValue([
							fakeInputDevice({
								deviceId: 'stereo',
								channelCount: { max: 2 },
							}),
							fakeInputDevice({
								deviceId: 'mono',
								channelCount: { max: 1 },
							}),
							{
								deviceId: 'camera',
								kind: 'videoinput',
							},
						]),
					},
					configurable: true,
				});

				const snapshot = await getAudioInputDeviceSnapshot();

				expect(snapshot.enumerationSucceeded).toBe(true);
				expect(
					snapshot.devices.map((device) => device.deviceId),
				).toEqual(['stereo', 'mono']);
				expect(snapshot.channelLimits.get('stereo')).toBe(2);
				expect(snapshot.channelLimits.get('mono')).toBe(1);
				expect(snapshot.channelLimits.has('camera')).toBe(false);
			});

			it('returns an empty map when enumeration fails', async () => {
				Object.defineProperty(navigator, 'mediaDevices', {
					value: {
						enumerateDevices: jest
							.fn()
							.mockRejectedValue(new Error('unavailable')),
					},
					configurable: true,
				});

				const snapshot = await getAudioInputDeviceSnapshot();

				expect(snapshot.enumerationSucceeded).toBe(false);
				expect(snapshot.devices).toEqual([]);
				expect(snapshot.channelLimits.size).toBe(0);
			});
		});
	});
});
