/**
 * Device selection modal for choosing audio input devices.
 * @module ui/DeviceSelectionModal
 */

import { Notice } from 'obsidian';
import type { App } from 'obsidian';
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
	const devices = await navigator.mediaDevices.enumerateDevices();
	const audioDevices = devices.filter(
		(device) => device.kind === 'audioinput',
	);

	if (audioDevices.length === 0) {
		new Notice('No audio input devices found');
		return;
	}

	new DeviceSelectionModal(app, audioDevices, onDeviceSelected).open();
}
