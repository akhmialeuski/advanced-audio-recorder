/**
 * Unit tests for the settings render mode: the factory's choice between the
 * two Obsidian settings APIs, what each mode does with the host it renders
 * into, and how each releases a body before replacing it.
 * @module tests/unit/settingsRenderMode.test
 */

import {
	renderDefinitionOf,
	renderThroughFramework,
	type RenderDefinition,
} from '../helpers/declarativeSettings';
import {
	SETTINGS_ROOT_CLASS,
	createSettingsRenderMode,
	type SettingsRenderMode,
	type SettingsRenderTarget,
} from 'src/settings/settingsRenderMode';

describe('settings render mode', () => {
	const TAB_NAME = 'Advanced Audio Recorder';
	const ALIASES = ['Recording format', 'Debug mode'];

	let renderFull: jest.Mock;
	let renderBody: jest.Mock;
	let releaseBody: jest.Mock;
	let frameworkUpdate: jest.Mock;

	beforeEach(() => {
		renderFull = jest.fn();
		// Stand in for the real body with one marker element, so the tests can
		// see which host it was rendered into and whether it survived.
		renderBody = jest.fn((host: HTMLElement) => {
			host.createDiv({ cls: 'aar-body-marker' });
		});
		releaseBody = jest.fn();
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
		releaseBody,
	});

	/** The single declarative definition a mode returns. */
	const definitionOf = (mode: SettingsRenderMode): RenderDefinition =>
		renderDefinitionOf(mode.getDefinitions());

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

		it('releases the body it is about to replace, before replacing it', () => {
			// Nothing hands this path a teardown hook, so the mode owns the
			// release: a test recording started under the old body would
			// otherwise keep reporting into a container that no longer exists.
			mode.rerender();

			expect(releaseBody).toHaveBeenCalledTimes(1);
			const released = releaseBody.mock.invocationCallOrder[0] ?? 0;
			const rebuilt = renderFull.mock.invocationCallOrder[0] ?? 0;
			expect(released).toBeLessThan(rebuilt);
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

			definition.aliases?.push('Injected by the framework');

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
			const frame = renderThroughFramework(definition);

			renderThroughFramework(definition, frame);

			expect(
				frame.setting.settingEl.querySelectorAll('.aar-body-marker'),
			).toHaveLength(1);
		});

		it('hands the framework a cleanup that releases the rendered body', () => {
			// The framework keeps this callback and runs it before it renders
			// the row again and before it drops the row, which is the only
			// teardown this path gets while the tab stays open.
			const frame = renderThroughFramework(definitionOf(mode));

			expect(frame.cleanup).toEqual(expect.any(Function));
			expect(releaseBody).not.toHaveBeenCalled();

			frame.cleanup?.();

			expect(releaseBody).toHaveBeenCalledTimes(1);
		});

		it('releases the previous body exactly once per re-render', () => {
			const definition = definitionOf(mode);
			const frame = renderThroughFramework(definition);

			renderThroughFramework(definition, frame);

			expect(releaseBody).toHaveBeenCalledTimes(1);
			const released = releaseBody.mock.invocationCallOrder[0] ?? 0;
			const rerendered = renderBody.mock.invocationCallOrder[1] ?? 0;
			expect(released).toBeLessThan(rerendered);
		});

		it('re-renders through the framework rather than by hand', () => {
			mode.rerender();

			// The framework re-invokes the definition; a body built here would
			// be thrown away by its next pass, and the release travels with the
			// cleanup the framework already holds.
			expect(frameworkUpdate).toHaveBeenCalledTimes(1);
			expect(renderFull).not.toHaveBeenCalled();
			expect(renderBody).not.toHaveBeenCalled();
			expect(releaseBody).not.toHaveBeenCalled();
		});
	});
});
