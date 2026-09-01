/**
 * Where recordings are written and how they are named.
 * @module settings/sections/fileStorageSection
 */

import type { AudioRecorderSettings } from '../settingsSchema';
import { SETTINGS_SECTION_CLASS } from './context';
import type { SettingDefinitionItem } from 'obsidian';

/**
 * Where a recording is written and how it is named.
 * @param settings - Live settings, read by the predicates
 */
export function fileStorageGroup(
	settings: AudioRecorderSettings,
): SettingDefinitionItem {
	return {
		type: 'group',
		cls: SETTINGS_SECTION_CLASS,
		heading: 'File storage',
		items: [
			{
				name: 'Save folder',
				aliases: ['recordings folder', 'output folder', 'path'],
				desc: 'Where recordings are saved in your vault.',
				// The folder control brings Obsidian's own folder suggestions,
				// which the tab used to wire by hand.
				control: {
					type: 'folder',
					key: 'saveFolder',
					includeRoot: true,
					placeholder: '/',
				},
			},
			{
				name: 'Save recordings near active file',
				desc: 'Save recordings beside the active Markdown file. Takes priority over the save folder.',
				control: { type: 'toggle', key: 'saveNearActiveFile' },
			},
			{
				name: 'Active file subfolder',
				desc: 'Optional subfolder beside the active file (for example: audio). Created if missing.',
				visible: (): boolean => settings.saveNearActiveFile,
				control: { type: 'text', key: 'activeFileSubfolder' },
			},
			{
				name: 'File prefix',
				aliases: ['file name', 'filename', 'naming'],
				desc: 'Filename prefix used for exported recordings.',
				control: { type: 'text', key: 'filePrefix' },
			},
			{
				name: 'Insert at original position',
				desc: 'Insert the audio link where recording started, even if you navigate away during it.',
				control: { type: 'toggle', key: 'insertAtOriginalPosition' },
			},
		],
	};
}
