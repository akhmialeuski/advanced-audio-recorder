/**
 * Shared Obsidian `Setting` test double that records each rendered row's name
 * and the value/disabled state of its toggle/text control. The global mock in
 * `tests/mocks/obsidian.ts` cannot be used for control-state assertions
 * because its builder methods never invoke the callback; this one does, so
 * tests can verify the disabled (dimmed) rendering of settings. Dropdown,
 * slider, and button builders are chainable no-ops - enough to render whole
 * sections (e.g. the model picker) without capturing their state.
 * @module tests/helpers/captureSettings
 */

/** Captured state of a single toggle or text control. */
export interface CapturedControl {
	value: unknown;
	disabled: boolean;
}

/** Captured state of one rendered dropdown option. */
export interface CapturedDropdownOption {
	value: string;
	disabled: boolean;
}

/** One rendered setting row captured through the Setting mock. */
export interface CapturedSetting {
	name: string;
	el: HTMLElement;
	toggle: CapturedControl | null;
	text: CapturedControl | null;
	dropdownOptions: CapturedDropdownOption[] | null;
}

/** Rows captured by the mock, in render order. Clear it in `beforeEach`. */
export const capturedSettings: CapturedSetting[] = [];

/**
 * Whether the named row's toggle or text control was rendered disabled.
 * @param name - The setting row name (as passed to `setName`)
 * @throws If no row with that name was rendered
 */
export function isSettingDisabled(name: string): boolean {
	const row = capturedSettings.find((r) => r.name === name);
	if (!row) {
		throw new Error(`Setting row not rendered: ${name}`);
	}
	return Boolean(row.toggle?.disabled || row.text?.disabled);
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
			el,
			toggle: null,
			text: null,
			dropdownOptions: null,
		};
		capturedSettings.push(this.cap);
	}

	setName(name: string): this {
		this.cap.name = name;
		return this;
	}
	setDesc(): this {
		return this;
	}
	setHeading(): this {
		return this;
	}
	addToggle(callback: (toggle: unknown) => void): this {
		const toggle = {
			value: false as unknown,
			disabled: false,
			setValue(v: unknown) {
				this.value = v;
				return this;
			},
			onChange() {
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
			onChange() {
				return this;
			},
			setDisabled(d: boolean) {
				this.disabled = d;
				return this;
			},
		};
		callback(text);
		this.cap.text = { value: text.value, disabled: text.disabled };
		return this;
	}
	addDropdown(callback: (dropdown: unknown) => void): this {
		// Mirrors DropdownComponent closely enough for per-option disabling:
		// addOption appends to selectEl.options, which the production code
		// mutates to block options unavailable on the platform.
		const options: CapturedDropdownOption[] = [];
		const dropdown = {
			selectEl: { options },
			addOption(value: string) {
				options.push({ value, disabled: false });
				return this;
			},
			setValue() {
				return this;
			},
			setDisabled() {
				return this;
			},
			onChange() {
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
		const button = {
			setButtonText() {
				return this;
			},
			setDisabled() {
				return this;
			},
			onClick() {
				return this;
			},
		};
		callback(button);
		return this;
	}
}
