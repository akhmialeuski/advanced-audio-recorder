/**
 * Splitting a long session into parts while it records.
 * @module settings/sections/audioSplittingSection
 */

import {
	DEFAULT_SPLIT_PART_SUFFIX,
	MAX_SPLIT_CHUNK_MINUTES,
	MIN_SPLIT_CHUNK_MINUTES,
	SPLIT_PART_SUFFIX_PATTERN,
} from '../../constants';
import type { AudioRecorderSettings } from '../settingsSchema';
import { sectionItems } from './rowHelpers';
import type { SettingGroupItem } from 'obsidian';

/**
 * Automatic splitting of a long recording into part files, behind an entry of
 * its own. Four rows nobody reads on the way to something else, and the entry
 * already says whether recordings are split and how often.
 * @param settings - Live settings, read by the entry's value
 */
export function audioSplittingPage(
	settings: AudioRecorderSettings,
): SettingGroupItem {
	return {
		type: 'page',
		name: 'Audio splitting',
		desc: 'Saving a long recording as fixed-length part files instead of one.',
		displayValue: (): string =>
			settings.autoSplitEnabled
				? `Every ${String(settings.splitChunkMinutes)} min`
				: 'Off',
		items: sectionItems([
			{
				name: 'Split recordings automatically',
				aliases: ['chunk', 'segment', 'long recording'],
				desc: 'Save the recording as separate part files of fixed duration instead of one long file. Not applied to merged multi-track recordings. On mobile this also bounds how much audio a crash can take with it, since each finished part is already on disk.',
				control: {
					type: 'toggle',
					key: 'autoSplitEnabled',
				},
			},
			{
				name: 'Part duration',
				desc: 'Length of each part in minutes. Also the default for manual splitting from the context menu.',
				control: {
					type: 'number',
					key: 'splitChunkMinutes',
					min: MIN_SPLIT_CHUNK_MINUTES,
					max: MAX_SPLIT_CHUNK_MINUTES,
					step: 1,
				},
			},
			{
				name: 'Part name suffix',
				desc: `Appended with the part number to part file names, e.g. "recording-${DEFAULT_SPLIT_PART_SUFFIX}1.webm".`,
				control: {
					type: 'text',
					key: 'splitPartSuffix',
					placeholder: DEFAULT_SPLIT_PART_SUFFIX,
					validate: (value: string): string | undefined =>
						SPLIT_PART_SUFFIX_PATTERN.test(value.trim())
							? undefined
							: 'Letters, digits, hyphens and underscores only.',
				},
			},
			{
				name: 'Delete source after split',
				desc: 'Default state of the delete source file option in the manual split dialog.',
				control: { type: 'toggle', key: 'deleteSourceAfterSplit' },
			},
		]),
	};
}
