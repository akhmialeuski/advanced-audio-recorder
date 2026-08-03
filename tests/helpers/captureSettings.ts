/**
 * Shared Obsidian `Setting` test double that records each rendered row's name
 * and the value/disabled state of its toggle/text control. The global mock in
 * `tests/mocks/obsidian.ts` cannot be used for control-state assertions
 * because its builder methods never invoke the callback; this one does, so
 * tests can verify the disabled (dimmed) rendering of settings. It also records
 * each control's onChange handler and each button's click handler, so a test
 * can drive an edit through the production wiring - the half of a settings
 * section that rendering assertions alone never reach.
 * @module tests/helpers/captureSettings
 */

/** Captured state of a single toggle or text control. */
export interface CapturedControl {
	value: unknown;
	disabled: boolean;
	/**
	 * The control's input element, for the number-input rows that bind a real
	 * DOM `change` listener instead of the component's onChange. Absent for
	 * toggles, which have no element.
	 */
	inputEl?: HTMLInputElement | HTMLTextAreaElement;
}

/** Captured state of one rendered dropdown option. */
export interface CapturedDropdownOption {
	value: string;
	disabled: boolean;
}

/** A button captured from addButton/addExtraButton, with its click handler. */
export interface CapturedButton {
	/** Button text, or the icon name for an icon-only extra button. */
	label: string;
	/** Tooltip text, when the builder set one. */
	tooltip: string;
	disabled: boolean;
	click: () => unknown;
}

/**
 * The onChange handlers a row's controls registered, so a test can drive a
 * real edit through the production wiring instead of poking the settings
 * object directly. Capturing them is what makes the setter half of a section
 * testable: rendering alone only proves the rows exist.
 */
export interface CapturedChanges {
	toggle?: (value: boolean) => unknown;
	text?: (value: string) => unknown;
	dropdown?: (value: string) => unknown;
}

/** One rendered setting row captured through the Setting mock. */
export interface CapturedSetting {
	name: string;
	/** Description text passed to setDesc ('' when none or non-string). */
	desc: string;
	el: HTMLElement;
	toggle: CapturedControl | null;
	text: CapturedControl | null;
	dropdownOptions: CapturedDropdownOption[] | null;
	/** Value the dropdown was rendered with, or null when there is none. */
	dropdownValue: string | null;
	changes: CapturedChanges;
	buttons: CapturedButton[];
}

/** Rows captured by the mock, in render order. Clear it in `beforeEach`. */
export const capturedSettings: CapturedSetting[] = [];

/**
 * The named row, asserting it was rendered.
 * @param name - The setting row name (as passed to `setName`)
 * @returns The captured row
 * @throws If no row with that name was rendered
 */
export function settingRow(name: string): CapturedSetting {
	const row = capturedSettings.find((r) => r.name === name);
	if (!row) {
		throw new Error(
			`Setting row not rendered: ${name}. Rendered rows: ` +
				capturedSettings.map((r) => r.name).join(', '),
		);
	}
	return row;
}

/**
 * Whether the named row's toggle or text control was rendered disabled.
 * @param name - The setting row name (as passed to `setName`)
 * @throws If no row with that name was rendered
 */
export function isSettingDisabled(name: string): boolean {
	const row = settingRow(name);
	return Boolean(row.toggle?.disabled || row.text?.disabled);
}

/**
 * Drives the named row's control through the change handler the production
 * builder registered.
 * @param name - The setting row name
 * @param kind - Which control on the row to change
 * @param value - The new value the user would have entered
 * @returns Whatever the handler returned (a promise for async savers)
 * @throws If the row has no control of that kind
 */
export function changeSetting(
	name: string,
	kind: 'toggle',
	value: boolean,
): unknown;
export function changeSetting(
	name: string,
	kind: 'text' | 'dropdown',
	value: string,
): unknown;
export function changeSetting(
	name: string,
	kind: keyof CapturedChanges,
	value: boolean | string,
): unknown {
	const handler = settingRow(name).changes[kind];
	if (!handler) {
		throw new Error(`Setting row "${name}" has no ${kind} control`);
	}
	return (handler as (v: boolean | string) => unknown)(value);
}

/**
 * Enters a value into the named row's number input and commits it, the way a
 * user leaving the field does. Number rows bind a DOM `change` listener rather
 * than the component's onChange, so {@link changeSetting} cannot drive them.
 * @param name - The setting row name
 * @param value - The value typed into the field (as text, so out-of-range and
 *   non-numeric input can be exercised too)
 * @throws If the row has no text input
 */
export function enterNumberSetting(name: string, value: string): void {
	const inputEl = settingRow(name).text?.inputEl;
	if (!inputEl) {
		throw new Error(`Setting row "${name}" has no number input`);
	}
	inputEl.value = value;
	inputEl.dispatchEvent(new Event('change'));
}

/**
 * Clicks a button on the named row.
 * @param name - The setting row name
 * @param label - Button text, or the icon name for an icon-only button
 * @returns Whatever the click handler returned
 * @throws If the row has no such button
 */
export function clickSettingButton(name: string, label: string): unknown {
	const row = settingRow(name);
	const button = row.buttons.find((b) => b.label === label);
	if (!button) {
		throw new Error(
			`Setting row "${name}" has no button "${label}". Buttons: ` +
				row.buttons.map((b) => b.label).join(', '),
		);
	}
	return button.click();
}

/** Capturing replacement for Obsidian's `Setting` used via `jest.mock`. */
export class CapturingSetting {
	settingEl: HTMLElement;
	descEl: { createEl: () => unknown };
	private cap: CapturedSetting;

