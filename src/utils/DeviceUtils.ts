/**
 * Utility functions for audio device management.
 * @module utils/DeviceUtils
 */

/**
 * Gets all available audio input devices.
 * @returns Array of audio input devices
 */
export async function getAudioInputDevices(): Promise<MediaDeviceInfo[]> {
	const devices = await navigator.mediaDevices.enumerateDevices();
	return devices.filter((device) => device.kind === 'audioinput');
}

/**
 * Finds the default audio input device from a list of devices.
 * The default device typically has deviceId 'default'.
 * @param devices - Array of audio input devices
 * @returns The default device, or undefined if not found
 */
export function findDefaultDevice(
	devices: MediaDeviceInfo[],
): MediaDeviceInfo | undefined {
	return devices.find((device) => device.deviceId === 'default');
}

/**
 * Gets the default audio input device ID.
 * Requests microphone permission if needed to get device labels.
 * @returns The default device ID, or empty string if not available
 */
export async function getDefaultDeviceId(): Promise<string> {
	let stream: MediaStream | null = null;
	try {
		// Request permission to ensure device labels are available
		stream = await navigator.mediaDevices.getUserMedia({ audio: true });

		const devices = await getAudioInputDevices();
		const defaultDevice = findDefaultDevice(devices);

		return defaultDevice?.deviceId ?? '';
	} catch {
		// Permission denied or no devices available
		return '';
	} finally {
		// Clean up the stream to release microphone
		if (stream) {
			stream.getTracks().forEach((track) => track.stop());
		}
	}
}
