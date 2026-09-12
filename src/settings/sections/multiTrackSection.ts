/**
 * Recording several inputs at once, and the device and channel choice each
 * track carries.
 * @module settings/sections/multiTrackSection
 */

import {
	isChannelModeSelectionSupported,
	isMultiTrackCaptureSupported,
} from '../../platform/capabilities';
import { MAX_TRACK_GAIN_DB, MIN_TRACK_GAIN_DB } from '../../constants';
import { isSystemAudioLoopbackAvailable } from '../../recording/systemAudioSupport';
import {
	CHANNEL_MODE_LABELS,
	TRACK_PROCESSING_LABELS,
	TRACK_SOURCE_KIND_LABELS,
} from '../labels';
import { multiTrackStatus, type PageStatus } from '../settingsAttention';
import type { AudioRecorderSettings } from '../settingsSchema';
import { type DeviceOptions, TRACK_ROWS_CLASS } from './context';
import { MAX_TRACK_COUNT, trackControlKey } from './controlKeys';
import { deviceRowDesc, sectionItems } from './rowHelpers';
import type { SettingGroupItem } from 'obsidian';

/**
 * What the source row says about recording this computer's own output.
 *
 * Whether the host can grant it is a fact of the installed build and of the
 * platform, so the row says which of the two answers applies here rather than
 * offering a choice that would fail at the start of a recording. The option
 * stays selectable either way: a configuration synced from a machine that can
 * do it must survive a visit to a machine that cannot.
 * @returns The row's description
 */
function systemAudioSourceDesc(): string {
	const base = 'What this track records.';
	return isSystemAudioLoopbackAvailable()
		? `${base} System audio captures this computer's own output, so the other participants of a call reach the recording.`
		: `${base} System audio is unavailable on this build, which grants it on Windows only. Record a loopback input device instead, such as Stereo Mix, VB-CABLE or a PipeWire monitor.`;
}

/**
 * Multi-track capture: the switch, how many tracks to offer, how they are
 * exported, and one input plus channel layout per track. Behind an entry of its
 * own, since two tracks alone are four device rows nobody configures twice. The
 * per-track rows are declared for every track the section can offer and
 * revealed by predicate, so changing the track count reveals rows instead of
 * rebuilding the tab.
 * @param settings - Live settings, read by the predicates
 * @param devices - Input devices as last enumerated
 */
