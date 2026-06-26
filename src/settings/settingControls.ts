/**
 * Reusable settings-control builders and the section context they share.
 * They wrap Obsidian's `Setting` with the plugin's save conventions
 * (immediate save for toggles/dropdowns/sliders, debounced save for text)
 * so individual sections stay declarative and free of repeated wiring.
 * @module settings/settingControls
 */

import { Setting } from 'obsidian';
import type { AudioRecorderSettings, LabeledOption } from './Settings';
import {
	addModelToList,
	ensureSelectedInList,
	normalizeModelId,
	removeModelFromList,
} from './modelList';

/** Class applied to a setting row that is rendered disabled (dimmed). */
export const SETTING_DISABLED_CLASS = 'aar-setting-disabled';

/** Class applied to a "learn more" link appended to a setting description. */
export const SETTING_DOC_LINK_CLASS = 'aar-doc-link';

/** A "learn more" link appended to a setting's description. */
export interface HelpLink {
	label: string;
	url: string;
}

/**
 * Appends a help link to a setting's description. Built with createEl + attr
 * (not setAttr) so it works under both the real API and the test mocks.
 * @param setting - The setting whose description gets the link
 * @param link - The link label and URL
 */
function appendHelpLink(setting: Setting, link: HelpLink): void {
	setting.descEl.createEl('br');
	setting.descEl.createEl('a', {
		text: link.label,
		cls: SETTING_DOC_LINK_CLASS,
		attr: { href: link.url, target: '_blank', rel: 'noopener' },
	});
}

/**
 * Shared dependencies a settings section needs: where to render, the live
 * settings object, and the three save/rerender hooks the controls call.
 */
export interface SettingsSectionContext {
	/** Element the section appends its settings to. */
	containerEl: HTMLElement;
	/** Live settings object being edited. */
	settings: AudioRecorderSettings;
	/** Persists settings immediately (used by toggles, dropdowns, sliders). */
	save: () => Promise<void>;
	/** Re-renders the whole tab (used after a value that shows/hides others). */
	rerender: () => void;
	/** Schedules a debounced persist (used by text inputs). */
	saveDebounced: () => void;
}

/** Adds a section heading. */
export function addHeading(ctx: SettingsSectionContext, name: string): void {
	new Setting(ctx.containerEl).setName(name).setHeading();
}

/** Configuration for a debounced text control (optionally a password). */
export interface TextControlConfig {
	name: string;
	desc?: string;
	get: () => string;
	set: (value: string) => void;
	/** Render as a password field for secrets (API keys). */
	secret?: boolean;
	/** Optional "learn more" link appended to the description. */
	helpLink?: HelpLink;
	/**
	 * Render the input non-interactive and dim the row. Used for a template the
	 * current selection cannot use (e.g. the speaker label format on a run that
	 * cannot diarize), so the control stays visible and explained rather than
	 * editable but inert.
	 */
	disabled?: boolean;
}

/** Adds a text input bound to a getter/setter with a debounced save. */
export function addText(
	ctx: SettingsSectionContext,
	config: TextControlConfig,
): void {
	const setting = new Setting(ctx.containerEl).setName(config.name);
	if (config.desc) {
		setting.setDesc(config.desc);
	}
	if (config.helpLink) {
		appendHelpLink(setting, config.helpLink);
	}
	setting.addText((text) => {
		if (config.secret) {
			text.inputEl.type = 'password';
		}
		text.setValue(config.get()).onChange((value) => {
			config.set(value);
			ctx.saveDebounced();
		});
		if (config.disabled) {
			text.setDisabled(true);
		}
	});
	if (config.disabled) {
		// Dim the whole row so a non-interactive input reads as unavailable, not
		// merely empty — mirrors the disabled rendering used by addToggle.
		setting.settingEl.addClass(SETTING_DISABLED_CLASS);
	}
}

/** Configuration for a toggle control. */
export interface ToggleControlConfig {
	name: string;
	desc?: string;
	get: () => boolean;
	set: (value: boolean) => void;
	/** Re-render the tab after the change (to reveal/hide dependent settings). */
	rerender?: boolean;
	/**
	 * Render the toggle non-interactive. Used for an option the current
	 * selection cannot use (e.g. diarization on an engine that cannot diarize),
	 * so the control stays visible and explained rather than silently inert.
	 */
	disabled?: boolean;
}

/** Adds a toggle bound to a getter/setter that saves immediately. */
export function addToggle(
	ctx: SettingsSectionContext,
	config: ToggleControlConfig,
): void {
	const setting = new Setting(ctx.containerEl).setName(config.name);
	if (config.desc) {
		setting.setDesc(config.desc);
	}
	setting.addToggle((toggle) => {
		toggle.setValue(config.get()).onChange(async (value) => {
			config.set(value);
			await ctx.save();
			if (config.rerender) {
				ctx.rerender();
			}
		});
		if (config.disabled) {
			toggle.setDisabled(true);
		}
	});
	if (config.disabled) {
		// Dim the whole row so a non-interactive option reads as disabled,
		// not merely "off" — the toggle's own disabled state is too subtle.
		setting.settingEl.addClass(SETTING_DISABLED_CLASS);
	}
}

