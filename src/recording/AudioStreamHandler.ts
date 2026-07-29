/**
 * Audio stream handler for managing MediaStream and device enumeration.
 * @module recording/AudioStreamHandler
 */

import { PLUGIN_LOG_PREFIX } from '../constants';
import { AudioStreamError } from '../errors';
import { delay } from '../utils/TimeUtils';
import type { AudioRecorderSettings } from '../settings/settingsSchema';
import { normalizeChannelMode, type ChannelMode } from '../audio/downmix';
import {
	isDeviceSelectionSupported,
	isMultiTrackCaptureSupported,
} from '../platform/capabilities';

export interface TrackAudioSource {
	trackNumber: number;
	deviceId: string;
	/** Channel mode captured atomically with the selected device. */
	channelMode: ChannelMode;
}

/**
 * One coherent view of the currently enumerated audio inputs and their
 * reported channel limits. `enumerationSucceeded` distinguishes a selected
 * device that is genuinely absent from a platform that could not enumerate
 * devices at all.
 */
export interface AudioInputDeviceSnapshot {
	readonly enumerationSucceeded: boolean;
	readonly devices: readonly MediaDeviceInfo[];
	readonly channelLimits: ReadonlyMap<string, number | null>;
}

/**
 * Gets all available audio input devices.
 * @returns Promise resolving to array of audio input devices
 */
export async function getAudioInputDevices(): Promise<MediaDeviceInfo[]> {
	const devices = await navigator.mediaDevices.enumerateDevices();
	return devices.filter((device) => device.kind === 'audioinput');
}

/**
 * Maximum capture channel count a device reports, or null when the
 * platform does not expose it. Read from InputDeviceInfo capabilities
 * (available on already-enumerated devices once microphone permission
 * exists), so no stream is opened. Exported for the settings UI, which
 * greys out the channel selectors for known-mono devices.
 * @param device - Enumerated device, or undefined when not found
 * @returns Maximum channels, or null when unknown
 */
export function deviceMaxChannels(
	device: MediaDeviceInfo | undefined,
): number | null {
	if (!device || !('getCapabilities' in device)) {
		return null;
	}
	try {
		const capabilities = (device as InputDeviceInfo).getCapabilities();
		const channelCount = capabilities.channelCount;
		if (typeof channelCount === 'number' && channelCount > 0) {
			return channelCount;
		}
		if (
			channelCount &&
			typeof channelCount === 'object' &&
			typeof channelCount.max === 'number' &&
			channelCount.max > 0
		) {
			return channelCount.max;
		}
		return null;
	} catch {
		// Some engines throw for devices without granted permission
		return null;
	}
}

/**
 * Enumerates audio inputs once and derives every channel limit from that
 * exact device list. The explicit success flag lets consumers distinguish
 * an unplugged device from an enumeration failure.
 * @returns Coherent device/capability snapshot
 */
export async function getAudioInputDeviceSnapshot(): Promise<AudioInputDeviceSnapshot> {
	const limits = new Map<string, number | null>();
	try {
		const devices = await getAudioInputDevices();
		for (const device of devices) {
			limits.set(device.deviceId, deviceMaxChannels(device));
		}
		return {
			enumerationSucceeded: true,
			devices,
			channelLimits: limits,
		};
	} catch {
		return {
			enumerationSucceeded: false,
			devices: [],
			channelLimits: limits,
		};
	}
}

/**
 * Whether the mono channel options make sense for a device: true for
 * known multichannel devices and for unknown capability (disabling on
 * unknown would block the feature exactly on the platforms that need
 * it most). Only a device that positively reports a single capture
 * channel loses the selection - every mono mode would be an identity
 * or a fallback there.
 * @param maxChannels - Maximum channels, or null when unknown
 */
export function channelSelectionAvailable(
	maxChannels: number | null | undefined,
): boolean {
	return maxChannels === null || maxChannels === undefined || maxChannels > 1;
}

