/**
 * Unit tests for AudioStreamHandler utilities.
 * @module tests/unit/AudioStreamHandler.test
 */

import {
	channelSelectionAvailable,
	deviceMaxChannels,
	getAudioInputDeviceSnapshot,
	getAudioStreams,
	getAudioSourceName,
	getOrderedTrackSources,
	isMultiTrackSessionEnabled,
	resolveCaptureDeviceId,
	validateSelectedDevices,
} from 'src/recording/AudioStreamHandler';
import { AudioStreamError } from 'src/errors';
import { DEFAULT_SETTINGS } from 'src/settings/settingsSchema';
import type { AudioRecorderSettings } from 'src/settings/settingsSchema';
import { setPlatform, useDesktopPlatform } from '../helpers/platform';
import { partial } from '../helpers/doubles';

/** Builds a MediaStream stub whose tracks record stop() calls. */
function fakeStream(): { stream: MediaStream; stop: jest.Mock } {
	const stop = jest.fn();
	const stream = partial<MediaStream>({
		getTracks: () => [{ stop }],
	});
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
			const settings: AudioRecorderSettings = {
				...multiTrackSettings,
				maxTracks: 1,
				trackAudioSources: new Map([
					[
						1,
						{
							deviceId: 'device-before',
							channelMode: 'mono-left',
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

	describe('opening a microphone that is busy', () => {
		const originalMediaDevices = navigator.mediaDevices;
		let getUserMedia: jest.Mock;

		beforeEach(() => {
			jest.useFakeTimers();
			getUserMedia = jest.fn();
			Object.defineProperty(navigator, 'mediaDevices', {
				value: { getUserMedia },
				configurable: true,
			});
		});

		afterEach(() => {
			jest.useRealTimers();
			Object.defineProperty(navigator, 'mediaDevices', {
				value: originalMediaDevices,
				configurable: true,
			});
		});

		/** Runs an acquisition, letting every retry delay elapse. */
		async function acquire(
			settings: AudioRecorderSettings,
		): Promise<{ streams: MediaStream[] } | Error> {
			const pending = getAudioStreams(settings).catch(
				(error: unknown) => error as Error,
			);
			await jest.advanceTimersByTimeAsync(2000);
			return await pending;
		}

		it.each([
			{ name: 'the request was interrupted', errorName: 'AbortError' },
			{
				name: 'the device was momentarily busy',
				errorName: 'NotReadableError',
			},
		])('retries when $name', async ({ errorName }) => {
			// Another app releasing the microphone a moment later is the
			// common case; failing the recording outright would be wrong.
			const debug = jest
				.spyOn(console, 'debug')
				.mockImplementation(() => undefined);
			getUserMedia
				.mockRejectedValueOnce(new DOMException('busy', errorName))
				.mockResolvedValueOnce(fakeStream().stream);

			const result = await acquire(DEFAULT_SETTINGS);

			expect(getUserMedia).toHaveBeenCalledTimes(2);
			expect(result).not.toBeInstanceOf(Error);
			debug.mockRestore();
		});

		it('gives up after the last retry, naming the device', async () => {
			const debug = jest
				.spyOn(console, 'debug')
				.mockImplementation(() => undefined);
			getUserMedia.mockRejectedValue(
				new DOMException('busy', 'NotReadableError'),
			);

			const result = await acquire({
				...DEFAULT_SETTINGS,
				audioDeviceId: 'busy-mic',
			});

			// Two retries after the first attempt, then the failure stands.
			expect(getUserMedia).toHaveBeenCalledTimes(3);
			expect(result).toBeInstanceOf(AudioStreamError);
			debug.mockRestore();
		});

		it('does not retry a refused permission', async () => {
			// The user said no; asking twice more only repeats the prompt.
			getUserMedia.mockRejectedValue(
				new DOMException('denied', 'NotAllowedError'),
			);

			const result = await acquire(DEFAULT_SETTINGS);

			expect(getUserMedia).toHaveBeenCalledTimes(1);
			expect(result).toBeInstanceOf(AudioStreamError);
		});

		it('reports a failure that is not an Error at all', async () => {
			getUserMedia.mockRejectedValue('the device exploded');

			const result = await acquire(DEFAULT_SETTINGS);

			expect(result).toBeInstanceOf(AudioStreamError);
			expect((result as AudioStreamError).message).toContain(
				'the device exploded',
			);
		});
	});

	describe('getOrderedTrackSources', () => {
		it('returns sources in track order regardless of Map insertion order', () => {
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

		it('lists nothing while multi-track is off', () => {
			// The stored per-track devices survive the switch being turned
			// off, and acting on them would open microphones nobody asked
			// this session to open.
			expect(
				getOrderedTrackSources({
					...DEFAULT_SETTINGS,
					enableMultiTrack: false,
					maxTracks: 2,
					trackAudioSources: new Map([
						[
							1,
							{
								deviceId: 'device-1',
								channelMode: 'source' as const,
							},
						],
					]),
				}),
			).toEqual([]);
		});

		it('skips tracks without selected devices', () => {
			const settings: AudioRecorderSettings = {
				...DEFAULT_SETTINGS,
				enableMultiTrack: true,
				maxTracks: 3,
				trackAudioSources: new Map([
					[1, { deviceId: 'device-1', channelMode: 'source' }],
					[3, { deviceId: '', channelMode: 'source' }],
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

	describe('platform gating of devices and multi-track', () => {
		const originalMediaDevices = navigator.mediaDevices;
		let getUserMedia: jest.Mock;
		let enumerateDevices: jest.Mock;

		const multiTrackSettings = {
			...DEFAULT_SETTINGS,
			enableMultiTrack: true,
			maxTracks: 2,
			audioDeviceId: 'configured-mic',
			trackAudioSources: new Map([
				[1, { deviceId: 'device-1', channelMode: 'source' as const }],
				[2, { deviceId: 'device-2', channelMode: 'source' as const }],
			]),
		};

		beforeEach(() => {
			getUserMedia = jest.fn().mockResolvedValue(fakeStream().stream);
			enumerateDevices = jest.fn().mockResolvedValue([]);
			Object.defineProperty(navigator, 'mediaDevices', {
				value: { getUserMedia, enumerateDevices },
				configurable: true,
			});
		});

		afterEach(() => {
			useDesktopPlatform();
			Object.defineProperty(navigator, 'mediaDevices', {
				value: originalMediaDevices,
				configurable: true,
			});
		});

		describe.each([
			{
				platform: 'desktop',
				mobile: false,
				multiTrack: true,
				device: 'configured-mic',
			},
			{
				platform: 'mobile',
				mobile: true,
				multiTrack: false,
				device: undefined,
			},
		])(
			'a config with multi-track and a device, read on $platform',
			({ mobile, multiTrack, device }) => {
				// The same stored config syncs to both, so each reading has to
				// come from the platform rather than from what was saved.
				beforeEach(() => {
					setPlatform({ isMobile: mobile });
				});

				it(`treats multi-track as ${String(multiTrack)}`, () => {
					expect(isMultiTrackSessionEnabled(multiTrackSettings)).toBe(
						multiTrack,
					);
				});

				it('resolves the capture device the platform can use', () => {
					// Device ids are randomized per install, so a synced
					// desktop id could never satisfy an exact-match
					// constraint on the phone.
					expect(resolveCaptureDeviceId(multiTrackSettings)).toBe(
						device,
					);
				});
			},
		);

		it('leaves multi-track off and the device unset when nothing was configured', () => {
			expect(isMultiTrackSessionEnabled(DEFAULT_SETTINGS)).toBe(false);
			expect(resolveCaptureDeviceId(DEFAULT_SETTINGS)).toBeUndefined();
		});

		it('getAudioStreams opens one default-mic stream on mobile despite multi-track config', async () => {
			setPlatform({ isMobile: true });

			const { streams, trackOrder } =
				await getAudioStreams(multiTrackSettings);

			expect(streams).toHaveLength(1);
			expect(trackOrder).toEqual([]);
			expect(getUserMedia).toHaveBeenCalledTimes(1);
			const constraints = getUserMedia.mock.calls[0][0] as {
				audio: { deviceId?: unknown };
			};
			expect(constraints.audio.deviceId).toBeUndefined();
		});

		it('validateSelectedDevices rejects a missing device on desktop', async () => {
			await expect(
				validateSelectedDevices({
					...DEFAULT_SETTINGS,
					audioDeviceId: 'gone-device',
				}),
			).rejects.toThrow(/no longer available/);
			expect(enumerateDevices).toHaveBeenCalled();
		});

		it('validateSelectedDevices is a no-op on mobile', async () => {
			// A synced desktop device id must not block recording on the
			// default microphone
			setPlatform({ isMobile: true });

			await expect(
				validateSelectedDevices({
					...DEFAULT_SETTINGS,
					audioDeviceId: 'desktop-only-device',
				}),
			).resolves.toBeUndefined();
			expect(enumerateDevices).not.toHaveBeenCalled();
		});

		it('names every multi-track device that has gone missing', async () => {
			// Naming the tracks is the whole point: "a device is missing"
			// leaves the user to work out which of four to re-pick.
			enumerateDevices.mockResolvedValue([
				{ kind: 'audioinput', deviceId: 'device-1', label: 'Mic one' },
			]);

			await expect(
				validateSelectedDevices({
					...multiTrackSettings,
					maxTracks: 3,
					trackAudioSources: new Map([
						[
							1,
							{
								deviceId: 'device-1',
								channelMode: 'source' as const,
							},
						],
						[
							2,
							{
								deviceId: 'gone-a',
								channelMode: 'source' as const,
							},
						],
						[
							3,
							{
								deviceId: 'gone-b',
								channelMode: 'source' as const,
							},
						],
					]),
				}),
			).rejects.toThrow('track(s) 2, 3');
		});

		it('accepts a multi-track session whose devices are all present', async () => {
			enumerateDevices.mockResolvedValue([
				{ kind: 'audioinput', deviceId: 'device-1', label: 'Mic one' },
				{ kind: 'audioinput', deviceId: 'device-2', label: 'Mic two' },
			]);

			await expect(
				validateSelectedDevices(multiTrackSettings),
			).resolves.toBeUndefined();
		});

		it('accepts a single-track session recording from the default mic', async () => {
			await expect(
				validateSelectedDevices({
					...DEFAULT_SETTINGS,
					audioDeviceId: '',
				}),
			).resolves.toBeUndefined();
		});
	});

	describe('naming a device for the filename', () => {
		const originalMediaDevices = navigator.mediaDevices;
		let enumerateDevices: jest.Mock;

		beforeEach(() => {
			enumerateDevices = jest.fn().mockResolvedValue([]);
			Object.defineProperty(navigator, 'mediaDevices', {
				value: { enumerateDevices },
				configurable: true,
			});
		});

		afterEach(() => {
			Object.defineProperty(navigator, 'mediaDevices', {
				value: originalMediaDevices,
				configurable: true,
			});
		});

		it.each([
			{
				name: 'strips what a filename cannot carry',
				label: 'Blue Yeti (USB-2)',
				expected: 'BlueYetiUSB2',
			},
			{
				name: 'falls back to the id when the label is only punctuation',
				label: '- ()',
				expected: 'Devicedevice-1',
			},
			{
				name: 'falls back to the id when the label is empty',
				label: '',
				expected: 'Devicedevice-1',
			},
		])('$name', async ({ label, expected }) => {
			// The name goes into a track's filename, so a slash or a colon
			// would produce a path the vault cannot write.
			enumerateDevices.mockResolvedValue([
				{ kind: 'audioinput', deviceId: 'device-1', label },
			]);

			await expect(getAudioSourceName('device-1')).resolves.toBe(
				expected,
			);
		});

		it('says the device is unknown when it is not there any more', async () => {
			await expect(getAudioSourceName('unplugged')).resolves.toBe(
				'UnknownDevice',
			);
		});

		it('shortens a long device id in the fallback name', async () => {
			enumerateDevices.mockResolvedValue([
				{
					kind: 'audioinput',
					deviceId: 'abcdefghijklmnopqrstuvwxyz',
					label: '###',
				},
			]);

			await expect(
				getAudioSourceName('abcdefghijklmnopqrstuvwxyz'),
			).resolves.toBe('Deviceabcdefgh');
		});
	});
});
