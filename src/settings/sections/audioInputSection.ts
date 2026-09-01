/**
 * The capture device, its channels, and the sample rate.
 * @module settings/sections/audioInputSection
 */

import {
	isChannelModeSelectionSupported,
	isDeviceSelectionSupported,
	isSampleRateSelectionSupported,
} from '../../platform/capabilities';
import { CHANNEL_MODE_LABELS } from '../labels';
import type { AudioRecorderSettings } from '../settingsSchema';
import { type DeviceOptions, SETTINGS_SECTION_CLASS } from './context';
import { deviceRowDesc } from './rowHelpers';
import type { SettingDefinitionItem } from 'obsidian';

/**
 * The capture hardware: which input, at what rate, in what channel layout.
 * @param settings - Live settings, read by the predicates
 * @param devices - Input devices as last enumerated
 * @param sampleRates - Capture rates this device offers
 */
export function audioInputGroup(
	settings: AudioRecorderSettings,
	devices: DeviceOptions,
	sampleRates: readonly number[],
): SettingDefinitionItem {
	const deviceSelectable = isDeviceSelectionSupported();
	const rateSelectable = isSampleRateSelectionSupported();
	return {
		type: 'group',
		cls: SETTINGS_SECTION_CLASS,
		heading: 'Audio input',
		items: [
			{
				name: 'Input device',
				aliases: ['microphone', 'mic', 'source'],
				desc: deviceRowDesc(
					devices,
					'Default input device for single-track recordings. Also changeable from the command palette.',
					deviceSelectable,
				),
				control: {
					type: 'dropdown',
					key: 'audioDeviceId',
					options: devices.inputs,
					disabled: !deviceSelectable,
				},
			},
			{
				name: 'Sample rate',
				aliases: ['hz', 'khz'],
				desc: rateSelectable
					? 'Audio sample rate in hertz.'
					: 'Not selectable on this device; the system capture rate is used.',
				control: {
					type: 'dropdown',
					key: 'sampleRate',
					options: Object.fromEntries(
						sampleRates.map((rate) => [String(rate), String(rate)]),
					),
					disabled: !rateSelectable,
				},
			},
			{
				name: 'Recording channels',
				aliases: ['mono', 'stereo', 'channel'],
				desc: 'Channel layout for single-track recordings: keep the device layout, or reduce to mono during capture. Multi-track sessions use the per-track selectors instead.',
				control: {
					type: 'dropdown',
					key: 'recordingChannels',
					options: CHANNEL_MODE_LABELS,
					// An empty device id means the platform default, whose
					// capability is not knowable here, so the choice stays open.
					disabled: (): boolean =>
						!isChannelModeSelectionSupported() ||
						(settings.audioDeviceId !== '' &&
							!devices.channelSelectable(settings.audioDeviceId)),
				},
			},
		],
	};
}
