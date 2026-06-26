/**
 * Unit tests for the shared setting-control builders, focused on the
 * disabled (dimmed) rendering used for options the current selection cannot
 * use — e.g. speaker diarization on an engine that cannot diarize. A disabled
 * toggle must both be non-interactive and visually greyed (a dim class on the
 * row), so the user can tell it is off because it is unavailable, not unset.
 * @module tests/unit/settingControls.test
 */
/** @jest-environment jsdom */

import {
	addText,
	addToggle,
	SETTING_DISABLED_CLASS,
	type SettingsSectionContext,
} from '../../src/settings/settingControls';
import type { AudioRecorderSettings } from '../../src/settings/Settings';

/** One rendered setting captured through the Setting mock. */
interface SettingCapture {
	name: string;
	el: HTMLElement;
	toggle: { value: boolean; disabled: boolean } | null;
	text: { value: string; disabled: boolean } | null;
}
const captured: SettingCapture[] = [];

jest.mock('obsidian', () => ({
	Setting: class {
		settingEl: HTMLElement;
		private cap: SettingCapture;
		constructor(_containerEl: HTMLElement) {
			const el = document.createElement('div');
			(el as unknown as { addClass: (c: string) => void }).addClass = (
				c,
			) => el.classList.add(c);
			this.settingEl = el;
			this.cap = { name: '', el, toggle: null, text: null };
			captured.push(this.cap);
		}
		setName(name: string): this {
			this.cap.name = name;
			return this;
		}
		setDesc(): this {
			return this;
		}
		addText(
			callback: (text: {
				value: string;
				disabled: boolean;
				inputEl: { type: string };
				setValue: (v: string) => unknown;
				onChange: (h: (v: string) => void) => unknown;
				setDisabled: (d: boolean) => unknown;
			}) => void,
		): this {
			const text = {
				value: '',
				disabled: false,
				inputEl: { type: 'text' },
				setValue(v: string) {
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
			callback(text);
			this.cap.text = text;
			return this;
		}
		addToggle(
			callback: (toggle: {
				value: boolean;
				disabled: boolean;
				setValue: (v: boolean) => unknown;
				onChange: (h: (v: boolean) => void) => unknown;
				setDisabled: (d: boolean) => unknown;
			}) => void,
		): this {
			const toggle = {
				value: false,
				disabled: false,
				setValue(v: boolean) {
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
			this.cap.toggle = toggle;
			return this;
		}
	},
}));

/** Builds a section context whose hooks are spies. */
function makeCtx(): SettingsSectionContext {
	return {
		containerEl: document.createElement('div'),
		settings: {} as AudioRecorderSettings,
		save: jest.fn().mockResolvedValue(undefined),
		rerender: jest.fn(),
		saveDebounced: jest.fn(),
	};
}

describe('addToggle disabled rendering', () => {
	beforeEach(() => {
		captured.length = 0;
	});

	it('dims the row and disables the toggle when disabled', () => {
		addToggle(makeCtx(), {
			name: 'Speaker diarization',
			get: () => false,
			set: () => undefined,
			disabled: true,
		});

		const setting = captured[0];
		expect(setting.el.classList.contains(SETTING_DISABLED_CLASS)).toBe(
			true,
		);
		expect(setting.toggle?.disabled).toBe(true);
	});

	it('leaves an enabled toggle interactive and undimmed', () => {
		addToggle(makeCtx(), {
			name: 'Speaker diarization',
			get: () => true,
			set: () => undefined,
		});

		const setting = captured[0];
		expect(setting.el.classList.contains(SETTING_DISABLED_CLASS)).toBe(
			false,
		);
		expect(setting.toggle?.disabled).toBe(false);
		expect(setting.toggle?.value).toBe(true);
	});
});

describe('addText disabled rendering', () => {
	beforeEach(() => {
		captured.length = 0;
	});

	it('dims the row and disables the input when disabled', () => {
		addText(makeCtx(), {
			name: 'Speaker format',
			get: () => '**{speaker}**',
			set: () => undefined,
			disabled: true,
		});

		const setting = captured[0];
		expect(setting.el.classList.contains(SETTING_DISABLED_CLASS)).toBe(
			true,
		);
		expect(setting.text?.disabled).toBe(true);
	});

	it('leaves an enabled input interactive and undimmed', () => {
		addText(makeCtx(), {
			name: 'Speaker format',
			get: () => '**{speaker}**',
			set: () => undefined,
		});

		const setting = captured[0];
		expect(setting.el.classList.contains(SETTING_DISABLED_CLASS)).toBe(
			false,
		);
		expect(setting.text?.disabled).toBe(false);
		expect(setting.text?.value).toBe('**{speaker}**');
	});
});
