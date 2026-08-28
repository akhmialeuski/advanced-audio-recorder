/**
 * The cleanup chain's defaults: which stages run and how hard each one works.
 * @module settings/sections/audioCleanupSection
 */

import {
	CLEANUP_GATE_STEP_DB,
	CLEANUP_HIGHPASS_STEP_HZ,
	CLEANUP_LEVELING_STEP_DB,
	MAX_CLEANUP_GATE_THRESHOLD_DB,
	MAX_CLEANUP_HIGHPASS_HZ,
	MAX_CLEANUP_LEVELING_MAKEUP_DB,
	MIN_CLEANUP_GATE_THRESHOLD_DB,
	MIN_CLEANUP_HIGHPASS_HZ,
	MIN_CLEANUP_LEVELING_MAKEUP_DB,
} from '../../constants';
import type { AudioRecorderSettings } from '../settingsSchema';
import { sectionItems } from './rowHelpers';
import type { SettingGroupItem } from 'obsidian';

/** The cleanup stages, in the order their rows appear. */
const CLEANUP_STAGES: ReadonlyArray<{
	readonly key: keyof AudioRecorderSettings;
	readonly label: string;
}> = [
	{ key: 'cleanupHighPassEnabled', label: 'High-pass' },
	{ key: 'cleanupNoiseGateEnabled', label: 'Noise gate' },
	{ key: 'cleanupLevelingEnabled', label: 'Leveling' },
];

/**
 * What the cleanup entry says: which stages the dialog would open with, since
 * "2 of 3" would not say which two.
 * @param settings - Live settings, read by each stage's switch
 * @returns The enabled stages, or Off
 */
function enabledStages(settings: AudioRecorderSettings): string {
	const enabled = CLEANUP_STAGES.filter(
		(stage) => settings[stage.key] === true,
	).map((stage) => stage.label);
	return enabled.length > 0 ? enabled.join(', ') : 'Off';
}

/**
 * The defaults for the on-demand cleanup dialog. Each stage is a switch and the
 * one number it takes, on rows of their own: a row holds a single control, and
 * the number follows the switch that decides whether it is used at all.
 * @param settings - Live settings, read by the disabled predicates
 */
export function audioCleanupPage(
	settings: AudioRecorderSettings,
): SettingGroupItem {
	return {
		type: 'page',
		name: 'Audio cleanup defaults',
		desc: 'What the on-demand cleanup dialog opens with.',
		displayValue: (): string => enabledStages(settings),
		items: sectionItems([
			{
				name: 'High-pass filter',
				aliases: ['low cut', 'rumble'],
				desc: 'Remove low-frequency rumble below the cutoff. These defaults prefill the cleanup dialog; cleanup writes a processed copy and never changes a live recording.',
				control: { type: 'toggle', key: 'cleanupHighPassEnabled' },
			},
			{
				name: 'High-pass cutoff',
				desc: 'Cutoff frequency in hertz.',
				control: {
					type: 'number',
					key: 'cleanupHighPassHz',
					min: MIN_CLEANUP_HIGHPASS_HZ,
					max: MAX_CLEANUP_HIGHPASS_HZ,
					step: CLEANUP_HIGHPASS_STEP_HZ,
					disabled: (): boolean => !settings.cleanupHighPassEnabled,
				},
			},
			{
				name: 'Noise gate',
				aliases: ['silence', 'gate'],
				desc: 'Silence the signal below the threshold.',
				control: { type: 'toggle', key: 'cleanupNoiseGateEnabled' },
			},
			{
				name: 'Noise gate threshold',
				desc: 'Level in dBFS below which the signal is silenced.',
				control: {
					type: 'number',
					key: 'cleanupNoiseGateThresholdDb',
					min: MIN_CLEANUP_GATE_THRESHOLD_DB,
					max: MAX_CLEANUP_GATE_THRESHOLD_DB,
					step: CLEANUP_GATE_STEP_DB,
					disabled: (): boolean => !settings.cleanupNoiseGateEnabled,
				},
			},
			{
				name: 'Loudness leveling',
				aliases: ['normalize', 'normalisation', 'lufs'],
				desc: 'Even out quiet and loud passages (compressor).',
				control: { type: 'toggle', key: 'cleanupLevelingEnabled' },
			},
			{
				name: 'Makeup gain',
				desc: 'Gain in decibels applied after leveling.',
				control: {
					type: 'number',
					key: 'cleanupLevelingMakeupDb',
					min: MIN_CLEANUP_LEVELING_MAKEUP_DB,
					max: MAX_CLEANUP_LEVELING_MAKEUP_DB,
					step: CLEANUP_LEVELING_STEP_DB,
					disabled: (): boolean => !settings.cleanupLevelingEnabled,
				},
			},
		]),
	};
}
