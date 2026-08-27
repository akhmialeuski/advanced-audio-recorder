/**
 * Device selection modal for choosing audio input devices.
 * @module ui/DeviceSelectionModal
 */

import { Notice } from 'obsidian';
import type { App } from 'obsidian';
import { PLUGIN_LOG_PREFIX } from '../constants';
import { getAudioInputDevices } from '../recording/AudioStreamHandler';
import { PluginModal } from './PluginModal';

/**
 * Callback type for when a device is selected.
 */
export type DeviceSelectedCallback = (
	deviceId: string,
	deviceLabel: string,
) => Promise<void>;

/**
 * Modal for selecting an audio input device.
 */
export class DeviceSelectionModal extends PluginModal {
	private devices: MediaDeviceInfo[];
	private onDeviceSelected: DeviceSelectedCallback;

	/**
	 * Creates a new DeviceSelectionModal.
	 * @param app - The Obsidian App instance
	 * @param devices - Array of available audio input devices
	 * @param onDeviceSelected - Callback when device is selected
	 */
	constructor(
		app: App,
		devices: MediaDeviceInfo[],
		onDeviceSelected: DeviceSelectedCallback,
	) {
		super(app);
		this.devices = devices;
		this.onDeviceSelected = onDeviceSelected;
	}

	/**
	 * Called when the modal is opened.
	 */
	override onOpen(): void {
		const { contentEl } = this;

		this.setDialogTitle('Select audio input device');

		const dropdown = contentEl.createEl('select');
		dropdown.addClass('audio-device-dropdown');

		for (const device of this.devices) {
			const option = dropdown.createEl('option');
			option.value = device.deviceId;
			option.text =
				device.label || `Device ${device.deviceId.substring(0, 8)}`;
		}

		this.renderActions({
			text: 'Select',
			cta: true,
			onClick: async () => {
				const selectedDeviceId = dropdown.value;
				const selectedOption = dropdown.selectedOptions[0];
				const selectedLabel = selectedOption?.text ?? 'Unknown device';
				await this.onDeviceSelected(selectedDeviceId, selectedLabel);
				new Notice(`Selected audio device: ${selectedLabel}`);
				this.close();
			},
		});
	}
}

/**
 * Shows the device selection modal if devices are available.
 * @param app - The Obsidian App instance
 * @param onDeviceSelected - Callback when device is selected
 */
export async function showDeviceSelectionModal(
	app: App,
	onDeviceSelected: DeviceSelectedCallback,
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

	new DeviceSelectionModal(app, audioDevices, onDeviceSelected).open();
}
