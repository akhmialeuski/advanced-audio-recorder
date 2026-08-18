/**
 * Unit tests for the shared setting builders.
 * @module tests/unit/dialogSettingControls.test
 */

import {
	addBitrateSetting,
	addDeleteSourceSetting,
	addLinkActionSetting,
} from 'src/settings/settingControls';
import { at } from '../helpers/assertions';
import { capturedSettings } from '../helpers/captureSettings';
import type { CapturedSetting } from '../helpers/captureSettings';

// The full obsidian mock with only Setting swapped for the recording double.
jest.mock('obsidian', () =>
	require('../mocks/modules/obsidianWithCapturingSetting'),
);

jest.mock('src/audio/AudioCapabilityDetector', () => ({
	getSupportedBitrates: jest
		.fn()
		.mockReturnValue([64000, 96000, 128000, 192000]),
}));

describe('dialog setting builders', () => {
	let containerEl: HTMLElement;

	beforeEach(() => {
		capturedSettings.length = 0;
		containerEl = document.createElement('div');
	});

	/**
	 * The single row these builders render.
	 * @returns The captured row
	 */
	function row(): CapturedSetting {
		return at(capturedSettings, 0);
	}

	describe('addBitrateSetting', () => {
		it('should list supported bitrates with kbps labels', () => {
			addBitrateSetting(containerEl, {
				desc: 'Bitrate.',
				initialBitrate: 128000,
				onChange: jest.fn(),
			});

			expect(
				(row().dropdownOptions ?? []).map(({ value, label }) => ({
					value,
					label,
				})),
			).toEqual([
				{ value: '64000', label: '64 kbps' },
				{ value: '96000', label: '96 kbps' },
				{ value: '128000', label: '128 kbps' },
				{ value: '192000', label: '192 kbps' },
			]);
			expect(row().dropdownValue).toBe('128000');
		});

		it('should snap an unsupported initial bitrate to the closest entry', () => {
			const effective = addBitrateSetting(containerEl, {
				desc: 'Bitrate.',
				initialBitrate: 100000,
				onChange: jest.fn(),
			});

			expect(effective).toBe(96000);
			expect(row().dropdownValue).toBe('96000');
		});

		it('should report numeric bitrate changes', () => {
			const onChange = jest.fn();
			addBitrateSetting(containerEl, {
				desc: 'Bitrate.',
				initialBitrate: 128000,
				onChange,
			});

			row().changes.dropdown?.('192000');

			expect(onChange).toHaveBeenCalledWith(192000);
		});
	});

	describe('addDeleteSourceSetting', () => {
		it('should render the initial value and forward changes', () => {
			const onChange = jest.fn();
			addDeleteSourceSetting(containerEl, {
				desc: 'Delete.',
				initialValue: true,
				onChange,
			});

			expect(row().toggle?.value).toBe(true);

			row().changes.toggle?.(false);
			expect(onChange).toHaveBeenCalledWith(false);
		});
	});

	describe('addLinkActionSetting', () => {
		it('should render the three link actions and forward changes', () => {
			const onChange = jest.fn();
			addLinkActionSetting(containerEl, {
				desc: 'Links.',
				initialValue: 'replace',
				onChange,
			});

			expect(
				(row().dropdownOptions ?? []).map((option) => option.value),
			).toEqual(['none', 'replace', 'after']);
			expect(row().dropdownValue).toBe('replace');

			row().changes.dropdown?.('after');
			expect(onChange).toHaveBeenCalledWith('after');
		});
	});
});
