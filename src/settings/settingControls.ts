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
	closestBitrate,
	effectiveBitrate,
	getSupportedBitrates,
	kilohertz,
	resolveBitrateOffer,
	type BitrateOffer,
} from '../audio/AudioCapabilityDetector';
import { offlineEncodeSampleRate } from '../audio/AudioFormatConverter';
import { DEFAULT_SAMPLE_RATE, PLUGIN_LOG_PREFIX } from '../constants';
import { getFormatDescriptor, takesBitrate } from '../audio/formatRegistry';
import type { ConversionLinkAction } from './settingsSchema';

/**
 * Channel layout assumed when a caller does not state one. Two is what
 * mediabunny itself assumes, and it is what a conversion keeping the source's
 * layout most often produces.
 */
const STEREO_CHANNEL_COUNT = 2;

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
 *
 * The guard is per element by design. A whole tab re-render builds a fresh
 * dropdown that runs its own probe, and the superseded answer then lands on an
 * element no longer in the document, where writing it changes nothing.
 */
const bitrateFillGeneration = new WeakMap<object, number>();

/**
 * Puts one list of bitrates into a dropdown and selects one of them.
 * @param dropdown - The dropdown to fill
 * @param bitrates - Bitrates to offer, in bps and ascending
 * @param selected - The bitrate to show, which must be one of them
 */
function renderBitrateOptions(
	dropdown: DropdownComponent,
	bitrates: readonly number[],
	selected: number,
): void {
	dropdown.selectEl.empty();
	bitrates.forEach((bps) => {
		const kbps = Math.round(bps / 1000);
		dropdown.addOption(String(bps), `${String(kbps)} kbps`);
	});
	dropdown.setValue(String(selected));
}

/**
 * Where a rate the current format's encoder refuses is still to be had. Opus
 * encodes from 6 kbps by specification, at every sample rate, on every device
 * with a WebCodecs encoder, so a user after a small speech file is sent there
 * rather than left with a refusal.
 */
const LOW_RATES_ELSEWHERE =
	'For the lower rates use WebM or OGG, whose Opus encoder writes all of them.';

/**
 * One sentence saying which bitrates the row is offering and what decided
 * them, which is the only way a missing value is accounted for: a rate the
 * codec has no table for at this sample rate never appears, and neither does
 * one the encoder on this device refuses.
 * @param format - Target audio format
 * @param sampleRate - Rate the encoder will write at
 * @param offer - The list and where it came from, or null before the encoder
 *   has been asked
 * @returns The note, to append to the row's own description
 */
export function bitrateOfferNote(
	format: string,
	sampleRate: number,
	offer: BitrateOffer | null,
): string {
	const bitrates =
		offer?.bitrates ?? getSupportedBitrates(format, sampleRate);
	const lowest = bitrates[0];
	const highest = bitrates[bitrates.length - 1];
	if (lowest === undefined || highest === undefined) {
		return '';
	}
	const codec = (
		getFormatDescriptor(format)?.codecLabel ?? format
	).toUpperCase();
	const range = `${codec} at ${kilohertz(sampleRate)} kHz reaches ${String(
		Math.round(lowest / 1000),
	)}-${String(Math.round(highest / 1000))} kbps.`;
	if (!offer) {
		return range;
	}
	switch (offer.encoder) {
		case 'unavailable':
			return `${range} There is no encoder on this device to confirm them.`;
		case 'refused':
			return `${range} The encoder on this device cannot write ${codec} at ${kilohertz(
				sampleRate,
			)} kHz. ${LOW_RATES_ELSEWHERE}`;
		case 'confirmed': {
			const declared = getSupportedBitrates(format, sampleRate);
			if (declared.length === bitrates.length) {
				return `${range} The encoder on this device accepts all of them.`;
			}
			// A narrowed list that lost its low end is the case the low rates
			// exist for, so the note says where they are still to be had.
			const lostLowEnd = declared.some((bps) => bps < lowest);
			return `${range} The encoder on this device accepts only the values listed.${
				lostLowEnd ? ` ${LOW_RATES_ELSEWHERE}` : ''
			}`;
		}
	}
}

/**
 * Re-offers the bitrates this device's encoder accepts, once it answers.
 *
 * The list is narrowed rather than dimmed. A blocked option a native select is
 * already sitting on stays displayed and stays selected, so dimming left the
 * row showing a rate the encoder had just refused, and a row where every
 * option was dimmed said nothing a user could act on. Removing them leaves
 * only values that work, and the note says what removed the rest.
 *
 * What the answer is reconciled against is the rate the dropdown is showing
 * now, read back from it, not the one the fill started from. The probe takes
 * as long as registering a bundled encoder, and a value picked while it was in
 * flight is as much a choice as the one the row opened with: snapping the old
 * value back left the select displaying one rate while the dialog converted at
 * another.
 * @param dropdown - The dropdown whose list is narrowed
 * @param options - Target, layout, the value the fill started from, and the
 *   fill this answer belongs to
 * @returns The selection after narrowing, whether narrowing moved it, and the
 *   note explaining the list, or null when the answer no longer applies
 */