export function multiTrackPage(
	settings: AudioRecorderSettings,
	devices: DeviceOptions,
): SettingGroupItem {
	const available = isMultiTrackCaptureSupported();
	const active = (): boolean => settings.enableMultiTrack && available;
	const trackRows = (): SettingGroupItem[] => {
		const rows: SettingGroupItem[] = [];
		for (let track = 1; track <= MAX_TRACK_COUNT; track++) {
			const offered = (): boolean =>
				active() && track <= settings.maxTracks;
			// Where a track sits in the mix is only a question when there is a
			// mix: one file per track keeps every track exactly as captured.
			const mixed = (): boolean =>
				offered() && settings.outputMode === 'single';
			// A place in the mix is bound to the track's device, exactly as
			// its channel layout is: the writer refuses one for a track with
			// no input, so a row that took the edit anyway accepted a number
			// and then showed the old one back.
			const unassigned = (): boolean =>
				!settings.trackAudioSources.get(track)?.deviceId;
			// A system-audio track is configured by being one, so it has no
			// device row and its placement rows are never blocked for want
			// of a device.
			const systemAudio = (): boolean =>
				settings.trackAudioSources.get(track)?.kind === 'system-audio';
			const unconfigured = (): boolean => !systemAudio() && unassigned();
			rows.push(
				{
					name: `Track ${String(track)} source`,
					aliases: ['system audio', 'loopback', 'desktop audio'],
					desc: systemAudioSourceDesc(),
					visible: offered,
					control: {
						type: 'dropdown',
						key: trackControlKey(track, 'kind'),
						options: TRACK_SOURCE_KIND_LABELS,
					},
				},
				{
					name: `Track ${String(track)} input`,
					aliases: ['audio source', 'device'],
					desc: deviceRowDesc(
						devices,
						`Input device recorded into track ${String(track)}.`,
						true,
					),
					visible: (): boolean => offered() && !systemAudio(),
					control: {
						type: 'dropdown',
						key: trackControlKey(track, 'deviceId'),
						options: devices.inputs,
					},
				},
				{
					name: `Track ${String(track)} channels`,
					aliases: ['channel layout', 'mono'],
					desc: `Channel layout recorded into track ${String(track)}: keep the device layout, or reduce it to mono.`,
					visible: (): boolean => offered() && !systemAudio(),
					control: {
						type: 'dropdown',
						key: trackControlKey(track, 'channelMode'),
						options: CHANNEL_MODE_LABELS,
						// A track with no device, or one whose device reports a
						// single capture channel, has no layout to choose.
						disabled: (): boolean =>
							!isChannelModeSelectionSupported() ||
							!devices.channelSelectable(
								settings.trackAudioSources.get(track)
									?.deviceId ?? '',
							),
					},
				},
				{
					name: `Track ${String(track)} processing`,
					aliases: [
						'noise suppression',
						'echo cancellation',
						'automatic gain control',
						'loopback',
						'system audio',
					],
					desc: `Browser filtering applied to track ${String(track)} as it is captured. A system-loopback input wants Raw: echo cancellation treats the far end of a call as this machine's own output and suppresses it.`,
					visible: offered,
					control: {
						type: 'dropdown',
						key: trackControlKey(track, 'processing'),
						options: TRACK_PROCESSING_LABELS,
						disabled: unconfigured,
					},
				},
				{
					name: `Track ${String(track)} level`,
					aliases: ['gain', 'volume', 'decibels'],
					desc: `Level applied to track ${String(track)} in the combined file, in decibels. A laptop microphone beside an interface is many decibels quieter, and the correction belongs to the track.`,
					visible: mixed,
					control: {
						type: 'number',
						key: trackControlKey(track, 'gainDb'),
						min: MIN_TRACK_GAIN_DB,
						max: MAX_TRACK_GAIN_DB,
						step: 1,
						disabled: unconfigured,
					},
				},
				{
					name: `Track ${String(track)} position`,
					aliases: ['pan', 'stereo', 'left', 'right'],
					desc: `Where track ${String(track)} sits in the combined file: -1 fully left, 0 centre, 1 fully right. A track placed off centre makes the combined file stereo.`,
					visible: mixed,
					control: {
						type: 'number',
						key: trackControlKey(track, 'pan'),
						min: -1,
						max: 1,
						step: 0.25,
						disabled: unconfigured,
					},
				},
			);
		}
		return rows;
	};
	return {
		type: 'page',
		name: 'Multi-track recording',
		desc: 'Recording several input devices at the same time.',
		displayValue: (): string =>
			active() ? `${String(settings.maxTracks)} tracks` : 'Off',
		// The track count alone reads the same whether the tracks have inputs
		// or not, and a track without one is what a recording is refused on.
		status: (): PageStatus => multiTrackStatus(settings),
		items: sectionItems(
			[
				{
					name: 'Enable multi-track recording',
					aliases: ['multitrack', 'interview', 'two mics'],
					desc: available
						? 'Record from several input devices at the same time.'
						: 'Not available on this device. Recording captures a single track from the default microphone.',
					control: {
						type: 'toggle',
						key: 'enableMultiTrack',
						disabled: !available,
					},
				},
				{
					name: 'Maximum tracks',
					desc: 'Number of simultaneous tracks to configure. Use only what you need.',
					visible: active,
					control: {
						type: 'number',
						key: 'maxTracks',
						min: 1,
						max: MAX_TRACK_COUNT,
						step: 1,
					},
				},
				{
					name: 'Output mode',
					desc: 'Export multi-track output as one combined file or one file per track.',
					visible: active,
					control: {
						type: 'dropdown',
						key: 'outputMode',
						options: {
							single: 'Single file',
							multiple: 'Multiple files',
						},
					},
				},
				{
					name: 'Match track levels',
					aliases: ['normalize', 'balance', 'levelling'],
					desc: 'Bring the tracks to a common level before combining them, so a quiet participant is not lost behind a loud one. Off by default: it is a judgement about the recording, and a session combined twice has to come out the same both times.',
					visible: (): boolean =>
						active() && settings.outputMode === 'single',
					control: { type: 'toggle', key: 'mixAlignTrackLevels' },
				},
				...trackRows(),
			],
			TRACK_ROWS_CLASS,
		),
	};
}
