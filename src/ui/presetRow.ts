/**
 * The Preset row of the Transcribe dialog: one dropdown that sets the engine,
 * the language, the switches and the profiles of the run at once, and a
 * button that saves the options as they stand under a new name.
 * @module ui/presetRow
 */

import { Setting } from 'obsidian';
import type { App } from 'obsidian';
import type { AudioRecorderSettings } from '../settings/settingsSchema';
import {
	freeProfileName,
	ProfileKindId,
	profileNameRejection,
	profilesOfKind,
	selectedProfileId,
} from '../settings/profiles';
import { ProfileNameModal } from './ProfileNameModal';

/** What the row says when no preset has gone wrong. */
const PRESET_DESC =
	'Sets the options below at once. A change made after picking applies to this run only.';

/** Name offered for a preset saved from the dialog. */
const NEW_PRESET_NAME = 'New preset';

/** What the row reads and whom it tells. */
export interface PresetRowHost {
	readonly app: App;
	/** The run's copy of the settings, which names the presets to pick. */
	readonly settings: AudioRecorderSettings;
	/** Why the picked preset could not be applied, or null. */
	readonly problem: string | null;
	/**
	 * A preset was picked, '' for none.
	 * @param id - Its id
	 */
	onPick(id: string): void;
	/**
	 * The options as they stand are to be saved under a name.
	 * @param name - The name the user gave
	 */
	onSave(name: string): void;
}

/**
 * Renders the Preset row.
 * @param containerEl - Where the row goes
 * @param host - What it reads and whom it tells
 */
export function renderPresetRow(
	containerEl: HTMLElement,
	host: PresetRowHost,
): void {
	const presets = profilesOfKind(
		host.settings.profiles,
		ProfileKindId.RunPreset,
	);
	new Setting(containerEl)
		.setName('Preset')
		.setDesc(host.problem ?? PRESET_DESC)
		.addDropdown((dropdown) => {
			dropdown.addOption('', 'None');
			for (const preset of presets) {
				dropdown.addOption(preset.id, preset.name);
			}
			dropdown
				.setValue(
					selectedProfileId(host.settings, ProfileKindId.RunPreset),
				)
				.onChange((id) => {
					host.onPick(id);
				});
		})
		.addExtraButton((button) => {
			button
				.setIcon('save')
				.setTooltip('Save these options as a preset')
				.onClick(() => {
					new ProfileNameModal(host.app, {
						title: 'Save options as a preset',
						confirmText: 'Save',
						initial: freeProfileName(presets, NEW_PRESET_NAME),
						rejection: (name) =>
							profileNameRejection(
								host.settings.profiles,
								ProfileKindId.RunPreset,
								'',
								name,
							),
						onSubmit: (name) => {
							host.onSave(name);
						},
					}).open();
				});
		});
}
