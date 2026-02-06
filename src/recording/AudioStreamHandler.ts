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
 * Gets a MediaStream for the specified audio device.
 * @param deviceId - Optional device ID to use
 * @param sampleRate - Audio sample rate
 * @returns Promise resolving to MediaStream
 */
export async function getAudioStream(
	deviceId?: string,
	sampleRate?: number,
): Promise<MediaStream> {
	try {
		return await navigator.mediaDevices.getUserMedia({
			audio: {
				deviceId: deviceId ? { exact: deviceId } : undefined,
				sampleRate: sampleRate,
			},
		});
	} catch (error) {
		if (
			deviceId &&
			(error instanceof OverconstrainedError ||
				(error instanceof Error &&
					(error.name === 'OverconstrainedError' ||
						error.name === 'NotFoundError')))
		) {
			console.warn(
				`[AudioStreamHandler] Failed to get audio stream for device ${deviceId}. Falling back to default device. Error: ${String(error)}`,
			);
			return navigator.mediaDevices.getUserMedia({
				audio: {
					deviceId: undefined, // Fallback to default
					sampleRate: sampleRate,
				},
			});
		}
		throw error;
	}
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
