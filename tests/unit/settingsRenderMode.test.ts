/**
 * Unit tests for the settings render mode: the factory's choice between the two
 * Obsidian settings APIs, and which of them ends up rendering the tab's
 * definition tree.
 * @module tests/unit/settingsRenderMode.test
 */

import type { SettingDefinitionItem } from 'obsidian';
import {
	createSettingsRenderMode,
	type SettingsRenderMode,
	type SettingsRenderTarget,
} from 'src/settings/settingsRenderMode';

describe('settings render mode', () => {
	const DEFINITIONS: SettingDefinitionItem[] = [
		{ name: 'Debug mode', control: { type: 'toggle', key: 'debug' } },
	];

	let buildDefinitions: jest.Mock;
	let renderLegacy: jest.Mock;
	let frameworkUpdate: jest.Mock;

	beforeEach(() => {
		buildDefinitions = jest.fn(() => DEFINITIONS);
		renderLegacy = jest.fn();
		frameworkUpdate = jest.fn();
	});

	/**
	 * Builds a render target for the Obsidian identified by `hasFrameworkUpdate`.
	 * @param hasFrameworkUpdate - Whether the host has SettingTab.update(),
	 * which is what 1.13 added alongside the declarative render
	 */
	const createTarget = (
		hasFrameworkUpdate: boolean,
	): SettingsRenderTarget => ({
		frameworkUpdate: hasFrameworkUpdate ? frameworkUpdate : undefined,
		buildDefinitions,
		renderLegacy,
	});

	describe('createSettingsRenderMode', () => {
		it('renders declaratively when the host has the framework update', () => {
			const mode = createSettingsRenderMode(createTarget(true));

			expect(mode.getDefinitions()).toBe(DEFINITIONS);
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
			expect(buildDefinitions).not.toHaveBeenCalled();
		});

		it('re-renders the tree with the pre-1.13 renderer', () => {
			mode.rerender();

			expect(renderLegacy).toHaveBeenCalledTimes(1);
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

		it('hands the framework the definitions the tab built', () => {
			expect(mode.getDefinitions()).toBe(DEFINITIONS);
			expect(buildDefinitions).toHaveBeenCalledTimes(1);
		});

		it('rebuilds the tree on every request', () => {
			// The framework asks again on each update(), and the answer carries
			// live predicates and option lists: a cached tree would freeze them.
			mode.getDefinitions();
			mode.getDefinitions();

			expect(buildDefinitions).toHaveBeenCalledTimes(2);
		});

		it('re-renders through the framework rather than by hand', () => {
			mode.rerender();

			expect(frameworkUpdate).toHaveBeenCalledTimes(1);
			expect(renderLegacy).not.toHaveBeenCalled();
		});
	});
});
