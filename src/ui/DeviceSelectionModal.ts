/**
 * The picker the "Select audio input device" command opens: a quick-pick
 * list of the detected inputs, the way Obsidian asks for one of several
 * things, with the input in use marked.
 * @module ui/DeviceSelectionModal
 */

import { Notice } from 'obsidian';
import type { App } from 'obsidian';
import { PLUGIN_LOG_PREFIX } from '../constants';
import { errorMessage } from '../errors';
import {
	deviceOptionLabel,
	getAudioInputDevices,
} from '../recording/AudioStreamHandler';
import { ActionTargetModal } from './ActionTargetModal';

/**
 * Callback type for when a device is selected.
 */
export type DeviceSelectedCallback = (
	deviceId: string,
	deviceLabel: string,
) => Promise<void>;

/** What the picker's search field says before anything is typed. */
const DEVICE_PICKER_PLACEHOLDER = 'Choose the input to record from';

/**
 * Hands the chosen input to the caller and says which one is now in use,
 * or why it could not be stored.
 * @param device - The input chosen
 * @param onDeviceSelected - Stores the choice
 */
async function selectDevice(
	device: MediaDeviceInfo,
	onDeviceSelected: DeviceSelectedCallback,
): Promise<void> {
	const label = deviceOptionLabel(device);
	try {
		await onDeviceSelected(device.deviceId, label);
	} catch (error) {
		console.error(
			`${PLUGIN_LOG_PREFIX} Could not select audio device:`,
			error,
		);
		new Notice(errorMessage(error));
		return;
	}
	new Notice(`Selected audio device: ${label}`);
}

/**
 * Shows the device picker if devices are available.
 * @param app - The Obsidian App instance
 * @param onDeviceSelected - Callback when device is selected
 * @param currentDeviceId - The input recordings use now, marked in the list
 */
export async function showDeviceSelectionModal(
	app: App,
	onDeviceSelected: DeviceSelectedCallback,
	currentDeviceId: string,
): Promise<void> {
	let audioDevices: MediaDeviceInfo[];
	try {
		audioDevices = await getAudioInputDevices();
	} catch (error) {
		// Enumeration is refused when microphone access is blocked, and it is
		// unavailable outside a secure context, where the shared reader says
		// so rather than reading through a device API that is not there. The
		// caller has no way to report either: this function is the whole of
		// what the user sees after asking to pick a device.
		console.error(
			`${PLUGIN_LOG_PREFIX} Could not list audio input devices:`,
			error,
		);
		new Notice('Could not list audio input devices');
		return;
	}

	if (audioDevices.length === 0) {
		new Notice('No audio input devices found');
		return;
	}

	new ActionTargetModal(
		app,
		audioDevices,
		(device) =>
			device.deviceId === currentDeviceId
				? `${deviceOptionLabel(device)} (current)`
				: deviceOptionLabel(device),
		(device) => {
			void selectDevice(device, onDeviceSelected);
		},
		DEVICE_PICKER_PLACEHOLDER,
	).open();
}
