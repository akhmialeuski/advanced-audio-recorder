/**
 * Tests the model picker control: a dropdown that lists the saved models
 * (always including the current selection), a docs link in the description,
 * and an add/remove row that edits the saved list and re-renders. This is the
 * "pick from a list, add your own, with a link to the catalog" UI requested
 * for each engine.
 * @module tests/unit/addModelPicker.test
 */
/** @jest-environment jsdom */

import {
	addModelPicker,
	type SettingsSectionContext,
} from '../../src/settings/settingControls';
import type { AudioRecorderSettings } from '../../src/settings/Settings';

interface DropdownCapture {
	options: { value: string; label: string }[];
	value: string;
	onChange: (value: string) => void | Promise<void>;
}
interface TextCapture {
	placeholder: string;
	onChange: (value: string) => void;
}
interface ButtonCapture {
	text: string;
	disabled: boolean;
	onClick: () => void | Promise<void>;
}
interface SettingCapture {
	name: string;
	descEl: HTMLElement;
	dropdown: DropdownCapture | null;
	texts: TextCapture[];
	buttons: ButtonCapture[];
}
const rendered: SettingCapture[] = [];

/** A div with the minimal Obsidian createEl helper used by appendHelpLink. */
function makeDescEl(): HTMLElement {
	const el = document.createElement('div');
	(
		el as unknown as {
			createEl: (
				tag: string,
				opts?: {
					text?: string;
					cls?: string;
					attr?: Record<string, string>;
				},
			) => HTMLElement;
		}
	).createEl = (tag, opts = {}) => {
		const child = document.createElement(tag);
		if (opts.text) child.textContent = opts.text;
		if (opts.cls) child.classList.add(opts.cls);
		if (opts.attr) {
			for (const [k, v] of Object.entries(opts.attr)) {
				child.setAttribute(k, v);
			}
		}
		el.appendChild(child);
		return child;
	};
	return el;
}

jest.mock('obsidian', () => ({
	Setting: class {
		descEl: HTMLElement = makeDescEl();
		settingEl: HTMLElement = document.createElement('div');
		private cap: SettingCapture;
		constructor() {
			this.cap = {
				name: '',
				descEl: this.descEl,
				dropdown: null,
				texts: [],
				buttons: [],
			};
			rendered.push(this.cap);
		}
		setName(name: string): this {
			this.cap.name = name;
			return this;
		}
		setDesc(): this {
			return this;
		}
		addDropdown(cb: (d: unknown) => void): this {
			const capture: DropdownCapture = {
				options: [],
				value: '',
				onChange: () => undefined,
			};
			const dropdown = {
				addOption(value: string, label: string) {
					capture.options.push({ value, label });
					return dropdown;
				},
				setValue(value: string) {
					capture.value = value;
					return dropdown;
				},
				onChange(handler: (value: string) => void) {
					capture.onChange = handler;
					return dropdown;
				},
			};
			cb(dropdown);
			this.cap.dropdown = capture;
			return this;
		}
		addText(cb: (t: unknown) => void): this {
			const capture: TextCapture = {
				placeholder: '',
				onChange: () => undefined,
			};
			const text = {
				inputEl: document.createElement('input'),
				setPlaceholder(p: string) {
					capture.placeholder = p;
					return text;
				},
				setValue() {
					return text;
				},
				onChange(handler: (value: string) => void) {
					capture.onChange = handler;
					return text;
				},
			};
			cb(text);
			this.cap.texts.push(capture);
			return this;
		}
		addButton(cb: (b: unknown) => void): this {
			const capture: ButtonCapture = {
				text: '',
				disabled: false,
				onClick: () => undefined,
			};
			const button = {
				setButtonText(t: string) {
					capture.text = t;
					return button;
				},
				setDisabled(d: boolean) {
					capture.disabled = d;
					return button;
				},
				onClick(handler: () => void) {
					capture.onClick = handler;
					return button;
				},
			};
			cb(button);
			this.cap.buttons.push(capture);
			return this;
		}
	},
}));

