/**
 * Shared Setting builders for the conversion and split dialogs, which
 * present the same bitrate / delete-source / link-action controls.
 * @module ui/settingHelpers
 */

import { Setting } from 'obsidian';
import { getSupportedBitrates } from '../audio/AudioCapabilityDetector';
import type { ConversionLinkAction } from '../settings/settingsSchema';

/**
 * Adds a bitrate dropdown listing the supported bitrates. The initial
 * value is snapped to the closest supported entry so the dropdown
 * always shows the bitrate actually used for encoding.
 * @param containerEl - Container to render the setting into
 * @param options - Labels, initial value, and change callback
 * @returns The effective (possibly snapped) initial bitrate
 */
export function addBitrateSetting(
	containerEl: HTMLElement,
	options: {
		desc: string;
		initialBitrate: number;
		onChange: (bitrate: number) => void;
	},
): number {
	const bitrates = getSupportedBitrates();
	let effectiveBitrate = options.initialBitrate;
	if (bitrates.length > 0 && !bitrates.includes(effectiveBitrate)) {
		effectiveBitrate = bitrates.reduce((closest, bps) =>
			Math.abs(bps - options.initialBitrate) <
			Math.abs(closest - options.initialBitrate)
				? bps
				: closest,
		);
	}

	new Setting(containerEl)
		.setName('Bitrate')
		.setDesc(options.desc)
		.addDropdown((dropdown) => {
			bitrates.forEach((bps) => {
				const kbps = Math.round(bps / 1000);
				dropdown.addOption(String(bps), `${String(kbps)} kbps`);
			});
			dropdown.setValue(String(effectiveBitrate));
			dropdown.onChange((value) => {
				options.onChange(parseInt(value, 10));
			});
		});

	return effectiveBitrate;
}

/**
 * Adds the delete-source toggle shared by the conversion and split
 * dialogs.
 * @param containerEl - Container to render the setting into
 * @param options - Description, initial value, and change callback
 */
export function addDeleteSourceSetting(
	containerEl: HTMLElement,
	options: {
		desc: string;
		initialValue: boolean;
		onChange: (value: boolean) => void;
	},
): void {
	new Setting(containerEl)
		.setName('Delete source file')
		.setDesc(options.desc)
		.addToggle((toggle) =>
			toggle.setValue(options.initialValue).onChange(options.onChange),
		);
}

/**
 * Adds the link-action dropdown (do nothing / replace / insert after)
 * shared by the conversion and split dialogs.
 * @param containerEl - Container to render the setting into
 * @param options - Description, initial value, and change callback
 */
export function addLinkActionSetting(
	containerEl: HTMLElement,
	options: {
		desc: string;
		initialValue: ConversionLinkAction;
		onChange: (value: ConversionLinkAction) => void;
	},
): void {
	new Setting(containerEl)
		.setName('Update links in notes')
		.setDesc(options.desc)
		.addDropdown((dropdown) => {
			dropdown.addOption('none', 'Do nothing');
			dropdown.addOption('replace', 'Replace source link');
			dropdown.addOption('after', 'Insert after source link');
			dropdown.setValue(options.initialValue);
			dropdown.onChange((value) => {
				options.onChange(value as ConversionLinkAction);
			});
		});
}
