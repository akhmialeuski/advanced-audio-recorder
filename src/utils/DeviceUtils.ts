/**
 * Picking the system default microphone at settings load, which is the one
 * device question asked before any recording surface exists.
 *
 * Reading the device list is not this module's job and never was: it is
 * `AudioStreamHandler`'s, which owns `audioDeviceApi` and the one guard that
 * answers whether this environment lists devices at all. A second copy of the
 * enumeration lived here and asked `navigator.mediaDevices` without that
 * guard, so the rule held in one module and not in the other.
 * @module utils/DeviceUtils
 */

import {
	audioDeviceApi,
	getAudioInputDevices,
} from '../recording/AudioStreamHandler';

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
	const api = audioDeviceApi();
	if (!api) {
		return '';
	}
	let stream: MediaStream | null = null;
	try {
		// Request permission to ensure device labels are available
		stream = await api.getUserMedia({ audio: true });

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
