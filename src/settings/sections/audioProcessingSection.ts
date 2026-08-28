/**
 * Conversion and the processing offered on a file that already exists.
 * @module settings/sections/audioProcessingSection
 */

import type { AudioRecorderSettings } from '../settingsSchema';
import { sectionItems, toggleSummary } from './rowHelpers';
import type { SettingDefinition, SettingGroupItem } from 'obsidian';

/**
 * The input-processing constraints and the live recording feedback, behind an
 * entry of its own. Seven switches that are set once and then read past, so the
 * entry counts how many are on rather than showing them all.
 * @param settings - Live settings, read by the entry's value
 */
export function audioProcessingPage(
	settings: AudioRecorderSettings,
): SettingGroupItem {
	const rows: SettingDefinition[] = [
		{
			name: 'Noise suppression',
			aliases: ['background noise'],
			desc: 'Apply the browser noise-suppression filter to the input.',
			control: { type: 'toggle', key: 'inputNoiseSuppression' },
		},
		{
			name: 'Echo cancellation',
			desc: 'Apply the browser echo-cancellation filter to the input.',
			control: { type: 'toggle', key: 'inputEchoCancellation' },
		},
		{
			name: 'Automatic gain control',
			desc: 'Let the browser normalize the input level automatically.',
			control: { type: 'toggle', key: 'inputAutoGainControl' },
		},
		{
			name: 'Input level meter',
			desc: 'Show a live input-level meter while recording.',
			control: { type: 'toggle', key: 'showInputLevelMeter' },
		},
		{
			name: 'Recording stats',
			desc: 'Show the live elapsed time and total recorded size while recording.',
			control: { type: 'toggle', key: 'showRecordingStats' },
		},
		{
			name: 'Detect silent channel after recording',
			desc: 'Check a saved stereo recording for a silent channel - the typical result of one microphone on a dual-input interface - and offer to convert it to mono.',
			control: { type: 'toggle', key: 'detectSilentChannelOnSave' },
		},
		{
			name: 'Mobile recording banner',
			desc: 'Show a prominent recording banner on mobile, where there is no ribbon indicator.',
			control: { type: 'toggle', key: 'mobileRecordingBanner' },
		},
	];
	return {
		type: 'page',
		name: 'Audio processing & feedback',
		desc: 'Filters applied to the input, and what is shown while recording.',
		displayValue: (): string => toggleSummary(rows, settings),
		items: sectionItems(rows),
	};
}
