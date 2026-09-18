/**
 * The capture device, its channels, and the sample rate.
 * @module settings/sections/audioInputSection
 */

import {
	isChannelModeSelectionSupported,
	isDeviceSelectionSupported,
	isMultiTrackCaptureSupported,
	isSampleRateSelectionSupported,
} from '../../platform/capabilities';
import { CHANNEL_MODE_LABELS } from '../labels';
import type { AudioRecorderSettings } from '../settingsSchema';
import { type DeviceOptions, SETTINGS_SECTION_CLASS } from './context';
import { deviceRowDesc } from './rowHelpers';
import type { SettingDefinitionItem } from 'obsidian';

/**
 * What the system-audio row says, given what this device can do with it.
 *
 * Three sentences at most, and which ones are said is a fact of the build
 * rather than a choice: what the switch does, then either the platform's
 * refusal or the way out of the pairing's fixed answers. The switch stays
 * offered whatever they say - a vault synced from a machine that can record
 * the system output must show the setting it carries on one that cannot, or a
 * user who cannot see it cannot turn it off either.
 * @param captureAvailable - Whether this device can open two captures at once
 * @param grantAvailable - Whether this build can be granted the system output
 * @returns The row's description
 */
function systemAudioRowDesc(
	captureAvailable: boolean,
	grantAvailable: boolean,
): string {
	const base =
		"Record this computer's own output beside the microphone. The session " +
		'then captures two tracks - the microphone exactly as the rows here ' +
		'describe it, and the system output - and mixes them into one file, ' +
		'so the other participants of a call reach the recording without a ' +
		'virtual cable and without a track being configured for it.';
	if (!captureAvailable) {
		return `${base} Not available on this device: recording captures a single track from the default microphone.`;
	}
	if (!grantAvailable) {
		return `${base} This build grants the system output on Windows only, so a recording started with it on elsewhere is refused. Record a loopback input device instead, such as Stereo Mix, VB-CABLE or a PipeWire monitor.`;
	}
	return `${base} Multi-track recording overrides it: with that on, a track's own source row says which track records the system output, and what it is captured and mixed with.`;
}

/**
 * The capture hardware: which input, at what rate, in what channel layout.
 * @param settings - Live settings, read by the predicates
 * @param devices - Input devices as last enumerated
 * @param sampleRates - Capture rates this device offers
 * @param systemAudioAvailable - Whether this build can be granted the system
 *   output, asked once for the whole tree
 */
export function audioInputGroup(
	settings: AudioRecorderSettings,
	devices: DeviceOptions,
	sampleRates: readonly number[],
	systemAudioAvailable: boolean,
): SettingDefinitionItem {
	const deviceSelectable = isDeviceSelectionSupported();
	const rateSelectable = isSampleRateSelectionSupported();
	// Two captures at once is what the pairing needs, which is the ability the
	// multi-track page needs as well; whether the second of them can be the
	// system output is the answer handed in, asked once for the whole tree.
	const pairingAvailable = isMultiTrackCaptureSupported();
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
				name: 'Include system audio',
				aliases: [
					'system audio',
					'loopback',
					'desktop audio',
					'computer sound',
					'call',
					'meeting',
				],
				desc: systemAudioRowDesc(
					pairingAvailable,
					systemAudioAvailable,
				),
				control: {
					type: 'toggle',
					key: 'includeSystemAudio',
					// Off where two captures cannot be opened at all, and where
					// the multi-track page already says what every track
					// records: the pairing stands down for that configuration
					// rather than adding a track to it, since one session can
					// capture the system output only once.
					disabled: (): boolean =>
						!pairingAvailable || settings.enableMultiTrack,
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
