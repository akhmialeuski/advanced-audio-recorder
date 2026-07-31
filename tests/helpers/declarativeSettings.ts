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

/** A setting row, in the shape a test reads it. */
export interface RowDefinition {
	name: string;
	desc?: string;
	visible?: boolean | (() => boolean);
	control?: {
		type: string;
		key: string;
		disabled?: boolean | (() => boolean);
		options?: Record<string, string>;
		validate?: (value: never) => string | void;
		[option: string]: unknown;
	};
	action?: (el: HTMLElement, index: number) => void;
	render?: (setting: Setting) => void | (() => void);
}

/** A group, list, or page definition, in the shape a test reads it. */
export interface GroupDefinition {
	type: string;
	heading?: string;
	name?: string;
	visible?: boolean | (() => boolean);
	items: Array<RowDefinition | GroupDefinition>;
}

/**
 * Finds a group, list, or page by its heading, at any depth. Tests address the
 * tree by what it says rather than by where a section currently sits, so a
 * section added above one under test does not rewrite its assertions.
 * @param definitions - The tree to search
 * @param heading - Heading (or page name) to find
 * @returns The matching group
 */
export const groupOf = (
	definitions: readonly SettingDefinitionItem[],
	heading: string,
): GroupDefinition => {
	const search = (
		entries: ReadonlyArray<RowDefinition | GroupDefinition>,
		matches: (entry: GroupDefinition) => boolean,
	): GroupDefinition | undefined => {
		for (const entry of entries) {
			if (!('type' in entry)) {
				continue;
			}
			if (matches(entry)) {
				return entry;
			}
			const nested = search(entry.items ?? [], matches);
			if (nested) {
				return nested;
			}
		}
		return undefined;
	};
	const tree = definitions as ReadonlyArray<RowDefinition | GroupDefinition>;
	// A page and the group inside it can share a name - the transcription page
	// opens with a group of the same name - so the group holding rows wins over
	// the page holding groups.
	const found =
		search(tree, (entry) => entry.heading === heading) ??
		search(tree, (entry) => entry.name === heading);
	if (!found) {
		throw new Error(`No settings group declared under "${heading}"`);
	}
	return found;
};

/**
 * Finds a row by name inside a group.
 * @param definitions - The tree to search
 * @param heading - Heading of the group holding the row
 * @param name - The row's name
 * @returns The matching row
 */
export const rowOf = (
	definitions: readonly SettingDefinitionItem[],
	heading: string,
	name: string,
): RowDefinition => {
	const row = groupOf(definitions, heading).items.find(
		(item) => !('type' in item) && item.name === name,
	);
	if (!row) {
		throw new Error(`No "${name}" row declared under "${heading}"`);
	}
	return row as RowDefinition;
};

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
