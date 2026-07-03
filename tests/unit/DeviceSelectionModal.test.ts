/**
 * Unit tests for DeviceSelectionModal: renders the device dropdown from
 * the real modal DOM, invokes the selection callback with the chosen
 * device, and confirms/closes after the callback settles. Also covers
 * showDeviceSelectionModal's audio-input filtering and empty-list notice.
 * @module tests/unit/DeviceSelectionModal.test
 */

import { App, Notice } from 'obsidian';
import {
	DeviceSelectionModal,
	showDeviceSelectionModal,
} from 'src/ui/DeviceSelectionModal';

function makeDevice(
	deviceId: string,
	label: string,
	kind: MediaDeviceKind = 'audioinput',
): MediaDeviceInfo {
	return { deviceId, label, kind, groupId: 'g' } as MediaDeviceInfo;
}

function openModal(
	devices: MediaDeviceInfo[],
	onSelected: jest.Mock = jest.fn().mockResolvedValue(undefined),
): { modal: DeviceSelectionModal; onSelected: jest.Mock } {
	const modal = new DeviceSelectionModal(new App(), devices, onSelected);
	modal.onOpen();
	return { modal, onSelected };
}

function dropdownOf(modal: DeviceSelectionModal): HTMLSelectElement {
	const dropdown = modal.contentEl.querySelector('select');
	if (!dropdown) {
		throw new Error('device dropdown not rendered');
	}
	return dropdown;
}

function selectButtonOf(modal: DeviceSelectionModal): HTMLButtonElement {
	const button = modal.contentEl.querySelector('button');
	if (!button) {
		throw new Error('select button not rendered');
	}
	return button;
}

const tick = (): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, 0));

describe('DeviceSelectionModal', () => {
	it('renders one option per device with its label', () => {
		const { modal } = openModal([
			makeDevice('mic-1', 'USB Microphone'),
			makeDevice('mic-2', 'Headset'),
		]);

		const options = Array.from(dropdownOf(modal).options);
		expect(options.map((option) => option.value)).toEqual([
			'mic-1',
			'mic-2',
		]);
		expect(options.map((option) => option.text)).toEqual([
			'USB Microphone',
			'Headset',
		]);
	});

	it('falls back to a truncated device id when the label is empty', () => {
		const { modal } = openModal([makeDevice('abcdefgh-1234-5678', '')]);

		expect(dropdownOf(modal).options[0].text).toBe('Device abcdefgh');
	});

	it('invokes the callback with the selected device and closes on success', async () => {
		const { modal, onSelected } = openModal([
			makeDevice('mic-1', 'USB Microphone'),
			makeDevice('mic-2', 'Headset'),
		]);
		const close = jest.spyOn(modal, 'close');

		dropdownOf(modal).value = 'mic-2';
		selectButtonOf(modal).click();
		await tick();

		expect(onSelected).toHaveBeenCalledWith('mic-2', 'Headset');
		expect(Notice).toHaveBeenCalledWith('Selected audio device: Headset');
		expect(close).toHaveBeenCalled();
	});

	it('empties the content on close', () => {
		const { modal } = openModal([makeDevice('mic-1', 'USB Microphone')]);
		expect(modal.contentEl.childElementCount).toBeGreaterThan(0);

		modal.onClose();

		expect(modal.contentEl.childElementCount).toBe(0);
	});
});

describe('showDeviceSelectionModal', () => {
	afterEach(() => {
		delete (navigator as { mediaDevices?: unknown }).mediaDevices;
	});

	function mockEnumerate(devices: MediaDeviceInfo[]): void {
		Object.defineProperty(navigator, 'mediaDevices', {
			configurable: true,
			value: {
				enumerateDevices: jest.fn().mockResolvedValue(devices),
			},
		});
	}

	it('notifies and does not open when no audio inputs exist', async () => {
		mockEnumerate([makeDevice('cam-1', 'Webcam', 'videoinput')]);

		await showDeviceSelectionModal(new App(), jest.fn());

		expect(Notice).toHaveBeenCalledWith('No audio input devices found');
	});

	it('opens the modal listing only audio inputs', async () => {
		mockEnumerate([
			makeDevice('cam-1', 'Webcam', 'videoinput'),
			makeDevice('mic-1', 'USB Microphone'),
		]);
		const openSpy = jest.spyOn(DeviceSelectionModal.prototype, 'open');
		const onOpenSpy = jest.spyOn(DeviceSelectionModal.prototype, 'onOpen');

		try {
			await showDeviceSelectionModal(new App(), jest.fn());

			expect(openSpy).toHaveBeenCalled();
			const modal = onOpenSpy.mock
				.instances[0] as unknown as DeviceSelectionModal;
			const options = Array.from(dropdownOf(modal).options);
			expect(options.map((option) => option.value)).toEqual(['mic-1']);
		} finally {
			openSpy.mockRestore();
			onOpenSpy.mockRestore();
		}
	});
});
