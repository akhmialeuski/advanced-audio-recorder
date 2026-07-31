/**
 * Unit tests for the pre-1.13 renderer: the same definition tree Obsidian 1.13
 * renders natively has to reach the screen, and behave, on the Obsidian that
 * has no declarative settings API.
 * @module tests/unit/legacySettingsRenderer.test
 */

import type { SettingDefinitionItem } from 'obsidian';
import { at } from '../helpers/assertions';
import {
	LEGACY_ACTION_ROW_CLASS,
	LegacySettingsRenderer,
	type LegacySettingsHost,
} from 'src/settings/legacySettingsRenderer';

describe('LegacySettingsRenderer', () => {
	let values: Record<string, unknown>;
	let setControlValue: jest.Mock;
	let host: LegacySettingsHost;
	let renderer: LegacySettingsRenderer;
	let containerEl: HTMLElement;

	beforeEach(() => {
		values = { debug: false, filePrefix: 'recording', splitMinutes: 10 };
		setControlValue = jest.fn((key: string, value: unknown) => {
			values[key] = value;
		});
		host = {
			getControlValue: (key: string): unknown => values[key],
			setControlValue,
		};
		renderer = new LegacySettingsRenderer(host);
		containerEl = createDiv();
	});

	/** Names of the rows rendered into the container, in order. */
	const renderedNames = (): string[] =>
		Array.from(containerEl.querySelectorAll('.setting-item-name'))
			.map((el) => el.textContent ?? '')
			.filter((name) => name.length > 0);

	/** The row carrying a given setting name. */
	const rowFor = (name: string): HTMLElement => {
		const row = Array.from(
			containerEl.querySelectorAll('.setting-item'),
		).find(
			(el) =>
				el.querySelector('.setting-item-name')?.textContent === name,
		);
		if (!row) {
			throw new Error(`Row not rendered: ${name}`);
		}
		return row as HTMLElement;
	};

	describe('structure', () => {
		it('renders a group as its heading followed by its rows', () => {
			renderer.render(containerEl, [
				{
					type: 'group',
					heading: 'Diagnostics',
					items: [
						{
							name: 'Debug mode',
							control: { type: 'toggle', key: 'debug' },
						},
					],
				},
			]);

			expect(renderedNames()).toEqual(['Diagnostics', 'Debug mode']);
		});

		it('flattens a sub-page into a heading, since this Obsidian has none', () => {
			renderer.render(containerEl, [
				{
					type: 'page',
					name: 'Transcription',
					items: [
						{
							name: 'Enable transcription',
							control: {
								type: 'toggle',
								key: 'transcriptionEnabled',
							},
						},
					],
				},
			]);

			expect(renderedNames()).toEqual([
				'Transcription',
				'Enable transcription',
			]);
		});

		it('clears the container before rendering again', () => {
			const definitions: SettingDefinitionItem[] = [
				{
					name: 'Debug mode',
					control: { type: 'toggle', key: 'debug' },
				},
			];

			renderer.render(containerEl, definitions);
			renderer.render(containerEl, definitions);

			expect(renderedNames()).toEqual(['Debug mode']);
		});
	});

	describe('controls', () => {
		it('shows the stored value and writes a toggle back through the host', () => {
			values['debug'] = true;
			renderer.render(containerEl, [
				{
					name: 'Debug mode',
					control: { type: 'toggle', key: 'debug' },
				},
			]);

			const toggle = rowFor('Debug mode').querySelector<HTMLElement>(
				'.checkbox-container',
			);
			toggle?.click();

			expect(setControlValue).toHaveBeenCalledWith('debug', false);
		});

		it('writes a dropdown selection back through the host', () => {
			values['mode'] = 'single';
			renderer.render(containerEl, [
				{
					name: 'Output mode',
					control: {
						type: 'dropdown',
						key: 'mode',
						options: {
							single: 'Single file',
							multiple: 'Multiple',
						},
					},
				},
			]);

			const select = rowFor('Output mode').querySelector('select');
			if (!select) {
				throw new Error('No dropdown rendered');
			}
			expect(select.value).toBe('single');
			select.value = 'multiple';
			select.dispatchEvent(new Event('change'));

			expect(setControlValue).toHaveBeenCalledWith('mode', 'multiple');
		});

		it('writes a text value back through the host', () => {
			renderer.render(containerEl, [
				{
					name: 'File prefix',
					control: { type: 'text', key: 'filePrefix' },
				},
			]);

			const input = rowFor('File prefix').querySelector('input');
			if (!input) {
				throw new Error('No text input rendered');
			}
			expect(input.value).toBe('recording');
			input.value = 'meeting';
			input.dispatchEvent(new Event('input'));

			expect(setControlValue).toHaveBeenCalledWith(
				'filePrefix',
				'meeting',
			);
		});

		it('rejects a text value its validator refuses, and marks the field', () => {
			renderer.render(containerEl, [
				{
					name: 'Part name suffix',
					control: {
						type: 'text',
						key: 'suffix',
						validate: (value: string) =>
							/^[\w-]*$/.test(value)
								? undefined
								: 'Letters, digits, hyphens and underscores only.',
					},
				},
			]);

			const input = rowFor('Part name suffix').querySelector('input');
			if (!input) {
				throw new Error('No text input rendered');
			}
			input.value = 'bad suffix';
			input.dispatchEvent(new Event('input'));

			expect(setControlValue).not.toHaveBeenCalled();
			expect(input.classList.contains('aar-input-invalid')).toBe(true);
		});

		it('rejects a number outside the control bounds', () => {
			renderer.render(containerEl, [
				{
					name: 'Part duration',
					control: {
						type: 'number',
						key: 'splitMinutes',
						min: 1,
						max: 60,
					},
				},
			]);

			const input = rowFor('Part duration').querySelector('input');
			if (!input) {
				throw new Error('No number input rendered');
			}
			expect(input.value).toBe('10');
			input.value = '120';
			input.dispatchEvent(new Event('change'));
			expect(setControlValue).not.toHaveBeenCalled();

			input.value = '20';
			input.dispatchEvent(new Event('change'));
			expect(setControlValue).toHaveBeenCalledWith('splitMinutes', 20);
		});
	});

	describe('predicates', () => {
		const revealTree = (): SettingDefinitionItem[] => [
			{
				name: 'Enhanced audio player',
				control: { type: 'toggle', key: 'player' },
			},
			{
				name: 'Show waveform',
				visible: () => values['player'] === true,
				control: { type: 'toggle', key: 'waveform' },
			},
		];

		it('leaves a row hidden while its visible predicate is false', () => {
			values['player'] = false;
			renderer.render(containerEl, revealTree());

			expect(rowFor('Show waveform').style.display).toBe('none');
		});

		it('reveals the row when the setting it depends on changes', () => {
			// The framework re-evaluates predicates after every change it
			// persists; without doing the same here, the revealed row would only
			// appear after the tab was reopened.
			values['player'] = false;
			renderer.render(containerEl, revealTree());

			rowFor('Enhanced audio player')
				.querySelector<HTMLElement>('.checkbox-container')
				?.click();

			expect(rowFor('Show waveform').style.display).toBe('');
		});

		it('disables a control whose disabled predicate holds', () => {
			renderer.render(containerEl, [
				{
					name: 'Speaker diarization',
					control: {
						type: 'toggle',
						key: 'diarize',
						disabled: () => true,
					},
				},
			]);

			const toggle = rowFor(
				'Speaker diarization',
			).querySelector<HTMLElement>('.checkbox-container');
			toggle?.click();

			expect(setControlValue).not.toHaveBeenCalled();
		});
	});

	describe('action rows', () => {
		it('runs the action when the row is clicked', () => {
			const action = jest.fn();
			renderer.render(containerEl, [{ name: 'System info', action }]);

			const row = rowFor('System info');
			expect(row.classList.contains(LEGACY_ACTION_ROW_CLASS)).toBe(true);
			row.click();

			expect(action).toHaveBeenCalledTimes(1);
			expect(action).toHaveBeenCalledWith(row, 0);
		});
	});

	describe('render rows', () => {
		it('hands the definition the row it would get from the framework', () => {
			const render = jest.fn((setting: { settingEl: HTMLElement }) => {
				setting.settingEl.createDiv({ cls: 'aar-custom' });
			});

			renderer.render(containerEl, [{ name: 'Test recording', render }]);

			expect(render).toHaveBeenCalledTimes(1);
			expect(
				rowFor('Test recording').querySelector('.aar-custom'),
			).not.toBeNull();
		});

		it('runs the cleanup it returned before rendering again', () => {
			const cleanup = jest.fn();
			const definitions: SettingDefinitionItem[] = [
				{
					name: 'Test recording',
					render: () => cleanup,
				},
			];

			renderer.render(containerEl, definitions);
			expect(cleanup).not.toHaveBeenCalled();

			renderer.render(containerEl, definitions);

			expect(cleanup).toHaveBeenCalledTimes(1);
		});

		it('runs the cleanup when the renderer is released', () => {
			const cleanup = jest.fn();
			renderer.render(containerEl, [
				{
					name: 'Test recording',
					render: () => cleanup,
				},
			]);

			renderer.release();
			renderer.release();

			// Released once, no matter how often the tab is left and re-entered.
			expect(cleanup).toHaveBeenCalledTimes(1);
		});

		it('keeps rendering the rest when one cleanup throws', () => {
			const cleanup = jest.fn(() => {
				throw new Error('cleanup failed');
			});
			jest.spyOn(console, 'error').mockImplementation(() => undefined);
			renderer.render(containerEl, [
				{
					name: 'Test recording',
					render: () => cleanup,
				},
			]);

			renderer.render(containerEl, [
				{
					name: 'Debug mode',
					control: { type: 'toggle', key: 'debug' },
				},
			]);

			expect(at(renderedNames(), 0)).toBe('Debug mode');
		});
	});
});
