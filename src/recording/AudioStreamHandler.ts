/**
 * Audio stream handler for managing MediaStream and device enumeration.
 * @module recording/AudioStreamHandler
 */

import { PLUGIN_LOG_PREFIX } from '../constants';
import { AudioStreamError } from '../errors';
import { delay } from '../utils/TimeUtils';
import type { AudioRecorderSettings } from '../settings/Settings';

export interface TrackAudioSource {
	trackNumber: number;
	deviceId: string;
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
export async function getAudioStream(
	deviceId?: string,
	sampleRate?: number,
	processing?: AudioProcessingConstraints,
): Promise<MediaStream> {
	let lastError: Error | null = null;

	for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
		try {
			return await navigator.mediaDevices.getUserMedia({
				audio: {
					deviceId: deviceId ? { exact: deviceId } : undefined,
					sampleRate: sampleRate,
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
 * Gets audio streams based on settings configuration.
 * @param settings - Plugin settings
 * @returns Promise resolving to array of MediaStreams
 */
export async function getAudioStreams(
	settings: AudioRecorderSettings,
): Promise<{ streams: MediaStream[]; trackOrder: TrackAudioSource[] }> {
	const processing = getProcessingConstraints(settings);
	if (settings.enableMultiTrack) {
		const trackOrder = getOrderedTrackSources(settings);
		const streamPromises = trackOrder.map((source) =>
			getAudioStream(source.deviceId, settings.sampleRate, processing),
		);
		return { streams: await Promise.all(streamPromises), trackOrder };
	}
	const stream = await getAudioStream(
		settings.audioDeviceId,
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
			sources.push({ trackNumber: i, deviceId: source.deviceId });
		}
	}
	return sources;
}

/**
 * Validates that selected audio devices are still available.
 */
export async function validateSelectedDevices(
	settings: AudioRecorderSettings,
): Promise<void> {
	const devices = await getAudioInputDevices();
	const availableDeviceIds = new Set(
		devices.map((device) => device.deviceId),
	);

	if (settings.enableMultiTrack) {
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