async function narrowToOfferedBitrates(
	dropdown: DropdownComponent,
	options: {
		format: string;
		sampleRate: number;
		numberOfChannels: number;
		selected: number;
		generation: number;
		isStale: () => boolean;
	},
): Promise<{ bitrate: number; moved: boolean; note: string } | null> {
	const offer = await resolveBitrateOffer(
		options.format,
		options.sampleRate,
		options.numberOfChannels,
	);
	if (
		bitrateFillGeneration.get(dropdown.selectEl) !== options.generation ||
		options.isStale()
	) {
		return null;
	}
	const shown = parseInt(dropdown.getValue(), 10);
	const selected = Number.isFinite(shown) ? shown : options.selected;
	const note = bitrateOfferNote(options.format, options.sampleRate, offer);
	// Only a confirmed answer narrows anything. The other two verdicts hand
	// back the codec's own range, which is already on offer, so re-rendering
	// it would move the selection on the strength of an answer that measured
	// nothing.
	if (offer.encoder !== 'confirmed') {
		return { bitrate: selected, moved: false, note };
	}
	const settled = closestBitrate(offer.bitrates, selected);
	renderBitrateOptions(dropdown, offer.bitrates, settled);
	return { bitrate: settled, moved: settled !== selected, note };
}

/**
 * Fills a bitrate dropdown with the rates the target format reaches at the
 * given sample rate, selects the closest one to the value asked for, and then
 * narrows the list to what this device's encoder accepts.
 *
 * Selecting the closest offered value rather than the stored one is what
 * keeps the dropdown showing the bitrate encoding will really use: a value
 * left behind by a format change is otherwise held by a control that has no
 * option for it. It is `effectiveBitrate` that decides which value that is,
 * the same function the session snapshot and the output summary read, so no
 * two of them can name a different rate for one stored number.
 *
 * The encoder's own answer arrives later and can shorten the list and move the
 * selection with it, which is what `onSettled` and `onNote` report.
 * @param dropdown - The dropdown to fill
 * @param options - Target format, sample rate, channel layout, the bitrate
 *   asked for, where to report a value the encoder's answer moved, where to
 *   report the note explaining the list, and whether the owner has since
 *   dropped the row
 * @returns The effective (possibly snapped) bitrate
 */
export function fillBitrateDropdown(
	dropdown: DropdownComponent,
	options: {
		format: string;
		sampleRate: number;
		numberOfChannels?: number | undefined;
		selected: number;
		onSettled?: (bitrate: number) => void;
		onNote?: (note: string) => void;
		isStale?: () => boolean;
	},
): number {
	const selected = effectiveBitrate(
		options.format,
		options.selected,
		options.sampleRate,
	);
	renderBitrateOptions(
		dropdown,
		getSupportedBitrates(options.format, options.sampleRate),
		selected,
	);
	// Before the encoder has been asked the note carries what the codec alone
	// settles, which is already the whole answer for every format but AAC.
	options.onNote?.(
		bitrateOfferNote(options.format, options.sampleRate, null),
	);

	const generation = (bitrateFillGeneration.get(dropdown.selectEl) ?? 0) + 1;
	bitrateFillGeneration.set(dropdown.selectEl, generation);
	void narrowToOfferedBitrates(dropdown, {
		format: options.format,
		sampleRate: options.sampleRate,
		numberOfChannels: options.numberOfChannels ?? STEREO_CHANNEL_COUNT,
		selected,
		generation,
		isStale: options.isStale ?? ((): boolean => false),
	})
		.then((narrowed) => {
			if (!narrowed) {
				return;
			}
			options.onNote?.(narrowed.note);
			if (narrowed.moved) {
				options.onSettled?.(narrowed.bitrate);
			}
		})
		.catch((error: unknown) => {
			// The probe answers rather than throws, so what reaches here is the
			// DOM work on a row being torn down. Reported, because an install
			// where this happens has no console to read an unhandled rejection
			// from and the row simply stops explaining itself.
			console.warn(
				`${PLUGIN_LOG_PREFIX} Could not re-offer the bitrates this device accepts:`,
				error,
			);
		});

	return selected;
}

