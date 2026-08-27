/**
 * Unit tests for DeviceSelectionModal: renders the device dropdown from
 * the real modal DOM, invokes the selection callback with the chosen
 * device, and confirms/closes after the callback settles. Also covers
 * showDeviceSelectionModal's audio-input filtering, its empty-list notice,
 * and the refusal it answers when the browser will not enumerate at all.
 * @module tests/unit/DeviceSelectionModal.test
 */

import { App, Notice } from 'obsidian';
import { at } from '../helpers/assertions';
import {
	DeviceSelectionModal,
	showDeviceSelectionModal,
} from 'src/ui/DeviceSelectionModal';
import { tick } from '../helpers/async';

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

		expect(at(dropdownOf(modal).options, 0).text).toBe('Device abcdefgh');
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

	/**
	 * Asks for a device where the list cannot be read, and holds the command
	 * to the answer it owes either way: whoever asked is told, and nothing is
	 * opened. Rejecting instead would leave the command looking like it did
	 * nothing at all.
	 * @returns What was logged behind the notice, which is the only place the
	 *   reason survives
	 */
	async function askWhereTheListFails(): Promise<jest.SpyInstance> {
		const reported = jest
			.spyOn(console, 'error')
			.mockImplementation(() => undefined);
		const openSpy = jest.spyOn(DeviceSelectionModal.prototype, 'open');

		await expect(
			showDeviceSelectionModal(new App(), jest.fn()),
		).resolves.toBeUndefined();

		expect(Notice).toHaveBeenCalledWith(
			'Could not list audio input devices',
		);
		expect(openSpy).not.toHaveBeenCalled();
		return reported;
	}

	it('notifies and does not open when enumeration is refused', async () => {
		const refusal = new Error('Permission denied');
		Object.defineProperty(navigator, 'mediaDevices', {
			configurable: true,
			value: {
				enumerateDevices: jest.fn().mockRejectedValue(refusal),
			},
		});

		const reported = await askWhereTheListFails();

		expect(reported).toHaveBeenCalledWith(
			expect.stringContaining('Could not list audio input devices'),
			refusal,
		);
	});

	// Absent outside a secure context and in some embedded WebViews, where
	// reading through it unguarded raised "Cannot read properties of
	// undefined". The user sees the same notice either way, so what the fix
	// changes is the reason logged behind it, and that reason is the whole of
	// what a bug report carries back about an environment nobody can inspect.
	it('reports the missing device API rather than a read through it', async () => {
		const reported = await askWhereTheListFails();

		expect(reported.mock.calls[0]?.[1]).toHaveProperty(
			'message',
			'This environment exposes no audio device list.',
		);
	});

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

		// No manual restore: the projects run with `restoreMocks`, so jest
		// puts both prototype methods back after the test either way.
		await showDeviceSelectionModal(new App(), jest.fn());

		expect(openSpy).toHaveBeenCalled();
		const modal = onOpenSpy.mock
			.instances[0] as unknown as DeviceSelectionModal;
		const options = Array.from(dropdownOf(modal).options);
		expect(options.map((option) => option.value)).toEqual(['mic-1']);
	});
});
