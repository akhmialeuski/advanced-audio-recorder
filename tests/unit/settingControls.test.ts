/**
 * Unit tests for the shared setting-control builders, focused on the
 * disabled (dimmed) rendering used for options the current selection cannot
 * use - e.g. speaker diarization on an engine that cannot diarize. A disabled
 * control must both be non-interactive and visually greyed (a dim class on the
 * row), so the user can tell it is off because it is unavailable, not unset.
 * The capturing Setting mock is shared from tests/helpers/captureSettings.
 * @module tests/unit/settingControls.test
 */
/** @jest-environment jsdom */

import {
	addText,
	addToggle,
	SETTING_DISABLED_CLASS,
	type SettingsSectionContext,
} from '../../src/settings/settingControls';
import type { AudioRecorderSettings } from '../../src/settings/settingsSchema';
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

		const setting = capturedSettings[0];
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

		const setting = capturedSettings[0];
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

		const setting = capturedSettings[0];
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

		const setting = capturedSettings[0];
		expect(setting.el.classList.contains(SETTING_DISABLED_CLASS)).toBe(
			false,
		);
		expect(setting.text?.disabled).toBe(false);
		expect(setting.text?.value).toBe('**{speaker}**');
	});
});