/** A bitrate row a dialog can re-offer when its target format changes. */
export interface BitrateRow {
	/** The bitrate currently offered and selected. */
	readonly value: number;
	/**
	 * Re-offers the bitrates a target format reaches, hiding the row for a
	 * target that takes no bitrate at all, and reports a value the new list
	 * moved through the builder's own onChange.
	 *
	 * The layout is re-stated because it moves with the target: a dialog that
	 * switches to a mono conversion is asking the encoder a different question
	 * than the one the row was built with.
	 * @param format - The new target format
	 * @param numberOfChannels - Layout the new target will have
	 */
	rebuild(format: string, numberOfChannels?: number): void;
}

/**
 * Adds a bitrate dropdown listing the bitrates a target format reaches. The
 * dialogs pick a target after the row is drawn, so the row is returned rather
 * than only its value: a target the source format rules out, or one that
 * takes no bitrate at all, changes what the row must show.
 *
 * The rates are cut at the device's own rate, which is where a conversion
 * ends up rather than where it starts. Neither dialog states a sample rate,
 * so the streaming Conversion keeps the source track's own; mediabunny falls
 * back to 48 kHz stereo when the codec cannot be encoded at that rate, and
 * the last rung of the ladder decodes through an AudioContext, which
 * resamples to the device's rate. A row cut at the device's rate therefore
 * describes the rate every path that had to change the source's own converges
 * on, and the one path that keeps the source rate keeps a rate the encoder
 * already accepts.
 *
 * The plugin's default stands in only where there is no AudioContext, which is
 * also where no conversion can run. Either way the rate is above 32 kHz on any
 * real device, so MP3 stays held to the MPEG-1 table, and what the assumption
 * costs is a value withheld rather than one wrongly offered: a 22.05 kHz MP3
 * source is re-encoded at its own rate, where the MPEG-2 table reaches 24 kbps
 * that the row does not list.
 *
 * What it does not settle is the AAC probe, which is asked here about a rate
 * the source may not carry. Closing that means reading the container through
 * `probeAudioMetadata` and letting {@link BitrateRow.rebuild} take a rate as
 * well, which puts an asynchronous read in front of the first draw of the row.
 * That trade is still open.
 * @param containerEl - Container to render the setting into
 * @param options - Labels, target format, initial value, and change callback
 * @returns The row, carrying its effective value and a way to re-offer it
 */
export function addBitrateSetting(
	containerEl: HTMLElement,
	options: {
		desc: string;
		format: string;
		numberOfChannels?: number | undefined;
		initialBitrate: number;
		onChange: (bitrate: number) => void;
	},
): BitrateRow {
	const sampleRate = offlineEncodeSampleRate(DEFAULT_SAMPLE_RATE);
	let current = options.initialBitrate;
	let dropdown: DropdownComponent | null = null;

	/**
	 * Adopts a bitrate the row settled on and tells the dialog about it.
	 * @param bitrate - The value the row now shows
	 */
	const settle = (bitrate: number): void => {
		if (bitrate === current) {
			return;
		}
		current = bitrate;
		options.onChange(bitrate);
	};

	const setting = new Setting(containerEl)
		.setName('Bitrate')
		.setDesc(options.desc);
	/**
	 * Puts the row's own description back with the current note after it.
	 * @param note - What decided the list on offer
	 */
	const describe = (note: string): void => {
		setting.setDesc(`${options.desc} ${note}`);
	};

	/**
	 * Offers the rates one target format reaches, or hides the row when that
	 * target carries no bitrate at all.
	 *
	 * The first draw and every later target go through here, because whether
	 * the row applies and what it offers are one decision. Applied after the
	 * fill, as the first draw once did, a hidden row had already registered an
	 * encoder and probed it once per candidate rate, and the answer could
	 * still write the dialog's bitrate through the callback it left live.
	 * @param format - The target format to offer
	 * @param numberOfChannels - Layout that target will be written with
	 * @returns The bitrate now on offer, or the current one when it does not
	 *   apply
	 */
	const offer = (format: string, numberOfChannels?: number): number => {
		const applies = takesBitrate(format);
		setting.settingEl.toggle(applies);
		if (!dropdown || !applies) {
			return current;
		}
		return fillBitrateDropdown(dropdown, {
			format,
			sampleRate,
			numberOfChannels: numberOfChannels ?? options.numberOfChannels,
			selected: current,
			onSettled: settle,
			onNote: describe,
		});
	};

	setting.addDropdown((component) => {
		dropdown = component;
		// Adopted rather than settled: the dialog reads the value back off
		// the row it just built, so there is nobody to report a change to yet.
		current = offer(options.format);
		component.onChange((value) => {
			current = parseInt(value, 10);
			options.onChange(current);
		});
	});

	return {
		get value(): number {
			return current;
		},
		rebuild(format: string, numberOfChannels?: number): void {
			settle(offer(format, numberOfChannels));
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
