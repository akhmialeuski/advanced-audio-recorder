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
import type { DropdownComponent, TextComponent } from 'obsidian';
import type { AudioRecorderSettings } from './settingsSchema';
import { CONVERSION_LINK_ACTION_OPTIONS, type LabeledOption } from './labels';
import {
	getSupportedBitrates,
	listBitrateAvailability,
	type BitrateAvailabilityEntry,
} from '../audio/AudioCapabilityDetector';
import { DEFAULT_SAMPLE_RATE } from '../constants';
import { getFormatDescriptor } from '../audio/formatRegistry';
import type { ConversionLinkAction } from './settingsSchema';

/** Class applied to a setting row that is rendered disabled (dimmed). */
export const SETTING_DISABLED_CLASS = 'aar-setting-disabled';

/**
 * Class applied to a numeric input, which the stylesheet sizes and gives back
 * the browser's stepper. Shared with the renderer that binds a declared number
 * control, so both kinds of numeric row look the same.
 */
export const NUMBER_INPUT_CLASS = 'aar-number-input';

/** Class applied to a "learn more" link appended to a setting description. */
const SETTING_DOC_LINK_CLASS = 'aar-doc-link';

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

/**
 * Adds the eye button that unmasks a secret field, the way Obsidian's own
 * secret dialog does it: the button sits to the left of the input and swaps the
 * icon with the input type. It is added before the input exists, so it is
 * handed the input afterwards through the binder it returns.
 * @param setting - The row the button is added to
 * @returns Binds the button to the password input the caller adds next
 */
