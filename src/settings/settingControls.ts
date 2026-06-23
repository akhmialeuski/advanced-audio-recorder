/**
 * Reusable settings-control builders and the section context they share.
 * They wrap Obsidian's `Setting` with the plugin's save conventions
 * (immediate save for toggles/dropdowns/sliders, debounced save for text)
 * so individual sections stay declarative and free of repeated wiring.
 * @module settings/settingControls
 */

import { Setting } from 'obsidian';
import type { AudioRecorderSettings, LabeledOption } from './Settings';

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
	setting.addText((text) => {
		if (config.secret) {
			text.inputEl.type = 'password';
		}
		text.setValue(config.get()).onChange((value) => {
			config.set(value);
			ctx.saveDebounced();
		});
	});
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
