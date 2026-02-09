/**
 * Audio stream handler for managing MediaStream and device enumeration.
 * @module recording/AudioStreamHandler
 */

import type { AudioRecorderSettings } from '../settings/Settings';

/**
 * Gets all available audio input devices.
 * @returns Promise resolving to array of audio input devices
 */
export async function getAudioInputDevices(): Promise<MediaDeviceInfo[]> {
	const devices = await navigator.mediaDevices.enumerateDevices();
	return devices.filter((device) => device.kind === 'audioinput');
}

/**
 * Error thrown when audio stream acquisition fails.
 */
export class AudioStreamError extends Error {
	constructor(
		public readonly originalError: Error,
		public readonly deviceId?: string,
	) {
		const message = deviceId
			? `[Advanced Audio Recorder] Failed to access audio device "${deviceId}". ` +
				`The device may be disconnected, in use by another application, or its ID may have changed. ` +
				`Please verify the device in plugin settings. Original error: ${originalError.message}`
			: `[Advanced Audio Recorder] Failed to access audio device. ` +
				`Original error: ${originalError.message}`;
		super(message);
		this.name = 'AudioStreamError';
	}
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
 * Delays execution for specified milliseconds.
 */
function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Gets a MediaStream for the specified audio device.
 * Implements retry logic for temporary access errors.
 * @param deviceId - Optional device ID to use
 * @param sampleRate - Audio sample rate
 * @returns Promise resolving to MediaStream
 * @throws AudioStreamError if device access fails after all retries
 */
export async function getAudioStream(
	deviceId?: string,
	sampleRate?: number,
): Promise<MediaStream> {
	let lastError: Error | null = null;

	for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
		try {
			return await navigator.mediaDevices.getUserMedia({
				audio: {
					deviceId: deviceId ? { exact: deviceId } : undefined,
					sampleRate: sampleRate,
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
					`[AudioRecorder] Retry ${String(attempt + 1)}/${String(MAX_RETRIES)} for device access`,
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
): Promise<MediaStream[]> {
	if (settings.enableMultiTrack) {
		const deviceIds: string[] = [];
		for (const key of Object.keys(settings.trackAudioSources)) {
			const trackNum = parseInt(key, 10);
			const deviceId = settings.trackAudioSources[trackNum];
			if (deviceId) {
				deviceIds.push(deviceId);
			}
		}
		const streamPromises = deviceIds.map((deviceId: string) =>
			getAudioStream(deviceId, settings.sampleRate),
		);
		return Promise.all(streamPromises);
	}
	const stream = await getAudioStream(
		settings.audioDeviceId,
		settings.sampleRate,
	);
	return [stream];
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