	constructor() {
		const el = document.createElement('div');
		(el as unknown as { addClass: (c: string) => void }).addClass = (c) =>
			el.classList.add(c);
		this.settingEl = el;
		this.descEl = { createEl: () => ({}) };
		this.cap = {
			name: '',
			desc: '',
			el,
			toggle: null,
			text: null,
			dropdownOptions: null,
			dropdownValue: null,
			changes: {},
			buttons: [],
		};
		capturedSettings.push(this.cap);
	}

	setName(name: string): this {
		this.cap.name = name;
		return this;
	}
	setDesc(desc?: unknown): this {
		this.cap.desc = typeof desc === 'string' ? desc : '';
		return this;
	}
	setHeading(): this {
		return this;
	}
	addToggle(callback: (toggle: unknown) => void): this {
		const cap = this.cap;
		const toggle = {
			value: false as unknown,
			disabled: false,
			setValue(v: unknown) {
				this.value = v;
				return this;
			},
			onChange(handler: (value: boolean) => unknown) {
				cap.changes.toggle = handler;
				return this;
			},
			setDisabled(d: boolean) {
				this.disabled = d;
				return this;
			},
		};
		callback(toggle);
		this.cap.toggle = { value: toggle.value, disabled: toggle.disabled };
		return this;
	}
	addText(callback: (text: unknown) => void): this {
		// A real input element so number-input controls can set type/min/max
		// and attach a change listener; addClass is the only Obsidian helper
		// the production code calls on it, so stub just that.
		const cap = this.cap;
		const inputEl = document.createElement('input') as HTMLInputElement & {
			addClass: (cls: string) => void;
		};
		inputEl.addClass = (cls: string): void => inputEl.classList.add(cls);
		const text = {
			value: '' as unknown,
			disabled: false,
			inputEl,
			setPlaceholder() {
				return this;
			},
			setValue(v: unknown) {
				this.value = v;
				inputEl.value = String(v);
				return this;
			},
			onChange(handler: (value: string) => unknown) {
				cap.changes.text = handler;
				return this;
			},
			setDisabled(d: boolean) {
				this.disabled = d;
				return this;
			},
		};
		callback(text);
		this.cap.text = {
			value: text.value,
			disabled: text.disabled,
			inputEl,
		};
		return this;
	}
	addTextArea(callback: (text: unknown) => void): this {
		// Mirrors addText but exposes a textarea inputEl so the production
		// builder can set `rows`; captures value/disabled the same way so the
		// dictionary row's dimmed state is assertable by name.
		const cap = this.cap;
		const inputEl = document.createElement(
			'textarea',
		) as HTMLTextAreaElement & {
			addClass: (cls: string) => void;
		};
		inputEl.addClass = (cls: string): void => inputEl.classList.add(cls);
		const text = {
			value: '' as unknown,
			disabled: false,
			inputEl,
			setPlaceholder() {
				return this;
			},
			setValue(v: unknown) {
				this.value = v;
				inputEl.value = String(v);
				return this;
			},
			onChange(handler: (value: string) => unknown) {
				cap.changes.text = handler;
				return this;
			},
			setDisabled(d: boolean) {
				this.disabled = d;
				return this;
			},
		};
		callback(text);
		this.cap.text = {
			value: text.value,
			disabled: text.disabled,
			inputEl,
		};
		return this;
	}
	addDropdown(callback: (dropdown: unknown) => void): this {
		// Mirrors DropdownComponent closely enough for per-option disabling:
		// addOption appends to selectEl.options, which the production code
		// mutates to block options unavailable on the platform.
		const cap = this.cap;
		const options: CapturedDropdownOption[] = [];
		const dropdown = {
			selectEl: { options },
			addOption(value: string) {
				options.push({ value, disabled: false });
				return this;
			},
			setValue(value: string) {
				cap.dropdownValue = value;
				return this;
			},
			setDisabled() {
				return this;
			},
			onChange(handler: (value: string) => unknown) {
				cap.changes.dropdown = handler;
				return this;
			},
		};
		callback(dropdown);
		this.cap.dropdownOptions = options;
		return this;
	}
	addSlider(callback: (slider: unknown) => void): this {
		const slider = {
			setLimits() {
				return this;
			},
			setValue() {
				return this;
			},
			setDynamicTooltip() {
				return this;
			},
			onChange() {
				return this;
			},
		};
		callback(slider);
		return this;
	}
	addButton(callback: (button: unknown) => void): this {
		const captured: CapturedButton = {
			label: '',
			tooltip: '',
			disabled: false,
			click: () => undefined,
		};
		const button = {
			setButtonText(text: string) {
				captured.label = text;
				return this;
			},
			setTooltip(text: string) {
				captured.tooltip = text;
				return this;
			},
			setCta() {
				return this;
			},
			setWarning() {
				return this;
			},
			setDisabled(disabled: boolean) {
				captured.disabled = disabled;
				return this;
			},
			onClick(handler: () => unknown) {
				captured.click = handler;
				return this;
			},
		};
		callback(button);
		this.cap.buttons.push(captured);
		return this;
	}
	addExtraButton(callback: (button: unknown) => void): this {
		// Icon-only action button (e.g. add/remove profile, reveal a secret).
		// The icon doubles as the button's label here, and it is re-read after
		// every setIcon, so a test can see a button that swaps its icon with
		// its state.
		const captured: CapturedButton = {
			label: '',
			tooltip: '',
			disabled: false,
			click: () => undefined,
		};
		const button = {
			setIcon(icon: string) {
				captured.label = icon;
				return this;
			},
			setTooltip(text: string) {
				captured.tooltip = text;
				return this;
			},
			setDisabled(disabled: boolean) {
				captured.disabled = disabled;
				return this;
			},
			onClick(handler: () => unknown) {
				captured.click = handler;
				return this;
			},
		};
		callback(button);
		this.cap.buttons.push(captured);
		return this;
	}
}
