/**
 * Unit tests for the settings render mode: the factory's choice between the
 * two Obsidian settings APIs, and what each mode does with the host it renders
 * into and with a re-render request.
 * @module tests/unit/settingsRenderMode.test
 */

import { Setting } from 'obsidian';
import { at } from '../helpers/assertions';
import {
	SETTINGS_ROOT_CLASS,
	createSettingsRenderMode,
	type SettingsRenderMode,
	type SettingsRenderTarget,
} from 'src/settings/settingsRenderMode';

/** The shape of the tab's single declarative definition. */
interface RenderDefinition {
	name: string;
	aliases: string[];
	render: (setting: Setting) => void;
}

describe('settings render mode', () => {
	const TAB_NAME = 'Advanced Audio Recorder';
	const ALIASES = ['Recording format', 'Debug mode'];

	let renderFull: jest.Mock;
	let renderBody: jest.Mock;
	let frameworkUpdate: jest.Mock;

	beforeEach(() => {
		renderFull = jest.fn();
		// Stand in for the real body with one marker element, so the tests can
		// see which host it was rendered into and whether it survived.
		renderBody = jest.fn((host: HTMLElement) => {
			host.createDiv({ cls: 'aar-body-marker' });
		});
		frameworkUpdate = jest.fn();
	});

	/**
	 * Builds a render target for the Obsidian identified by `hasFrameworkUpdate`.
	 * @param hasFrameworkUpdate - Whether the host has SettingTab.update(),
	 * which is what 1.13 added alongside the declarative render
	 * @param aliases - Alias list to carry on the definition
	 */
	const createTarget = (
		hasFrameworkUpdate: boolean,
		aliases: readonly string[] = ALIASES,
	): SettingsRenderTarget => ({
		name: TAB_NAME,
		aliases,
		frameworkUpdate: hasFrameworkUpdate ? frameworkUpdate : undefined,
		renderFull,
		renderBody,
	});

	/** The single declarative definition a mode returns. */
	const definitionOf = (mode: SettingsRenderMode): RenderDefinition =>
		at(mode.getDefinitions(), 0) as unknown as RenderDefinition;

	/**
	 * Runs a render definition the way Obsidian 1.13 does: the row is built in
	 * the group's list element, the definition's name and description are
	 * written into it, render() runs, and then the framework resets the list to
	 * exactly the rows it tracks and the tab container to the group elements.
	 * @param definition - The definition under test
	 */
	const renderThroughFramework = (
		definition: RenderDefinition,
	): { containerEl: HTMLElement; listEl: HTMLElement; setting: Setting } => {
		const containerEl = createDiv();
		const groupEl = containerEl.createDiv({ cls: 'setting-group' });
		const listEl = groupEl.createDiv({ cls: 'setting-items' });
		const setting = new Setting(listEl);
		setting.setName(definition.name).setDesc('');

		definition.render(setting);

		listEl.replaceChildren(setting.settingEl);
		containerEl.replaceChildren(groupEl);
		return { containerEl, listEl, setting };
	};

	describe('createSettingsRenderMode', () => {
		it('renders declaratively when the host has the framework update', () => {
			const mode = createSettingsRenderMode(createTarget(true));

			expect(mode.getDefinitions()).toHaveLength(1);
		});

		it('renders imperatively when the host has no framework update', () => {
			const mode = createSettingsRenderMode(createTarget(false));

			expect(mode.getDefinitions()).toEqual([]);
		});
	});

	describe('imperative mode (Obsidian before 1.13)', () => {
		let mode: SettingsRenderMode;

		beforeEach(() => {
			mode = createSettingsRenderMode(createTarget(false));
		});

		it('declares no settings, which is what makes a 1.13 host call display()', () => {
			// renderTab() falls back to display() only while the definition
			// list is empty, so this is the signal, not just an absence.
			expect(mode.getDefinitions()).toEqual([]);
		});

		it('re-renders by rebuilding the tab container', () => {
			mode.rerender();

			expect(renderFull).toHaveBeenCalledTimes(1);
			// The container is cleared by renderFull itself; the mode must not
			// render a second body beside it.
			expect(renderBody).not.toHaveBeenCalled();
		});

		it('never reaches for a framework update it cannot have', () => {
			mode.rerender();

			expect(frameworkUpdate).not.toHaveBeenCalled();
		});
	});

	describe('declarative mode (Obsidian 1.13 and later)', () => {
		let mode: SettingsRenderMode;

		beforeEach(() => {
			mode = createSettingsRenderMode(createTarget(true));
		});

		it('names its definition after the tab and carries every search alias', () => {
			const definition = definitionOf(mode);

			expect(definition.name).toBe(TAB_NAME);
			expect(definition.aliases).toEqual(ALIASES);
		});

		it('copies the alias list, so the tab keeps its own', () => {
			const aliases = [...ALIASES];
			const definition = definitionOf(
				createSettingsRenderMode(createTarget(true, aliases)),
			);

			definition.aliases.push('Injected by the framework');

			expect(aliases).toEqual(ALIASES);
		});

		it('renders the body into the row the framework hands over', () => {
			const { setting } = renderThroughFramework(definitionOf(mode));

			expect(renderBody).toHaveBeenCalledTimes(1);
			expect(renderBody).toHaveBeenCalledWith(setting.settingEl);
			expect(
				setting.settingEl.querySelector('.aar-body-marker'),
			).not.toBeNull();
		});

		it('keeps the body through the framework reset that follows a render', () => {
			// The regression: rendering into the group's list element (or the
			// tab container) leaves the tab empty, because the framework resets
			// both to the elements it tracks once every definition has rendered.
			const { containerEl } = renderThroughFramework(definitionOf(mode));

			expect(
				containerEl.querySelector('.aar-body-marker'),
			).not.toBeNull();
		});

		it('clears the name and description the framework prefilled the row with', () => {
			const { setting } = renderThroughFramework(definitionOf(mode));

			expect(setting.settingEl.contains(setting.nameEl)).toBe(false);
			expect(setting.settingEl.contains(setting.descEl)).toBe(false);
			expect(setting.settingEl.contains(setting.controlEl)).toBe(false);
		});

		it('marks the row so the stylesheet can strip its setting-row layout', () => {
			const { setting } = renderThroughFramework(definitionOf(mode));

			expect(
				setting.settingEl.classList.contains(SETTINGS_ROOT_CLASS),
			).toBe(true);
		});

		it('replaces the body when the framework re-renders the same row', () => {
			const definition = definitionOf(mode);
			const { setting } = renderThroughFramework(definition);

			definition.render(setting);

			expect(
				setting.settingEl.querySelectorAll('.aar-body-marker'),
			).toHaveLength(1);
		});

		it('re-renders through the framework rather than by hand', () => {
			mode.rerender();

			// The framework re-invokes the definition; a body built here would
			// be thrown away by its next pass.
			expect(frameworkUpdate).toHaveBeenCalledTimes(1);
			expect(renderFull).not.toHaveBeenCalled();
			expect(renderBody).not.toHaveBeenCalled();
		});
	});
});
