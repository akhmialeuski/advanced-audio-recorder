/**
 * Unit tests for the device picker the "Select audio input device" command
 * opens: a quick-pick list of the detected audio inputs, the one in use
 * marked, that stores the input chosen and says which one is now in use.
 * Also covers the audio-input filtering, the empty-list notice, and the
 * refusal it answers when the browser will not enumerate at all.
 * @module tests/unit/DeviceSelectionModal.test
 */

import { App, Notice } from 'obsidian';
import { at } from '../helpers/assertions';
import { showDeviceSelectionModal } from 'src/ui/DeviceSelectionModal';
import { ActionTargetModal } from 'src/ui/ActionTargetModal';
import { tick } from '../helpers/async';

function makeDevice(
	deviceId: string,
	label: string,
	kind: MediaDeviceKind = 'audioinput',
): MediaDeviceInfo {
	return { deviceId, label, kind, groupId: 'g' } as MediaDeviceInfo;
}

function mockEnumerate(devices: MediaDeviceInfo[]): void {
	Object.defineProperty(navigator, 'mediaDevices', {
		configurable: true,
		value: {
			enumerateDevices: jest.fn().mockResolvedValue(devices),
		},
	});
}

/**
 * Runs the command over the devices given and returns the picker it opened.
 * @param devices - What the browser enumerates
 * @param currentDeviceId - The input recordings use now
 * @param onSelected - Stores the choice
 */
async function openPicker(
	devices: MediaDeviceInfo[],
	currentDeviceId = '',
	onSelected: jest.Mock = jest.fn().mockResolvedValue(undefined),
): Promise<{
	picker: ActionTargetModal<MediaDeviceInfo>;
	onSelected: jest.Mock;
}> {
	mockEnumerate(devices);
	const open = jest.spyOn(ActionTargetModal.prototype, 'open');

	await showDeviceSelectionModal(new App(), onSelected, currentDeviceId);

	expect(open).toHaveBeenCalledTimes(1);
	const picker = at(
		open.mock.contexts,
		0,
	) as ActionTargetModal<MediaDeviceInfo>;
	return { picker, onSelected };
}

/** The rows the picker offers, as the user reads them. */
function rows(picker: ActionTargetModal<MediaDeviceInfo>): string[] {
	return picker.getItems().map((device) => picker.getItemText(device));
}

describe('device picker', () => {
	afterEach(() => {
		delete (navigator as { mediaDevices?: unknown }).mediaDevices;
	});

	it('offers one row per audio input, in the order the browser lists them', async () => {
		const { picker } = await openPicker([
			makeDevice('cam-1', 'Webcam', 'videoinput'),
			makeDevice('mic-1', 'USB Microphone'),
			makeDevice('mic-2', 'Headset'),
		]);

		expect(picker.getItems().map((device) => device.deviceId)).toEqual([
			'mic-1',
			'mic-2',
		]);
		expect(rows(picker)).toEqual(['USB Microphone', 'Headset']);
	});

	it('marks the input recordings use now', async () => {
		// Without it the list opens with nothing to say which input is the
		// one already chosen, which is the first thing a user checks.
		const { picker } = await openPicker(
			[
				makeDevice('mic-1', 'USB Microphone'),
				makeDevice('mic-2', 'Headset'),
			],
			'mic-2',
		);

		expect(rows(picker)).toEqual(['USB Microphone', 'Headset (current)']);
	});

	it('narrows the inputs to what is typed', async () => {
		const { picker } = await openPicker([
			makeDevice('mic-1', 'USB Microphone'),
			makeDevice('mic-2', 'Headset'),
		]);

		expect(
			picker.getSuggestions('head').map((match) => match.item.deviceId),
		).toEqual(['mic-2']);
	});

	it('asks for the input to record from', async () => {
		const { picker } = await openPicker([makeDevice('mic-1', 'Mic')]);

		expect(picker.inputEl.placeholder).toBe(
			'Choose the input to record from',
		);
	});

	it('falls back to a truncated device id when the label is empty', async () => {
		const { picker } = await openPicker([
			makeDevice('abcdefgh-1234-5678', ''),
		]);

		expect(rows(picker)).toEqual(['Audio device abcdefgh']);
	});

	// The plugin offers the input list here and in the settings tab, and the
	// marker reached only the settings tab. A marker present in one list and
	// absent from the other is worse than none, because its absence then
	// reads as "this one is not a loopback".
	it('marks an input that carries the system output', async () => {
		const { picker } = await openPicker([
			makeDevice('mix-1', 'Stereo Mix (Realtek(R) Audio)'),
			makeDevice('mic-1', 'Desk microphone'),
		]);

		expect(rows(picker)).toEqual([
			'Stereo Mix (Realtek(R) Audio) (system audio)',
			'Desk microphone',
		]);
	});

	it('stores the input chosen and says which one is now in use', async () => {
		const { picker, onSelected } = await openPicker(
			[
				makeDevice('mic-1', 'USB Microphone'),
				makeDevice('mic-2', 'Headset'),
			],
			'mic-1',
		);

		picker.onChooseItem(at(picker.getItems(), 1));
		await tick();

		// The stored label is the device's own, never the "(current)" mark
		expect(onSelected).toHaveBeenCalledWith('mic-2', 'Headset');
		expect(Notice).toHaveBeenCalledWith('Selected audio device: Headset');
	});

	it('says why the choice was not stored rather than claiming it was', async () => {
		const failure = new Error('Could not save settings');
		const reported = jest
			.spyOn(console, 'error')
			.mockImplementation(() => undefined);
		const { picker } = await openPicker(
			[makeDevice('mic-1', 'USB Microphone')],
			'',
			jest.fn().mockRejectedValue(failure),
		);

		picker.onChooseItem(at(picker.getItems(), 0));
		await tick();

		expect(Notice).toHaveBeenCalledWith('Could not save settings');
		expect(Notice).not.toHaveBeenCalledWith(
			'Selected audio device: USB Microphone',
		);
		expect(reported).toHaveBeenCalledWith(
			expect.stringContaining('Could not select audio device'),
			failure,
		);
	});
});

describe('showDeviceSelectionModal', () => {
	afterEach(() => {
		delete (navigator as { mediaDevices?: unknown }).mediaDevices;
	});

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
		const openSpy = jest.spyOn(ActionTargetModal.prototype, 'open');

		await expect(
			showDeviceSelectionModal(new App(), jest.fn(), ''),
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
		const openSpy = jest.spyOn(ActionTargetModal.prototype, 'open');

		await showDeviceSelectionModal(new App(), jest.fn(), '');

		expect(Notice).toHaveBeenCalledWith('No audio input devices found');
		expect(openSpy).not.toHaveBeenCalled();
	});
});
