/**
 * Unit tests for the tab's definition tree: what each migrated section declares,
 * and how the row hosting the not-yet-migrated sections behaves under the
 * framework that owns it.
 * @module tests/unit/settingsDefinitions.test
 */

import type { Setting, SettingDefinitionItem } from 'obsidian';
import { at } from '../helpers/assertions';
import {
	renderDefinitionOf,
	renderThroughFramework,
	type RenderDefinition,
} from '../helpers/declarativeSettings';
import {
	SETTINGS_BLOCK_ROW_CLASS,
	SETTINGS_ROOT_CLASS,
	buildSettingsDefinitions,
	collectDebouncedControlKeys,
	type DiagnosticsActions,
	type SettingsDefinitionContext,
} from 'src/settings/settingsDefinitions';

/** A group definition, narrowed to what these tests read. */
interface GroupDefinition {
	type: string;
	heading?: string;
	items: Array<{
		name: string;
		desc?: string;
		control?: { type: string; key: string };
		action?: (el: HTMLElement, index: number) => void;
		render?: (setting: Setting) => void | (() => void);
	}>;
}

describe('settings definitions', () => {
	const REMAINDER_NAME = 'Advanced Audio Recorder';
	const ALIASES = ['Recording format', 'Save folder'];

	let renderRemainder: jest.Mock;
	let diagnostics: { [K in keyof DiagnosticsActions]: jest.Mock };

	beforeEach(() => {
		// Stands in for the real body with one marker element, so a test can see
		// which host it was rendered into and whether it survived.
		renderRemainder = jest.fn((host: HTMLElement) => {
			host.createDiv({ cls: 'aar-body-marker' });
		});
		diagnostics = {
			startTestRecording: jest.fn(),
			releaseTestRecording: jest.fn(),
			showSystemInfo: jest.fn(),
		};
	});

	const createContext = (
		aliases: readonly string[] = ALIASES,
	): SettingsDefinitionContext => ({
		remainder: {
			name: REMAINDER_NAME,
			aliases,
			render: renderRemainder as (host: HTMLElement) => void,
		},
		diagnostics: diagnostics,
	});

	const build = (aliases?: readonly string[]): SettingDefinitionItem[] =>
		buildSettingsDefinitions(createContext(aliases));

	/** The definition hosting the sections still rendered imperatively. */
	const remainderOf = (
		definitions: SettingDefinitionItem[],
	): RenderDefinition => renderDefinitionOf(definitions);

	/** The diagnostics group, narrowed to what these tests read. */
	const diagnosticsGroupOf = (
		definitions: SettingDefinitionItem[],
	): GroupDefinition =>
		at(definitions, 1, 'definition') as unknown as GroupDefinition;

	describe('the imperative remainder', () => {
		it('is named after the plugin and carries the remaining names as aliases', () => {
			const definition = remainderOf(build());

			expect(definition.name).toBe(REMAINDER_NAME);
			expect(definition.aliases).toEqual(ALIASES);
		});

		it('copies the alias list, so the tab keeps its own', () => {
			const aliases = [...ALIASES];
			const definition = remainderOf(build(aliases));

			definition.aliases?.push('Injected by the framework');

			expect(aliases).toEqual(ALIASES);
		});

		it('renders the body into the row the framework hands over', () => {
			const { setting } = renderThroughFramework(remainderOf(build()));

			expect(renderRemainder).toHaveBeenCalledWith(setting.settingEl);
			expect(
				setting.settingEl.querySelector('.aar-body-marker'),
			).not.toBeNull();
		});

		it('keeps the body through the framework reset that follows a render', () => {
			// Rendering into the group's list element (or the tab container)
			// leaves the tab empty: the framework resets both to the elements it
			// tracks once every definition has rendered.
			const { containerEl } = renderThroughFramework(
				remainderOf(build()),
			);

			expect(
				containerEl.querySelector('.aar-body-marker'),
			).not.toBeNull();
		});

		it('clears the name and description the framework prefilled the row with', () => {
			const { setting } = renderThroughFramework(remainderOf(build()));

			expect(setting.settingEl.contains(setting.nameEl)).toBe(false);
			expect(setting.settingEl.contains(setting.descEl)).toBe(false);
			expect(setting.settingEl.contains(setting.controlEl)).toBe(false);
		});

		it('marks the row so the stylesheet can strip its setting-row layout', () => {
			const { setting } = renderThroughFramework(remainderOf(build()));

			expect(
				setting.settingEl.classList.contains(SETTINGS_ROOT_CLASS),
			).toBe(true);
		});

		it('replaces the body when the framework re-renders the same row', () => {
			const definition = remainderOf(build());
			const frame = renderThroughFramework(definition);

			renderThroughFramework(definition, frame);

			expect(
				frame.setting.settingEl.querySelectorAll('.aar-body-marker'),
			).toHaveLength(1);
		});
	});

	describe('the diagnostics section', () => {
		it('declares its three rows under one heading', () => {
			const group = diagnosticsGroupOf(build());

			expect(group.type).toBe('group');
			expect(group.heading).toBe('Diagnostics');
			expect(group.items.map((item) => item.name)).toEqual([
				'Test recording',
				'System info',
				'Debug mode',
			]);
		});

		it('binds debug mode to the settings key, so Obsidian owns the write', () => {
			const group = diagnosticsGroupOf(build());

			expect(at(group.items, 2).control).toEqual({
				type: 'toggle',
				key: 'debug',
			});
		});

		it('opens the system information dialog from an action row', () => {
			const group = diagnosticsGroupOf(build());
			const row = at(group.items, 1);

			row.action?.(createDiv(), 1);

			expect(diagnostics.showSystemInfo).toHaveBeenCalledTimes(1);
		});

		it('starts the test capture in the row that reports it', () => {
			const definition = at(diagnosticsGroupOf(build()).items, 0);
			const { setting } = renderThroughFramework(
				definition as RenderDefinition,
			);

			setting.settingEl
				.querySelector<HTMLButtonElement>('button')
				?.click();

			expect(diagnostics.startTestRecording).toHaveBeenCalledWith(
				setting.settingEl,
			);
			// The row carries block content (status line, playback element)
			// under its control, which the stylesheet needs to know about.
			expect(
				setting.settingEl.classList.contains(SETTINGS_BLOCK_ROW_CLASS),
			).toBe(true);
		});

		it('releases the test capture through the cleanup the framework holds', () => {
			// The framework runs this before it renders the row again and before
			// it drops the row, which is the only teardown a render row gets
			// while the tab stays open.
			const definition = at(diagnosticsGroupOf(build()).items, 0);
			const frame = renderThroughFramework(
				definition as RenderDefinition,
			);

			expect(frame.cleanup).toEqual(expect.any(Function));
			expect(diagnostics.releaseTestRecording).not.toHaveBeenCalled();

			frame.cleanup?.();

			expect(diagnostics.releaseTestRecording).toHaveBeenCalledTimes(1);
		});
	});

	describe('collectDebouncedControlKeys', () => {
		it('collects the text-bearing controls, nested groups included', () => {
			const keys = collectDebouncedControlKeys([
				{
					name: 'Prefix',
					control: { type: 'text', key: 'filePrefix' },
				},
				{
					type: 'group',
					heading: 'Transcription',
					items: [
						{
							name: 'Prompt',
							control: { type: 'textarea', key: 'llmPrompt' },
						},
						{
							name: 'Enabled',
							control: {
								type: 'toggle',
								key: 'transcriptionEnabled',
							},
						},
					],
				},
			]);

			expect(keys).toEqual(new Set(['filePrefix', 'llmPrompt']));
		});

		it('leaves the controls that change once per interaction alone', () => {
			// A toggle, a dropdown, or a number field fires one change per
			// interaction: debouncing those would only delay the write.
			const keys = collectDebouncedControlKeys(build());

			expect(keys.has('debug')).toBe(false);
		});
	});
});