function addSecretReveal(setting: Setting): (input: HTMLInputElement) => void {
	let inputEl: HTMLInputElement | null = null;
	setting.addExtraButton((button) => {
		button
			.setIcon('lucide-eye-off')
			.setTooltip('Show value')
			.onClick(() => {
				if (!inputEl) {
					return;
				}
				const masked = inputEl.type === 'password';
				inputEl.type = masked ? 'text' : 'password';
				button.setIcon(masked ? 'lucide-eye' : 'lucide-eye-off');
				button.setTooltip(masked ? 'Hide value' : 'Show value');
			});
	});
	return (input: HTMLInputElement): void => {
		inputEl = input;
	};
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
	// Obsidian masks a secret this way in its own keychain dialog: a reveal
	// toggle to the left of the field, an autocomplete the browser will not fill.
	// Mirrored here so an API key looks and behaves like every other secret the
	// app asks for.
	const bindReveal = config.secret ? addSecretReveal(setting) : undefined;
	setting.addText((text) => {
		if (config.secret) {
			text.inputEl.type = 'password';
			text.inputEl.setAttribute('autocomplete', 'off');
			bindReveal?.(text.inputEl);
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

/** Configuration for a toggle control. */
export interface ToggleControlConfig {
	name: string;
	desc?: string | undefined;
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
	desc?: string | undefined;
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
		// Index by value first: the disabled pass below is a lookup per rendered
		// option, not a linear scan of the option list for each one.
		const byValue = new Map(
			config.options.map((option) => [option.value, option]),
		);
		for (const option of config.options) {
			dropdown.addOption(option.value, option.label);
		}
		// Block the options the caller marked unavailable: they stay
		// visible (so every platform shows the same list) but cannot be
		// selected.
		for (const optionEl of Array.from(dropdown.selectEl.options)) {
			optionEl.disabled = byValue.get(optionEl.value)?.disabled ?? false;
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
		input.addClass(NUMBER_INPUT_CLASS);
		text.setValue(String(config.get()));
		input.addEventListener('change', () => {
			const value = normalizeNumber(input.value, config);
			input.value = String(value);
			void config.set(value);
		});
	});
	return component;
}

/** A stage row: an on/off toggle and its one numeric parameter, side by side. */
export interface StageRowConfig {
	name: string;
	desc: string;
	/** Reads and writes the stage's enabled flag. */
	getEnabled: () => boolean;
	setEnabled: (value: boolean) => void | Promise<void>;
	/** The stage's numeric parameter. */
	value: NumberInputConfig;
}

/**
 * Adds a stage toggle with its parameter's numeric input on the same row. The
 * input is greyed out while the stage is off, so it is clear the parameter only
 * takes effect once the stage is enabled.
 *
 * Shared by the audio-cleanup defaults in the settings tab and the per-run
 * cleanup dialog, which render the same three stages: without one builder the
 * two drifted, and only the dialog disabled the input of a stage that was off.
 * @param containerEl - Container to render the row into
 * @param config - The stage's label, enabled flag, and numeric parameter
 */
export function addStageRowTo(
	containerEl: HTMLElement,
	config: StageRowConfig,
): void {
	const setting = new Setting(containerEl)
		.setName(config.name)
		.setDesc(config.desc);
	const numberInput = addNumberInputTo(setting, config.value);
	numberInput.setDisabled(!config.getEnabled());
	setting.addToggle((toggle) =>
		toggle.setValue(config.getEnabled()).onChange((value) => {
			void config.setEnabled(value);
			numberInput.setDisabled(!value);
		}),
	);
}

/**
 * The fill each bitrate dropdown is currently showing, keyed by its own select
 * element. A row re-offered for another format starts a second probe while the
 * first is still in flight, and the answers can arrive in either order, so the
 * later fill wins and the earlier answer is dropped. The settings tab keeps
 * the same guard as a counter on itself; this list has three owners, so the
 * count belongs to the dropdown.
 */
const bitrateFillGeneration = new WeakMap<object, number>();

/**
 * Blocks the bitrates this device's encoder refuses, once the probe answers.
 *
 * Nothing is blocked when the probe finds nothing available at all, because
 * that is what an environment without a WebCodecs AudioEncoder reports for
 * every value, and a row with no selectable option would be worse than one
 * offering a value the encoder later declines.
 * @param dropdown - The dropdown whose options are blocked
 * @param format - Format the bitrates were offered for
 * @param sampleRate - Rate the encoder will write at
 * @param generation - The fill this answer belongs to
 */
async function blockUnreachableBitrates(
	dropdown: DropdownComponent,
	format: string,
	sampleRate: number,
	generation: number,
): Promise<void> {
	let entries: BitrateAvailabilityEntry[];
	try {
		entries = await listBitrateAvailability(format, sampleRate);
	} catch {
		// Probing failed entirely: leave every option selectable, the
		// encoder still reports a refusal when the run reaches it
		return;
	}
	if (
		bitrateFillGeneration.get(dropdown.selectEl) !== generation ||
		!entries.some((entry) => entry.available)
	) {
		return;
	}
	for (const option of Array.from(dropdown.selectEl.options)) {
		const entry = entries.find(
			(candidate) => String(candidate.bitrate) === option.value,
		);
		if (entry) {
			option.disabled = !entry.available;
		}
	}
}

/**
 * Fills a bitrate dropdown with the rates the target format encodes at the
 * given sample rate, selects the closest one to the value asked for, and
 * blocks the rest against this device's own encoder.
 *
 * Selecting the closest offered value rather than the stored one is what
 * keeps the dropdown showing the bitrate encoding will really use: a value
 * left behind by a format change is otherwise held by a control that has no
 * option for it.
 * @param dropdown - The dropdown to fill
 * @param options - Target format, sample rate, and the bitrate asked for
 * @returns The effective (possibly snapped) bitrate
 */
export function fillBitrateDropdown(
	dropdown: DropdownComponent,
	options: { format: string; sampleRate: number; selected: number },
): number {
	const bitrates = getSupportedBitrates(options.format, options.sampleRate);
	let effectiveBitrate = options.selected;
	if (bitrates.length > 0 && !bitrates.includes(effectiveBitrate)) {
		effectiveBitrate = bitrates.reduce((closest, bps) =>
			Math.abs(bps - options.selected) <
			Math.abs(closest - options.selected)
				? bps
				: closest,
		);
	}

	dropdown.selectEl.empty();
	bitrates.forEach((bps) => {
		const kbps = Math.round(bps / 1000);
		dropdown.addOption(String(bps), `${String(kbps)} kbps`);
	});
	dropdown.setValue(String(effectiveBitrate));

	const generation = (bitrateFillGeneration.get(dropdown.selectEl) ?? 0) + 1;
	bitrateFillGeneration.set(dropdown.selectEl, generation);
	void blockUnreachableBitrates(
		dropdown,
		options.format,
		options.sampleRate,
		generation,
	);

	return effectiveBitrate;
}

/**
 * Whether a target format carries a bitrate at all. A PCM target discards
 * one, so a row offering it would describe a file it cannot describe.
 * @param format - Target audio format
 * @returns Whether the bitrate row applies to this format
 */
function takesBitrate(format: string): boolean {
	return getFormatDescriptor(format)?.isPcm === false;
}

/** A bitrate row a dialog can re-offer when its target format changes. */
export interface BitrateRow {
	/** The bitrate currently offered and selected. */
	readonly value: number;
	/**
	 * Re-offers the bitrates a target format reaches, hiding the row for a
	 * target that takes no bitrate at all, and reports a value the new list
	 * moved through the builder's own onChange.
	 * @param format - The new target format
	 */
	rebuild(format: string): void;
}

/**
 * Adds a bitrate dropdown listing the bitrates a target format reaches. The
 * dialogs pick a target after the row is drawn, so the row is returned rather
 * than only its value: a target the source format rules out, or one that
 * takes no bitrate at all, changes what the row must show.
 * @param containerEl - Container to render the setting into
 * @param options - Labels, target format, initial value, and change callback
 * @returns The row, carrying its effective value and a way to re-offer it
 */
export function addBitrateSetting(
	containerEl: HTMLElement,
	options: {
		desc: string;
		format: string;
		sampleRate?: number;
		initialBitrate: number;
		onChange: (bitrate: number) => void;
	},
): BitrateRow {
	const sampleRate = options.sampleRate ?? DEFAULT_SAMPLE_RATE;
	let current = options.initialBitrate;
	let dropdown: DropdownComponent | null = null;

	const setting = new Setting(containerEl)
		.setName('Bitrate')
		.setDesc(options.desc)
		.addDropdown((component) => {
			dropdown = component;
			current = fillBitrateDropdown(component, {
				format: options.format,
				sampleRate,
				selected: current,
			});
			component.onChange((value) => {
				current = parseInt(value, 10);
				options.onChange(current);
			});
		});
	setting.settingEl.toggle(takesBitrate(options.format));

	return {
		get value(): number {
			return current;
		},
		rebuild(format: string): void {
			const applies = takesBitrate(format);
			setting.settingEl.toggle(applies);
			if (!dropdown || !applies) {
				return;
			}
			const settled = fillBitrateDropdown(dropdown, {
				format,
				sampleRate,
				selected: current,
			});
			if (settled !== current) {
				current = settled;
				options.onChange(settled);
			}
		},
	};
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