/**
 * Maximum number of retry attempts for temporary errors.
 */
const MAX_RETRIES = 2;

/**
 * Delay between retry attempts in milliseconds.
 */
const RETRY_DELAY_MS = 500;

/**
 * Browser audio-processing constraints applied to the input stream.
 */
export interface AudioProcessingConstraints {
	noiseSuppression: boolean;
	echoCancellation: boolean;
	autoGainControl: boolean;
}

/**
 * Reads the audio-processing constraints from settings.
 * @param settings - Plugin settings
 */
export function getProcessingConstraints(
	settings: AudioRecorderSettings,
): AudioProcessingConstraints {
	return {
		noiseSuppression: settings.inputNoiseSuppression,
		echoCancellation: settings.inputEchoCancellation,
		autoGainControl: settings.inputAutoGainControl,
	};
}

/**
 * Gets a MediaStream for the specified audio device.
 * Implements retry logic for temporary access errors.
 * @param deviceId - Optional device ID to use
 * @param sampleRate - Audio sample rate
 * @param processing - Optional audio-processing constraints
 * @returns Promise resolving to MediaStream
 * @throws AudioStreamError if device access fails after all retries
 */
async function getAudioStream(
	deviceId?: string,
	sampleRate?: number,
	processing?: AudioProcessingConstraints,
): Promise<MediaStream> {
	let lastError: Error | null = null;

	for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
		try {
			return await navigator.mediaDevices.getUserMedia({
				audio: {
					...(deviceId ? { deviceId: { exact: deviceId } } : {}),
					...(sampleRate === undefined ? {} : { sampleRate }),
					...(processing
						? {
								noiseSuppression: processing.noiseSuppression,
								echoCancellation: processing.echoCancellation,
								autoGainControl: processing.autoGainControl,
							}
						: {}),
				},
			});
		} catch (error) {
			lastError =
				error instanceof Error ? error : new Error(String(error));

			// Retry only for temporary errors (AbortError indicates interrupted request)
			const isRetryable =
				error instanceof DOMException &&
				(error.name === 'AbortError' ||
					error.name === 'NotReadableError');

			if (isRetryable && attempt < MAX_RETRIES) {
				console.debug(
					`${PLUGIN_LOG_PREFIX} Retry ${String(attempt + 1)}/${String(MAX_RETRIES)} for device access`,
				);
				await delay(RETRY_DELAY_MS);
				continue;
			}

			throw new AudioStreamError(lastError, deviceId);
		}
	}

	throw new AudioStreamError(
		lastError ?? new Error('Max retries exceeded'),
		deviceId,
	);
}

/**
 * Whether the current session records multiple tracks: the setting must
 * be on AND the platform must support multi-device capture. A stored
 * "on" synced from a desktop config silently degrades to a single-track
 * session where multi-track capture is unavailable (mobile).
 * @param settings - Plugin settings
 * @returns True when a multi-track session should be started
 */
export function isMultiTrackSessionEnabled(
	settings: AudioRecorderSettings,
): boolean {
	return settings.enableMultiTrack && isMultiTrackCaptureSupported();
}

/**
 * The device id capture should request for a single-track session, or
 * undefined for the system default microphone. Stored device ids are
 * ignored where device selection is unavailable (mobile): ids are
 * randomized per install, so a configured id could never be satisfied
 * with an `exact` constraint there.
 * @param settings - Plugin settings
 * @returns Device id to request, or undefined for the default device
 */
export function resolveCaptureDeviceId(
	settings: AudioRecorderSettings,
): string | undefined {
	if (!isDeviceSelectionSupported()) {
		return undefined;
	}
	return settings.audioDeviceId || undefined;
}

/**
 * Gets audio streams based on settings configuration.
 * @param settings - Plugin settings
 * @returns Promise resolving to array of MediaStreams
 */
