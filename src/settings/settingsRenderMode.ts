/**
 * How the settings tab reaches the screen on the Obsidian it is running on.
 *
 * Obsidian 1.13 changed the contract. Before it, `display()` was the render
 * call and the tab's own container was the host. From 1.13 on, the tab is
 * rendered from the definitions it returns from `getSettingDefinitions()`,
 * `display()` is not called at all, and the framework owns the DOM around a
 * definition: after every pass it resets the group's list element to exactly
 * the rows it tracks, and the tab container to the group elements, so a body
 * rendered into either is dropped again - a row removed by the definition is
 * even put back. The row element of a render definition is the one host that
 * survives, so that is where the body goes there.
 *
 * The two versions disagree in exactly two places - which element the body is
 * rendered into, and what re-renders it after a setting appears or disappears -
 * so each version gets one mode object, {@link createSettingsRenderMode} picks
 * one when the tab is constructed, and the tab asks the mode instead of asking
 * which Obsidian it is running on.
 * @module settings/settingsRenderMode
 */

import type { Setting, SettingDefinitionItem } from 'obsidian';

/**
 * Marks the framework row the whole tab body is rendered into from Obsidian
 * 1.13 on. The stylesheet strips that row's own flex layout, padding,
 * background, and divider so the body reads as an ordinary settings column.
 * Never applied on the imperative path, where the body has a container of its
 * own and the row does not exist.
 */
export const SETTINGS_ROOT_CLASS = 'aar-settings-root';

/**
 * What a render mode needs from the tab it renders.
 */
export interface SettingsRenderTarget {
	/** Name of the tab's single declarative definition. */
	readonly name: string;
	/** Individual setting names, carried as that definition's search aliases. */
	readonly aliases: readonly string[];
	/**
	 * Obsidian's own declarative re-render (`SettingTab.update()`), which
	 * arrived in 1.13 together with the definition-driven render. Undefined on
	 * older versions - that absence is what selects the imperative mode.
	 */
	readonly frameworkUpdate: (() => void) | undefined;
	/** Clears the tab's own container and rebuilds the body into it. */
	renderFull(): void;
	/** Draws the settings body into a host the mode has already cleared. */
	renderBody(host: HTMLElement): void;
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
			target.renderFull();
		},
	};
}

/**
 * Rendering for Obsidian 1.13 and later: one render definition, whose row is
 * the host, and the framework drives every pass.
 * @param target - The tab being rendered
 * @param frameworkUpdate - Obsidian's own re-render of the definitions
 */
function createDeclarativeRenderMode(
	target: SettingsRenderTarget,
	frameworkUpdate: () => void,
): SettingsRenderMode {
	return {
		getDefinitions: (): SettingDefinitionItem[] => [
			{
				name: target.name,
				// The tab renders imperatively, so its individual settings are
				// not definitions of their own. The names travel as aliases,
				// which is what lets Obsidian's settings search find the tab by
				// a single setting's name.
				aliases: [...target.aliases],
				render: (setting: Setting): void => {
					// The row is the only DOM this definition owns; the tab
					// container and the group's list are reset around it after
					// every pass. Its name, description, and control elements
					// go first - the body replaces them.
					const host = setting.settingEl;
					host.empty();
					host.addClass(SETTINGS_ROOT_CLASS);
					target.renderBody(host);
				},
			},
		],
		// The framework re-invokes the render definition itself. Rebuilding the
		// body here instead would just be thrown away by its next pass.
		rerender: frameworkUpdate,
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
