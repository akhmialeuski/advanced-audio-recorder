/**
 * Drives a settings tab's render definition the way Obsidian 1.13 drives it,
 * so a test sees the DOM the framework actually leaves behind rather than the
 * DOM the render callback happened to produce.
 *
 * Three framework behaviours decide whether a rendered body survives, and this
 * harness reproduces all three. The row is built inside the group's list
 * element and the definition's name and description are written into it before
 * `render()` is called. A row that already exists is re-rendered in place: the
 * cleanup returned by the previous render runs first, then the row's controls
 * are cleared, then the definition is written into it again. Once every
 * definition has rendered, the list element is reset to exactly the rows the
 * framework tracks and the tab container to the group elements, which is what
 * drops a body rendered beside a row and puts back a row a callback removed.
 * @module tests/helpers/declarativeSettings
 */

import { PluginSettingTab, Setting } from 'obsidian';
import type { SettingDefinitionItem } from 'obsidian';
import { at } from './assertions';

/**
 * A tab's render definition, in the shape a test reads it: the framework
 * receives it as one member of the `SettingDefinitionItem` union.
 */
export interface RenderDefinition {
	name: string;
	aliases?: string[];
	render: (setting: Setting) => void | (() => void);
}

/** The DOM the framework builds around one render definition. */
export interface DeclarativeFrame {
	/** Stands in for the tab's own container element. */
	containerEl: HTMLElement;
	/** The declarative group the definition is rendered into. */
	groupEl: HTMLElement;
	/** The group's list element, which the framework resets after a render. */
	listEl: HTMLElement;
	/** The row the framework tracks, and the definition's only host. */
	setting: Setting;
	/** Cleanup returned by the last render, kept the way the framework keeps it. */
	cleanup: (() => void) | undefined;
}

/**
 * The single render definition a tab declares.
 * @param definitions - What `getSettingDefinitions()` returned
 * @returns That definition, narrowed to its render shape
 */
export const renderDefinitionOf = (
	definitions: SettingDefinitionItem[],
): RenderDefinition => {
	const definition = at(definitions, 0, 'setting definition');
	if (!('render' in definition) || typeof definition.render !== 'function') {
		throw new Error('The tab declares no render definition');
	}
	return definition as RenderDefinition;
};

/** Builds the DOM the framework wraps a definition in. */
const createFrame = (): DeclarativeFrame => {
	const containerEl = createDiv();
	const groupEl = containerEl.createDiv({ cls: 'setting-group' });
	const listEl = groupEl.createDiv({ cls: 'setting-items' });
	return {
		containerEl,
		groupEl,
		listEl,
		setting: new Setting(listEl),
		cleanup: undefined,
	};
};

/**
 * Renders a definition through the framework, either into a fresh row or into
 * the row an earlier render already built, which is what `update()` does.
 * @param definition - The definition under test
 * @param existing - Frame from an earlier render, to model a re-render
 * @returns The frame, carrying the DOM and the cleanup the render returned
 */
export const renderThroughFramework = (
	definition: RenderDefinition,
	existing?: DeclarativeFrame,
): DeclarativeFrame => {
	const frame = existing ?? createFrame();
	if (existing) {
		releaseThroughFramework(frame);
		frame.setting.clear();
	}
	frame.setting.setName(definition.name).setDesc('');
	const cleanup = definition.render(frame.setting);
	frame.cleanup = typeof cleanup === 'function' ? cleanup : undefined;
	frame.listEl.replaceChildren(frame.setting.settingEl);
	frame.containerEl.replaceChildren(frame.groupEl);
	return frame;
};

/**
 * Runs the cleanup the framework holds for a row, as it does before it renders
 * that row again and before it drops the row on leaving the tab.
 * @param frame - The frame whose row is being torn down
 */
export const releaseThroughFramework = (frame: DeclarativeFrame): void => {
	frame.cleanup?.();
	frame.cleanup = undefined;
};

/**
 * Runs a body against an Obsidian that has no `SettingTab.update()`, the
 * method 1.13 added alongside the declarative render. Its absence is what a
 * tab probes for when it picks the imperative path, and since that choice is
 * made in the constructor, the tab under test has to be built inside the body.
 * @param body - Runs while the prototype models the older Obsidian
 * @returns Whatever the body returned
 */
export const withoutFrameworkUpdate = <T>(body: () => T): T => {
	const base = PluginSettingTab.prototype as { update?: () => void };
	const update = base.update;
	delete base.update;
	try {
		return body();
	} finally {
		if (update) {
			base.update = update;
		}
	}
};