export async function getAudioStreams(
	settings: AudioRecorderSettings,
): Promise<{ streams: MediaStream[]; trackOrder: TrackAudioSource[] }> {
	const processing = getProcessingConstraints(settings);
	if (isMultiTrackSessionEnabled(settings)) {
		const trackOrder = getOrderedTrackSources(settings);
		const streamPromises = trackOrder.map((source) =>
			getAudioStream(source.deviceId, settings.sampleRate, processing),
		);
		// Settle every request before failing: with Promise.all a single
		// rejected track would abandon the microphones that already opened,
		// leaving them captured (device locked, indicator on) until app
		// restart, because the caller never receives them to stop.
		const results = await Promise.allSettled(streamPromises);
		const opened = results
			.filter(
				(result): result is PromiseFulfilledResult<MediaStream> =>
					result.status === 'fulfilled',
			)
			.map((result) => result.value);
		const failed = results.find(
			(result): result is PromiseRejectedResult =>
				result.status === 'rejected',
		);
		if (failed) {
			stopAllStreams(opened);
			throw failed.reason;
		}
		return { streams: opened, trackOrder };
	}
	const stream = await getAudioStream(
		resolveCaptureDeviceId(settings),
		settings.sampleRate,
		processing,
	);
	return { streams: [stream], trackOrder: [] };
}

/**
 * Gets ordered track audio sources based on settings.
 */
export function getOrderedTrackSources(
	settings: AudioRecorderSettings,
): TrackAudioSource[] {
	const sources: TrackAudioSource[] = [];
	if (!settings.enableMultiTrack) {
		return sources;
	}
	for (let i = 1; i <= settings.maxTracks; i++) {
		const source = settings.trackAudioSources.get(i);
		if (source?.deviceId) {
			sources.push({
				trackNumber: i,
				deviceId: source.deviceId,
				channelMode: normalizeChannelMode(source.channelMode),
			});
		}
	}
	return sources;
}

/**
 * Validates that selected audio devices are still available. A no-op
 * where device selection is unavailable (mobile): stored ids are not
 * used for capture there (see {@link resolveCaptureDeviceId}), so their
 * absence - e.g. desktop ids arriving through a synced data.json - must
 * not block recording on the default microphone.
 */
export async function validateSelectedDevices(
	settings: AudioRecorderSettings,
): Promise<void> {
	if (!isDeviceSelectionSupported()) {
		return;
	}
	const devices = await getAudioInputDevices();
	const availableDeviceIds = new Set(
		devices.map((device) => device.deviceId),
	);

	if (isMultiTrackSessionEnabled(settings)) {
		const missingTracks = getOrderedTrackSources(settings)
			.filter((source) => !availableDeviceIds.has(source.deviceId))
			.map((source) => source.trackNumber);
		if (missingTracks.length > 0) {
			throw new Error(
				`Selected audio device(s) for track(s) ${missingTracks.join(', ')} are no longer available.`,
			);
		}
		return;
	}

	if (
		settings.audioDeviceId &&
		!availableDeviceIds.has(settings.audioDeviceId)
	) {
		throw new Error(
			'Selected audio input device is no longer available. Please choose another device in settings.',
		);
	}
}

/**
 * Gets the display name for an audio device.
 * @param deviceId - Device ID to look up
 * @returns Promise resolving to device label or fallback name
 */
export async function getAudioSourceName(deviceId: string): Promise<string> {
	const devices = await getAudioInputDevices();
	const device = devices.find((d) => d.deviceId === deviceId);
	if (!device) {
		return 'UnknownDevice';
	}
	const label = device.label.replace(/[^a-zA-Z0-9]/g, '');
	return label || `Device${deviceId.substring(0, 8)}`;
}

/**
 * Stops all tracks in the given MediaStreams.
 * @param streams - Array of MediaStreams to stop
 */
export function stopAllStreams(streams: MediaStream[]): void {
	for (const stream of streams) {
		for (const track of stream.getTracks()) {
			track.stop();
		}
	}
}