/** State + spies shared by a single picker render. */
function setup(models: string[], selected: string) {
	const state = { models: [...models], selected };
	const ctx: SettingsSectionContext = {
		containerEl: document.createElement('div'),
		settings: {} as AudioRecorderSettings,
		save: jest.fn().mockResolvedValue(undefined),
		rerender: jest.fn(),
		saveDebounced: jest.fn(),
	};
	addModelPicker(ctx, {
		name: 'Deepgram model',
		desc: 'Pick a model.',
		helpLink: {
			label: 'Deepgram model list',
			url: 'https://docs.test/model',
		},
		getModels: () => state.models,
		setModels: (m) => (state.models = m),
		getSelected: () => state.selected,
		setSelected: (id) => (state.selected = id),
	});
	return { state, ctx, picker: rendered[0], addRow: rendered[1] };
}

describe('addModelPicker', () => {
	beforeEach(() => {
		rendered.length = 0;
	});

	it('lists the saved models and shows the selected value', () => {
		const { picker } = setup(['nova-3', 'nova-2'], 'nova-2');
		expect(picker.dropdown?.options).toEqual([
			{ value: 'nova-3', label: 'nova-3' },
			{ value: 'nova-2', label: 'nova-2' },
		]);
		expect(picker.dropdown?.value).toBe('nova-2');
	});

	it('renders a docs link to the model catalog', () => {
		const { picker } = setup(['nova-3'], 'nova-3');
		const link = picker.descEl.querySelector('a');
		expect(link?.getAttribute('href')).toBe('https://docs.test/model');
		expect(link?.textContent).toBe('Deepgram model list');
	});

	it('always includes a custom selected id not in the saved list', () => {
		const { picker } = setup(['nova-3'], 'my-custom-model');
		expect(picker.dropdown?.options.map((o) => o.value)).toEqual([
			'my-custom-model',
			'nova-3',
		]);
		expect(picker.dropdown?.value).toBe('my-custom-model');
	});

	it('selects a model and saves on dropdown change', async () => {
		const { state, ctx, picker } = setup(['nova-3', 'nova-2'], 'nova-3');
		await picker.dropdown?.onChange('nova-2');
		expect(state.selected).toBe('nova-2');
		expect(ctx.save).toHaveBeenCalled();
	});

	it('adds a typed custom model, selects it, and re-renders', async () => {
		const { state, ctx, addRow } = setup(['nova-3'], 'nova-3');
		addRow.texts[0].onChange('  my-model ');
		await addRow.buttons[0].onClick(); // "Add"
		expect(state.models).toEqual(['nova-3', 'my-model']);
		expect(state.selected).toBe('my-model');
		expect(ctx.save).toHaveBeenCalled();
		expect(ctx.rerender).toHaveBeenCalled();
	});

	it('does not add an empty model id', async () => {
		const { state, addRow } = setup(['nova-3'], 'nova-3');
		addRow.texts[0].onChange('   ');
		await addRow.buttons[0].onClick();
		expect(state.models).toEqual(['nova-3']);
	});

	it('removes the selected model and falls back to the first remaining', async () => {
		const { state, addRow } = setup(['nova-3', 'nova-2'], 'nova-2');
		await addRow.buttons[1].onClick(); // "Remove selected"
		expect(state.models).toEqual(['nova-3']);
		expect(state.selected).toBe('nova-3');
	});

	it('disables remove when only one model remains', () => {
		const { addRow } = setup(['nova-3'], 'nova-3');
		expect(addRow.buttons[1].text).toBe('Remove selected');
		expect(addRow.buttons[1].disabled).toBe(true);
	});

	it('persists a fallback selection when the stored model id is empty', () => {
		const { state, ctx } = setup(['nova-3', 'nova-2'], '');
		expect(state.selected).toBe('nova-3');
		expect(ctx.save).toHaveBeenCalled();
	});

	it('normalizes a whitespace-padded stored model id', () => {
		const { state } = setup(['nova-3'], '  nova-3  ');
		expect(state.selected).toBe('nova-3');
	});
});
