/**
 * Reusable settings-control builders and the section context they share.
 * They wrap Obsidian's `Setting` with the plugin's save conventions
 * (immediate save for toggles/dropdowns/sliders, debounced save for text)
 * so individual sections stay declarative and free of repeated wiring.
 *
 * Two shapes live here, deliberately. The `ctx`-based builders bind a control
 * to the live settings object and its save hooks, for the settings tab and the
 * per-run dialog that mirrors it. The `containerEl`-based builders at the
 * bottom take an initial value and a change callback instead, for the dialogs
 * whose choices apply to one run and are never persisted. They used to live in
 * a second module (`ui/settingHelpers`), which left two parallel families of
 * builders with no shared option lists - the link-action dropdown, for one, was
 * spelled out separately here and in the settings tab.
 * @module settings/settingControls
 */

import { Setting } from 'obsidian';
import type { TextComponent } from 'obsidian';
import type { AudioRecorderSettings } from './settingsSchema';
import { CONVERSION_LINK_ACTION_OPTIONS, type LabeledOption } from './labels';
import { getSupportedBitrates } from '../audio/AudioCapabilityDetector';
import type { ConversionLinkAction } from './settingsSchema';
import {
	addModelToList,
	ensureSelectedInList,
	normalizeModelId,
	removeModelFromList,
} from './modelList';

/** Class applied to a setting row that is rendered disabled (dimmed). */
export const SETTING_DISABLED_CLASS = 'aar-setting-disabled';

/** Class applied to a "learn more" link appended to a setting description. */
const SETTING_DOC_LINK_CLASS = 'aar-doc-link';

/** Class applied to a setting whose control is a full-width, stacked text area. */
const SETTING_STACKED_CLASS = 'aar-setting-stacked';

/** Default visible row count for a multi-line text-area control. */
const DEFAULT_TEXTAREA_ROWS = 6;

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
		// merely empty - mirrors the disabled rendering used by addToggle.
		setting.settingEl.addClass(SETTING_DISABLED_CLASS);
	}
}

/** Configuration for a debounced multi-line text-area control. */
export interface TextAreaControlConfig {
	name: string;
	desc?: string;
	get: () => string;
	set: (value: string) => void;
	/** Optional "learn more" link appended to the description. */
	helpLink?: HelpLink;
	/** Visible row count (defaults to {@link DEFAULT_TEXTAREA_ROWS}). */
	rows?: number;
	/** Render the input non-interactive and dim the row. */
	disabled?: boolean;
}

/**
 * Adds a full-width, stacked multi-line text area bound to a getter/setter with
 * a debounced save. Used for the editable LLM prompts, where a single-line text
 * field is too cramped to read or edit a multi-sentence instruction.
 * @param ctx - Section context
 * @param config - Text-area bindings
 */
export function addTextArea(
	ctx: SettingsSectionContext,
	config: TextAreaControlConfig,
): void {
	const setting = new Setting(ctx.containerEl).setName(config.name);
	if (config.desc) {
		setting.setDesc(config.desc);
	}
	if (config.helpLink) {
		appendHelpLink(setting, config.helpLink);
	}
	setting.addTextArea((text) => {
		// rows is a textarea attribute (not a style), so it is allowed; width
		// and height come from the stacked-layout CSS class on the row.
		text.inputEl.rows = config.rows ?? DEFAULT_TEXTAREA_ROWS;
		text.setValue(config.get()).onChange((value) => {
			config.set(value);
			ctx.saveDebounced();
		});
		if (config.disabled) {
			text.setDisabled(true);
		}
	});
	setting.settingEl.addClass(SETTING_STACKED_CLASS);
	if (config.disabled) {
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
		// not merely "off" - the toggle's own disabled state is too subtle.
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
		// Block the options the caller marked unavailable: they stay
		// visible (so every platform shows the same list) but cannot be
		// selected.
		for (const optionEl of Array.from(dropdown.selectEl.options)) {
			const option = config.options.find(
				(candidate) => candidate.value === optionEl.value,
			);
			optionEl.disabled = option?.disabled ?? false;
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

/** Configuration for a numeric input control. */
export interface NumberInputConfig {
	/** Minimum accepted value. */
	min: number;
	/** Maximum accepted value. */
	max: number;
	/** Step the value snaps to (matching the old slider granularity). */
	step: number;
	/** Reads the current value. */
	get: () => number;
	/** Persists a new value. */
	set: (value: number) => void | Promise<void>;
}

/**
 * Snaps a raw field value to the nearest step and clamps it to [min, max], so
 * the stored value stays as valid as the slider's used to be. An empty or
 * non-numeric field falls back to the current stored value.
 *
 * The snap runs before the clamp so a max that is not itself on the step grid
 * (for example 32000 with step 512 anchored at 512, where the last grid point
 * is 32256) can never be rounded past the max and persisted out of range.
 * @param raw - The input's raw string value
 * @param config - The numeric bounds and current-value accessor
 */
function normalizeNumber(raw: string, config: NumberInputConfig): number {
	const parsed = Number(raw);
	const base =
		raw.trim() === '' || Number.isNaN(parsed) ? config.get() : parsed;
	const snapped =
		config.min +
		Math.round((base - config.min) / config.step) * config.step;
	const clamped = Math.min(config.max, Math.max(config.min, snapped));
	// Trim floating-point drift introduced by the snap arithmetic.
	return Number(clamped.toFixed(6));
}

/**
 * Adds a numeric input (manual entry plus the browser's native up/down
 * stepper) to an existing setting, replacing the slider control. The value
 * commits on change - Enter, blur, or a stepper click - where it is clamped to
 * [min, max], snapped to the step, written back to the field, and persisted.
 * Returns the text component so callers can toggle its disabled state.
 * @param setting - The setting row to add the input to
 * @param config - The numeric bounds and getter/setter
 */
export function addNumberInputTo(
	setting: Setting,
	config: NumberInputConfig,
): TextComponent {
	let component!: TextComponent;
	setting.addText((text) => {
		component = text;
		const input = text.inputEl;
		input.type = 'number';
		input.inputMode = 'numeric';
		input.min = String(config.min);
		input.max = String(config.max);
		input.step = String(config.step);
		input.addClass('aar-number-input');
		text.setValue(String(config.get()));
		input.addEventListener('change', () => {
			const value = normalizeNumber(input.value, config);
			input.value = String(value);
			void config.set(value);
		});
	});
	return component;
}

/** Configuration for a numeric setting row (label plus numeric input). */
export interface NumberSettingConfig {
	name: string;
	desc?: string;
	min: number;
	max: number;
	step: number;
	get: () => number;
	set: (value: number) => void;
}

/**
 * Adds a labelled numeric-input row bound to a getter/setter that saves
 * immediately, the numeric-field replacement for the old slider row.
 * @param ctx - The section context (container plus save hook)
 * @param config - The row label and numeric bounds/accessors
 */
export function addNumberInput(
	ctx: SettingsSectionContext,
	config: NumberSettingConfig,
): void {
	const setting = new Setting(ctx.containerEl).setName(config.name);
	if (config.desc) {
		setting.setDesc(config.desc);
	}
	addNumberInputTo(setting, {
		min: config.min,
		max: config.max,
		step: config.step,
		get: config.get,
		set: async (value) => {
			config.set(value);
			await ctx.save();
		},
	});
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
			for (const option of CONVERSION_LINK_ACTION_OPTIONS) {
				dropdown.addOption(option.value, option.label);
			}
			dropdown.setValue(options.initialValue);
			dropdown.onChange((value) => {
				options.onChange(value as ConversionLinkAction);
			});
		});
}
