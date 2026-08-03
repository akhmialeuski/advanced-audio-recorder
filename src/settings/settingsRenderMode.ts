/**
 * How the settings tab reaches the screen on the Obsidian it is running on.
 *
 * Obsidian 1.13 changed the contract. Before it, `display()` was the render
 * call and the tab's own container was the host. From 1.13 on, the tab is
 * rendered from the definitions it returns from `getSettingDefinitions()` and
 * `display()` is not called at all.
 *
 * Both versions render the same tree (see
 * {@link module:settings/settingsDefinitions}), so what is left to decide is
 * who renders it and who re-renders it after a setting appears or disappears:
 * the framework on 1.13, the legacy renderer below it. Each version gets one
 * mode object, {@link createSettingsRenderMode} picks one when the tab is
 * constructed, and the tab asks the mode instead of asking which Obsidian it is
 * running on.
 * @module settings/settingsRenderMode
 */

import type { SettingDefinitionItem } from 'obsidian';
import { isSettingsListAddRowProvided } from '../platform/capabilities';

/**
 * What a render mode needs from the tab it renders.
 */
export interface SettingsRenderTarget {
	/**
	 * The tab's definition tree, rebuilt for every pass. On 1.13 it is what the
	 * framework renders; below it, what the legacy renderer walks.
	 */
	buildDefinitions(): SettingDefinitionItem[];
	/**
	 * Renders that same tree into the tab's own container with the settings API
	 * Obsidian had before 1.13, releasing the previous body first.
	 */
	renderLegacy(): void;
	/**
	 * Obsidian's own declarative re-render (`SettingTab.update()`), which
	 * arrived in 1.13 together with the definition-driven render. Undefined on
	 * older versions - that absence is what selects the imperative mode.
	 */
	readonly frameworkUpdate: (() => void) | undefined;
}

/**
 * The version-dependent half of rendering the settings tab.
 */
export interface SettingsRenderMode {
	/**
	 * Definitions Obsidian renders the tab from, as returned by the tab's
	 * `getSettingDefinitions()`.
	 */
	getDefinitions(): SettingDefinitionItem[];
	/**
	 * Re-renders the tab after a change that adds or removes settings, on
	 * whichever terms the running Obsidian sets.
	 */
	rerender(): void;
	/**
	 * Whether this renderer already gives a list a labelled row for adding an
	 * entry. The legacy renderer always draws one; the framework draws one on
	 * mobile and only a plus icon in the list header on desktop. Where the
	 * answer is false the tree declares an add row of its own, so the tab never
	 * hides adding behind an unlabelled icon.
	 */
	rendersListAddRow(): boolean;
}

/**
 * Rendering for Obsidian before 1.13: `display()` is the render call, and the
 * tab's own container is the host.
 * @param target - The tab being rendered
 */
function createImperativeRenderMode(
	target: SettingsRenderTarget,
): SettingsRenderMode {
	return {
		// Not merely "nothing to declare": on 1.13 an empty array is the signal
		// that makes the framework fall back to display(), so a tab that ends up
		// in this mode on a newer Obsidian still renders its settings.
		getDefinitions: (): SettingDefinitionItem[] => [],
		rerender: (): void => {
			target.renderLegacy();
		},
		// The legacy renderer turns a list's addItem into a labelled row of its
		// own, on every platform, so the tree must not declare a second one.
		rendersListAddRow: (): boolean => true,
	};
}

/**
 * Rendering for Obsidian 1.13 and later: the framework renders the definitions
 * and drives every pass, including the teardown of the rows it replaces.
 * @param target - The tab being rendered
 * @param frameworkUpdate - Obsidian's own re-render of the definitions
 */
function createDeclarativeRenderMode(
	target: SettingsRenderTarget,
	frameworkUpdate: () => void,
): SettingsRenderMode {
	return {
		getDefinitions: (): SettingDefinitionItem[] =>
			target.buildDefinitions(),
		// The framework re-reads the definitions and re-renders the rows itself.
		// Rebuilding a body here instead would just be thrown away by its pass.
		rerender: frameworkUpdate,
		// Resolved per call rather than captured: the platform answer is a
		// runtime lookup, and a tab outlives any single render.
		rendersListAddRow: (): boolean => isSettingsListAddRowProvided(),
	};
}

/**
 * Picks the rendering mode for the Obsidian the tab is running on.
 * @param target - The tab being rendered
 * @returns The mode matching the host's settings API
 */
export function createSettingsRenderMode(
	target: SettingsRenderTarget,
): SettingsRenderMode {
	const frameworkUpdate = target.frameworkUpdate;
	return frameworkUpdate
		? createDeclarativeRenderMode(target, frameworkUpdate)
		: createImperativeRenderMode(target);
}
