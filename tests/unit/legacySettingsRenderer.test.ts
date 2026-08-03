/**
 * Unit tests for the pre-1.13 renderer: the same definition tree Obsidian 1.13
 * renders natively has to reach the screen, and behave, on the Obsidian that
 * has no declarative settings API.
 * @module tests/unit/legacySettingsRenderer.test
 */

import type { SettingDefinitionItem } from 'obsidian';
import { at } from '../helpers/assertions';
import {
	LLM_MAX_TOKENS_STEP,
	MAX_LLM_MAX_TOKENS,
	MIN_LLM_MAX_TOKENS,
} from 'src/constants';
import {
	LEGACY_ACTION_ROW_CLASS,
	LEGACY_STACKED_CLASS,
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

		it('stacks a text area, which the old layout would leave unusable', () => {
			values['terms'] = 'kubectl, Kubernetes';
			renderer.render(containerEl, [
				{
					name: 'Terms',
					control: { type: 'textarea', key: 'terms', rows: 8 },
				},
			]);

			const row = rowFor('Terms');
			const textarea = row.querySelector('textarea');
			expect(textarea?.value).toBe('kubectl, Kubernetes');
			expect(textarea?.rows).toBe(8);
			// From 1.13 the framework lays a text area out full width under its
			// name. The older stylesheets put every control in the narrow right
			// column, which cannot hold a multi-sentence prompt.
			expect(row.classList.contains(LEGACY_STACKED_CLASS)).toBe(true);
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

		it('accepts and refuses exactly what the declared grid does', () => {
			// The tree is one description of the settings, so the Obsidian
			// without a declarative API has to accept the same values the one
			// with it accepts: the bounds and the grid between them.
			values['cutoffHz'] = 100;
			renderer.render(containerEl, [
				{
					name: 'High-pass cutoff',
					control: {
						type: 'number',
						key: 'cutoffHz',
						min: 20,
						max: 300,
						step: 5,
					},
				},
			]);

			const input = rowFor('High-pass cutoff').querySelector('input');
			if (!input) {
				throw new Error('No number input rendered');
			}
			input.value = '137';
			input.dispatchEvent(new Event('change'));
			expect(setControlValue).not.toHaveBeenCalled();
			expect(input.classList.contains('aar-input-invalid')).toBe(true);

			input.value = '135';
			input.dispatchEvent(new Event('change'));

			expect(setControlValue).toHaveBeenCalledWith('cutoffHz', 135);
			expect(input.classList.contains('aar-input-invalid')).toBe(false);
		});

		it('stores the ceiling of a bound the declaration says is reachable', () => {
			// The reported defect, on the renderer that never rejected it: a
			// ceiling has to be enterable on both, or the two disagree about
			// what the same tree means.
			values['maxTokens'] = 4096;
			renderer.render(containerEl, [
				{
					name: 'Max output tokens',
					control: {
						type: 'number',
						key: 'maxTokens',
						min: MIN_LLM_MAX_TOKENS,
						max: MAX_LLM_MAX_TOKENS,
						step: LLM_MAX_TOKENS_STEP,
					},
				},
			]);

			const input = rowFor('Max output tokens').querySelector('input');
			if (!input) {
				throw new Error('No number input rendered');
			}
			input.value = String(MAX_LLM_MAX_TOKENS);
			input.dispatchEvent(new Event('change'));

			expect(setControlValue).toHaveBeenCalledWith(
				'maxTokens',
				MAX_LLM_MAX_TOKENS,
			);
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

		/**
		 * A switch and a whole block gated on it, which is the shape of the
		 * transcription section: the master switch is outside the blocks it
		 * reveals.
		 */
		const blockTree = (): SettingDefinitionItem[] => [
			{
				name: 'Enable transcription',
				control: { type: 'toggle', key: 'transcription' },
			},
			{
				type: 'group',
				heading: 'Transcript output',
				visible: () => values['transcription'] === true,
				items: [
					{
						name: 'Destination',
						control: { type: 'toggle', key: 'destination' },
					},
				],
			},
		];

		it('leaves a whole block hidden while its predicate is false', () => {
			values['transcription'] = false;
			renderer.render(containerEl, blockTree());

			expect(rowFor('Transcript output').style.display).toBe('none');
			expect(rowFor('Destination').style.display).toBe('none');
		});

		it('reveals a block when the switch that gates it turns on', () => {
			// A block skipped at render time could never come back: the switch
			// that reveals it had nothing to reveal, so turning transcription on
			// left the rest of the section missing until the tab was reopened.
			values['transcription'] = false;
			renderer.render(containerEl, blockTree());

			rowFor('Enable transcription')
				.querySelector<HTMLElement>('.checkbox-container')
				?.click();

			expect(rowFor('Transcript output').style.display).toBe('');
			expect(rowFor('Destination').style.display).toBe('');
		});

		it('keeps a nested block hidden while its own block is', () => {
			// The predicate of an inner block can hold while the block around it
			// does not; what the user sees is the outer answer.
			values['transcription'] = false;
			renderer.render(containerEl, [
				{
					type: 'group',
					heading: 'Transcription',
					visible: () => values['transcription'] === true,
					items: [
						{
							type: 'page',
							name: 'Engines',
							visible: () => true,
							items: [
								{
									name: 'Base URL',
									control: {
										type: 'text',
										key: 'baseUrl',
									},
								},
							],
						},
					],
				},
			]);

			expect(rowFor('Engines').style.display).toBe('none');
			expect(rowFor('Base URL').style.display).toBe('none');
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

	describe('lists', () => {
		const listTree = (
			items: string[],
			handlers: {
				onDelete?: jest.Mock;
				addItem?: jest.Mock;
			} = {},
		): SettingDefinitionItem[] => [
			{
				type: 'list',
				heading: 'Whisper models',
				emptyState: 'No models saved yet.',
				...(handlers.onDelete ? { onDelete: handlers.onDelete } : {}),
				...(handlers.addItem
					? {
							addItem: {
								name: 'Add model',
								action: handlers.addItem,
							},
						}
					: {}),
				search: {
					placeholder: 'Filter models',
					match: (def, query) =>
						(def as { name: string }).name
							.toLowerCase()
							.includes(query.toLowerCase()),
				},
				items: items.map((name) => ({ name, searchable: true })),
			},
		];

		it('shows the empty state in place of an empty list', () => {
			renderer.render(containerEl, listTree([]));

			expect(renderedNames()).toEqual([
				'Whisper models',
				'No models saved yet.',
			]);
		});

		it('offers an add affordance that runs the list action', () => {
			const addItem = jest.fn();
			renderer.render(containerEl, listTree(['whisper-1'], { addItem }));

			containerEl
				.querySelector<HTMLElement>('.aar-add-item-row button')
				?.click();

			expect(addItem).toHaveBeenCalledTimes(1);
		});

		it('deletes an entry by its position in the list', () => {
			const onDelete = jest.fn();
			renderer.render(
				containerEl,
				listTree(['whisper-1', 'whisper-2'], { onDelete }),
			);

			rowFor('whisper-2')
				.querySelector<HTMLElement>('.setting-item-control button')
				?.click();

			expect(onDelete).toHaveBeenCalledWith(1);
		});

		it('deletes an entry without also running the row action', () => {
			// A model catalogue is both: the row picks the id and the button
			// deletes it. The row listens on the whole row and the button sits
			// inside it, so a delete used to bubble back out as "the row was
			// clicked" - which removed an id and immediately selected it again.
			const onDelete = jest.fn();
			const action = jest.fn();
			renderer.render(containerEl, [
				{
					type: 'list',
					onDelete,
					items: [{ name: 'whisper-1', action }],
				} as unknown as SettingDefinitionItem,
			]);

			rowFor('whisper-1')
				.querySelector<HTMLElement>('.setting-item-control button')
				?.click();

			expect(onDelete).toHaveBeenCalledWith(0);
			expect(action).not.toHaveBeenCalled();
		});

		it('still runs the row action when the row itself is clicked', () => {
			const onDelete = jest.fn();
			const action = jest.fn();
			renderer.render(containerEl, [
				{
					type: 'list',
					onDelete,
					items: [{ name: 'whisper-1', action }],
				} as unknown as SettingDefinitionItem,
			]);

			rowFor('whisper-1').click();

			expect(action).toHaveBeenCalledTimes(1);
			expect(onDelete).not.toHaveBeenCalled();
		});

		it('filters the list through the group search field', () => {
			// The framework renders a search input in the group header and hides
			// the rows its predicate rejects; the same filter reaches this
			// Obsidian, which has no group header to put it in.
			renderer.render(containerEl, listTree(['whisper-1', 'nova-2']));

			const search = containerEl.querySelector<HTMLInputElement>(
				'.aar-search-row input',
			);
			if (!search) {
				throw new Error('No search field rendered');
			}
			search.value = 'nova';
			search.dispatchEvent(new Event('input'));

			expect(rowFor('whisper-1').style.display).toBe('none');
			expect(rowFor('nova-2').style.display).toBe('');
		});

		it('filters a list whose entries are pages by the entry name', () => {
			// A profile catalogue is a list of entities, so each entry is a page
			// rather than a row and the rows on screen are that page's. Matching
			// the rows instead left the filter matching nothing at all.
			renderer.render(containerEl, [
				{
					type: 'list',
					heading: 'Dictionary profiles',
					search: {
						placeholder: 'Filter profiles',
						match: (def, query) =>
							(def as { name: string }).name
								.toLowerCase()
								.includes(query.toLowerCase()),
					},
					items: ['Legal', 'Standup'].map((name) => ({
						type: 'page' as const,
						name,
						items: [
							{
								name: `${name} terms`,
								control: {
									type: 'textarea' as const,
									key: `terms.${name}`,
								},
							},
						],
					})),
				},
			]);

			const search = containerEl.querySelector<HTMLInputElement>(
				'.aar-search-row input',
			);
			if (!search) {
				throw new Error('No search field rendered');
			}
			search.value = 'legal';
			search.dispatchEvent(new Event('input'));

			expect(rowFor('Legal terms').style.display).toBe('');
			expect(rowFor('Standup terms').style.display).toBe('none');
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
