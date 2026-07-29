/**
 * Unit tests for the shared setting builders.
 * @module tests/unit/settingHelpers.test
 */

import {
	addBitrateSetting,
	addDeleteSourceSetting,
	addLinkActionSetting,
} from 'src/settings/settingControls';
import { at } from '../helpers/assertions';

/** Captured dropdowns and toggles rendered through the Setting mock. */
interface DropdownCapture {
	options: { value: string; label: string }[];
	value: string;
	onChange: (value: string) => void;
}
interface ToggleCapture {
	value: boolean;
	onChange: (value: boolean) => void;
}
const dropdowns: DropdownCapture[] = [];
const toggles: ToggleCapture[] = [];

jest.mock('obsidian', () => ({
	Setting: class {
		setName(): this {
			return this;
		}
		setDesc(): this {
			return this;
		}
		addDropdown(
			callback: (dropdown: {
				addOption: (value: string, label: string) => unknown;
				setValue: (value: string) => unknown;
				onChange: (handler: (value: string) => void) => unknown;
			}) => void,
		): this {
			const capture: DropdownCapture = {
				options: [],
				value: '',
				onChange: () => undefined,
			};
			const dropdown = {
				addOption(value: string, label: string) {
					capture.options.push({ value, label });
					return this;
				},
				setValue(value: string) {
					capture.value = value;
					return this;
				},
				onChange(handler: (value: string) => void) {
					capture.onChange = handler;
					return this;
				},
			};
			callback(dropdown);
			dropdowns.push(capture);
			return this;
		}
		addToggle(
			callback: (toggle: {
				setValue: (value: boolean) => unknown;
				onChange: (handler: (value: boolean) => void) => unknown;
			}) => void,
		): this {
			const capture: ToggleCapture = {
				value: false,
				onChange: () => undefined,
			};
			const toggle = {
				setValue(value: boolean) {
					capture.value = value;
					return this;
				},
				onChange(handler: (value: boolean) => void) {
					capture.onChange = handler;
					return this;
				},
			};
			callback(toggle);
			toggles.push(capture);
			return this;
		}
	},
}));

jest.mock('src/audio/AudioCapabilityDetector', () => ({
	getSupportedBitrates: jest
		.fn()
		.mockReturnValue([64000, 96000, 128000, 192000]),
}));

describe('settingHelpers', () => {
	let containerEl: HTMLElement;

	beforeEach(() => {
		jest.clearAllMocks();
		dropdowns.length = 0;
		toggles.length = 0;
		containerEl = document.createElement('div');
	});

	describe('addBitrateSetting', () => {
		it('should list supported bitrates with kbps labels', () => {
			addBitrateSetting(containerEl, {
				desc: 'Bitrate.',
				initialBitrate: 128000,
				onChange: jest.fn(),
			});

			expect(at(dropdowns, 0).options).toEqual([
				{ value: '64000', label: '64 kbps' },
				{ value: '96000', label: '96 kbps' },
				{ value: '128000', label: '128 kbps' },
				{ value: '192000', label: '192 kbps' },
			]);
			expect(at(dropdowns, 0).value).toBe('128000');
		});

		it('should snap an unsupported initial bitrate to the closest entry', () => {
			const effective = addBitrateSetting(containerEl, {
				desc: 'Bitrate.',
				initialBitrate: 100000,
				onChange: jest.fn(),
			});

			expect(effective).toBe(96000);
			expect(at(dropdowns, 0).value).toBe('96000');
		});

		it('should report numeric bitrate changes', () => {
			const onChange = jest.fn();
			addBitrateSetting(containerEl, {
				desc: 'Bitrate.',
				initialBitrate: 128000,
				onChange,
			});

			at(dropdowns, 0).onChange('192000');

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

			expect(at(toggles, 0).value).toBe(true);

			at(toggles, 0).onChange(false);
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
				at(dropdowns, 0).options.map((option) => option.value),
			).toEqual(['none', 'replace', 'after']);
			expect(at(dropdowns, 0).value).toBe('replace');

			at(dropdowns, 0).onChange('after');
			expect(onChange).toHaveBeenCalledWith('after');
		});
	});
});
