/**
 * Unit tests for the shared setting-control builders, focused on the
 * disabled (dimmed) rendering used for options the current selection cannot
 * use - e.g. speaker diarization on an engine that cannot diarize. A disabled
 * control must both be non-interactive and visually greyed (a dim class on the
 * row), so the user can tell it is off because it is unavailable, not unset.
 * The capturing Setting mock is shared from tests/helpers/captureSettings.
 * @module tests/unit/settingControls.test
 */

import { Setting } from 'obsidian';
import { at } from '../helpers/assertions';
import {
	addDropdown,
	addNumberInputTo,
	addText,
	addToggle,
	SETTING_DISABLED_CLASS,
	type SettingsSectionContext,
} from 'src/settings/settingControls';
import type { AudioRecorderSettings } from 'src/settings/settingsSchema';
import { capturedSettings } from '../helpers/captureSettings';

jest.mock('obsidian', () => ({
	Setting: jest.requireActual<typeof import('../helpers/captureSettings')>(
		'../helpers/captureSettings',
	).CapturingSetting,
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
		capturedSettings.length = 0;
	});

	it('dims the row and disables the toggle when disabled', () => {
		addToggle(makeCtx(), {
			name: 'Speaker diarization',
			get: () => false,
			set: () => undefined,
			disabled: true,
		});

		const setting = at(capturedSettings, 0);
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

		const setting = at(capturedSettings, 0);
		expect(setting.el.classList.contains(SETTING_DISABLED_CLASS)).toBe(
			false,
		);
		expect(setting.toggle?.disabled).toBe(false);
		expect(setting.toggle?.value).toBe(true);
	});
});

describe('addText disabled rendering', () => {
	beforeEach(() => {
		capturedSettings.length = 0;
	});

	it('dims the row and disables the input when disabled', () => {
		addText(makeCtx(), {
			name: 'Speaker format',
			get: () => '**{speaker}**',
			set: () => undefined,
			disabled: true,
		});

		const setting = at(capturedSettings, 0);
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

		const setting = at(capturedSettings, 0);
		expect(setting.el.classList.contains(SETTING_DISABLED_CLASS)).toBe(
			false,
		);
		expect(setting.text?.disabled).toBe(false);
		expect(setting.text?.value).toBe('**{speaker}**');
	});
});

describe('addDropdown blocked options', () => {
	beforeEach(() => {
		capturedSettings.length = 0;
	});

	it('renders options marked disabled as blocked, the rest selectable', () => {
		addDropdown(makeCtx(), {
			name: 'Engine',
			options: [
				{ value: 'cloud', label: 'Cloud' },
				{ value: 'local', label: 'Local', disabled: true },
			],
			get: () => 'cloud',
			set: () => undefined,
		});

		const options = at(capturedSettings, 0).dropdownOptions ?? [];
		expect(options).toEqual([
			{ value: 'cloud', disabled: false },
			{ value: 'local', disabled: true },
		]);
	});

	it('leaves options without the flag selectable', () => {
		addDropdown(makeCtx(), {
			name: 'Engine',
			options: [
				{ value: 'a', label: 'A' },
				{ value: 'b', label: 'B' },
			],
			get: () => 'a',
			set: () => undefined,
		});

		const options = at(capturedSettings, 0).dropdownOptions ?? [];
		expect(options.every((option) => !option.disabled)).toBe(true);
	});
});

describe('addNumberInputTo', () => {
	beforeEach(() => {
		capturedSettings.length = 0;
	});

	function build(
		overrides: Partial<{
			min: number;
			max: number;
			step: number;
			get: () => number;
		}> = {},
	): { input: HTMLInputElement; set: jest.Mock } {
		const set = jest.fn();
		const component = addNumberInputTo(
			new Setting(document.createElement('div')),
			{ min: 0, max: 100, step: 5, get: () => 20, set, ...overrides },
		);
		return { input: component.inputEl, set };
	}

	function commit(input: HTMLInputElement, value: string): void {
		input.value = value;
		input.dispatchEvent(new Event('change'));
	}

	it('renders a number input seeded with the current value and bounds', () => {
		const { input } = build();

		expect(input.type).toBe('number');
		expect(input.value).toBe('20');
		expect(input.min).toBe('0');
		expect(input.max).toBe('100');
		expect(input.step).toBe('5');
	});

	it('clamps a value above the max and writes it back', () => {
		const { input, set } = build();

		commit(input, '250');

		expect(set).toHaveBeenLastCalledWith(100);
		expect(input.value).toBe('100');
	});

	it('clamps a value below the min', () => {
		const { input, set } = build({ min: 1 });

		commit(input, '-5');

		expect(set).toHaveBeenLastCalledWith(1);
	});

	it('snaps an off-step value to the nearest step', () => {
		const { input, set } = build();

		commit(input, '23');

		expect(set).toHaveBeenLastCalledWith(25);
	});

	it('falls back to the current value when the field is empty or not a number', () => {
		const { input, set } = build({ get: () => 20 });

		commit(input, '');
		expect(set).toHaveBeenLastCalledWith(20);

		commit(input, 'abc');
		expect(set).toHaveBeenLastCalledWith(20);
	});

	it('keeps an off-grid max within bounds so snapping cannot exceed it', () => {
		// Max output tokens: the last step-512 grid point above 512 is 32256,
		// so a naive clamp-then-snap would persist 32256 for an entry of 32000.
		const { input, set } = build({
			min: 512,
			max: 32000,
			step: 512,
			get: () => 4096,
		});

		commit(input, '32000');

		expect(set).toHaveBeenLastCalledWith(32000);
		expect(Number(input.value)).toBeLessThanOrEqual(32000);
	});
});