/** Configuration for a dropdown control. */
export interface DropdownControlConfig {
	name: string;
	desc?: string;
	/** Value/label option pairs (see {@link LabeledOption}). */
	options: LabeledOption[];
	get: () => string;
	set: (value: string) => void;
	/** Re-render the tab after the change (to reveal/hide dependent settings). */
	rerender?: boolean;
}

/** Adds a dropdown bound to a getter/setter that saves immediately. */
export function addDropdown(
	ctx: SettingsSectionContext,
	config: DropdownControlConfig,
): void {
	const setting = new Setting(ctx.containerEl).setName(config.name);
	if (config.desc) {
		setting.setDesc(config.desc);
	}
	setting.addDropdown((dropdown) => {
		for (const option of config.options) {
			dropdown.addOption(option.value, option.label);
		}
		dropdown.setValue(config.get()).onChange(async (value) => {
			config.set(value);
			await ctx.save();
			if (config.rerender) {
				ctx.rerender();
			}
		});
	});
}

/** Configuration for a slider control. */
export interface SliderControlConfig {
	name: string;
	desc?: string;
	min: number;
	max: number;
	step: number;
	get: () => number;
	set: (value: number) => void;
}

/** Adds a slider bound to a getter/setter that saves immediately. */
export function addSlider(
	ctx: SettingsSectionContext,
	config: SliderControlConfig,
): void {
	const setting = new Setting(ctx.containerEl).setName(config.name);
	if (config.desc) {
		setting.setDesc(config.desc);
	}
	setting.addSlider((slider) =>
		slider
			.setLimits(config.min, config.max, config.step)
			.setValue(config.get())
			.setDynamicTooltip()
			.onChange(async (value) => {
				config.set(value);
				await ctx.save();
			}),
	);
}

/** Configuration for a model picker (pick from a saved, user-editable list). */
export interface ModelPickerConfig {
	/** Label for the picker row (e.g. "Deepgram model"). */
	name: string;
	/** Description shown above the docs link. */
	desc: string;
	/** Docs link to where the engine's models are listed. */
	helpLink: HelpLink;
	/** Reads the saved model ids. */
	getModels: () => string[];
	/** Persists the model ids. */
	setModels: (models: string[]) => void;
	/** Reads the selected model id. */
	getSelected: () => string;
	/** Persists the selected model id. */
	setSelected: (id: string) => void;
}

/**
 * Renders a model picker: a dropdown to choose the active model from a saved
 * list, a docs link, and an add/remove row to manage custom ids. The selected
 * id is always shown even if it is not in the saved list. Adding or removing
 * re-renders the tab so the dropdown reflects the new list. Used for engines
 * whose model is a free-form id (Whisper API, Deepgram); the local engine
 * points at a file path instead, so it does not use this.
 * @param ctx - Section context
 * @param config - Picker bindings
 */
export function addModelPicker(
	ctx: SettingsSectionContext,
	config: ModelPickerConfig,
): void {
	const models = ensureSelectedInList(
		config.getModels(),
		config.getSelected(),
	);
	const selected = normalizeModelId(config.getSelected()) || models[0] || '';
	// Self-heal a missing/empty stored selection: persist the fallback so the
	// shown model is the one actually used at transcription time (a hand-edited
	// or migrated config could otherwise leave an empty model selected).
	if (selected !== '' && selected !== config.getSelected()) {
		config.setSelected(selected);
		void ctx.save();
	}

	const picker = new Setting(ctx.containerEl)
		.setName(config.name)
		.setDesc(config.desc);
	appendHelpLink(picker, config.helpLink);
	picker.addDropdown((dropdown) => {
		for (const id of models) {
			dropdown.addOption(id, id);
		}
		dropdown.setValue(selected).onChange(async (value) => {
			config.setSelected(value);
			await ctx.save();
		});
	});

	let draft = '';
	new Setting(ctx.containerEl)
		.setName('Add custom model')
		.setDesc('Add a model ID to the list above, then select it.')
		.addText((text) => {
			text.setPlaceholder('Model ID').onChange((value) => {
				draft = value;
			});
		})
		.addButton((button) => {
			button.setButtonText('Add').onClick(async () => {
				const id = normalizeModelId(draft);
				if (id === '') {
					return;
				}
				config.setModels(addModelToList(config.getModels(), id));
				config.setSelected(id);
				await ctx.save();
				ctx.rerender();
			});
		})
		.addButton((button) => {
			button
				.setButtonText('Remove selected')
				.setDisabled(config.getModels().length <= 1)
				.onClick(async () => {
					const next = removeModelFromList(
						config.getModels(),
						config.getSelected(),
					);
					config.setModels(next);
					config.setSelected(next[0] ?? '');
					await ctx.save();
					ctx.rerender();
				});
		});
}
