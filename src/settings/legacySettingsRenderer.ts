/**
 * Renders the tab's setting definitions on the Obsidian that has no declarative
 * settings API, so both generations render from one description instead of two
 * hand-kept implementations.
 *
 * What Obsidian 1.13 does for a definition, this does with the `Setting` API
 * that has always existed: a group becomes a heading followed by its rows, a
 * control becomes the matching `add*` call bound to the host's read and write
 * hooks, an action becomes a clickable row, and a render definition is handed
 * the same `Setting` it would get from the framework - including the cleanup it
 * returns, which runs before the row is rendered again or dropped.
 *
 * `visible` and `disabled` predicates are re-evaluated after every change, the
 * way the framework's own `refreshDomState()` does, so a row that reveals
 * another row does it here too without rebuilding the tab. That holds for a
 * whole block as much as for a row: the tree flattens here, so a hidden group
 * is one whose own elements and rows are hidden, never one that was skipped -
 * a block never built could not be revealed by the switch that gates it.
 * @module settings/legacySettingsRenderer
 */

import { Setting, setIcon } from 'obsidian';
import type {
	SettingControl,
	SettingDefinition,
	SettingDefinitionGroup,
	SettingDefinitionItem,
	SettingDefinitionList,
	SettingDefinitionPage,
	SettingGroup,
} from 'obsidian';
import { NUMBER_INPUT_CLASS } from './settingControls';
import { numberControlRejection } from './settingsDefinitions';

/** Class applied to a row whose whole surface runs an action when clicked. */
export const LEGACY_ACTION_ROW_CLASS = 'aar-action-row';

/** Class applied to the row that adds an entry to a list. */
export const LEGACY_ADD_ITEM_CLASS = 'aar-add-item-row';

/** Class applied to the row shown in place of an empty list. */
export const LEGACY_EMPTY_STATE_CLASS = 'aar-empty-state-row';

/** Class applied to the row holding a group's search field. */
export const LEGACY_SEARCH_ROW_CLASS = 'aar-search-row';

/**
 * Class applied to a row whose control is a text area. From 1.13 the framework
 * lays a text area out full width under its name; the older stylesheets put
 * every control in the narrow right-hand column, which is unusable for a
 * multi-sentence prompt, so the stylesheet stacks it here instead.
 */
export const LEGACY_STACKED_CLASS = 'aar-setting-stacked';

/** Class applied to a text input holding a value its validator rejected. */
const INVALID_INPUT_CLASS = 'aar-input-invalid';

/**
 * The read and write path a rendered control is bound to. The same pair the
 * framework calls on 1.13, so a value reaches the plugin identically on both.
 */
export interface LegacySettingsHost {
	/** Current value of a control key. */
	getControlValue(key: string): unknown;
	/** Persists a new value for a control key. */
	setControlValue(key: string, value: unknown): void | Promise<void>;
}

/**
 * What this renderer cannot do on its own. Obsidian brings these from 1.13;
 * below it they are the plugin's own, and the tab passes them in.
 */
export interface LegacyRenderExtras {
	/** Puts the vault's folders under a folder field, as the folder control does. */
	attachFolderSuggest(inputEl: HTMLInputElement): void;
}

/**
 * A shape of the tree that holds other items: a group, a list, or a page. All
 * three carry a `visible` predicate over everything inside them.
 */
type SettingContainer = SettingDefinitionGroup | SettingDefinitionPage;

/** A rendered row, kept so its predicates can be re-evaluated in place. */
interface RenderedRow {
	readonly definition: SettingDefinition;
	readonly settingEl: HTMLElement;
	/** The containers it sits inside, outermost first. */
	readonly ancestors: readonly SettingContainer[];
	/** Applies a disabled state to the row's control, when it has one. */
	readonly setDisabled: ((disabled: boolean) => void) | undefined;
	/** Cleanup returned by a render definition, if it returned one. */
	cleanup: (() => void) | undefined;
}

/**
 * A rendered container, kept for the same reason a row is: its `visible`
 * predicate has to be re-evaluated after every change.
 *
 * The tree flattens here - this Obsidian has no group element to hide - so a
 * container is remembered by the elements it contributed itself (its heading
 * and a list's own affordance rows) plus the ancestors that can hide it in
 * turn. Skipping a hidden container at render time instead, which is what this
 * renderer did first, left it unable to ever appear: turning transcription on
 * revealed nothing, because the blocks it reveals had never been built.
 */
interface RenderedContainer {
	readonly definition: SettingContainer;
	/** Elements this container owns, hidden with it. */
	readonly els: HTMLElement[];
	/** The containers it sits inside, outermost first. */
	readonly ancestors: readonly SettingContainer[];
}

/**
 * Evaluates a `visible`/`disabled` predicate, which may be a plain boolean, a
 * function, or absent.
 * @param predicate - The definition's predicate
 * @param fallback - Value to use when the predicate is absent or throws
 */
function evaluate(
	predicate: boolean | (() => boolean) | undefined,
	fallback: boolean,
): boolean {
	if (predicate === undefined) {
		return fallback;
	}
	if (typeof predicate !== 'function') {
		return predicate;
	}
	try {
		return predicate();
	} catch (error) {
		console.error(error);
		return fallback;
	}
}

/**
 * The elements that answer a click themselves. A row bound to an action listens
 * on the whole row, and a list row carries a delete button inside it, so without
 * this the delete would run and then be read a second time as "the row was
 * clicked" - which on a model catalogue deleted an id and immediately selected
 * it again. What owns the click is the innermost control under the pointer.
 */
const INTERACTIVE_SELECTOR = 'button, input, select, textarea, a';

/**
 * Renders setting definitions with the pre-1.13 API and keeps enough state to
 * refresh their predicates and release what they own.
 */
export class LegacySettingsRenderer {
	private rows: RenderedRow[] = [];

	/** Every rendered group, list, and page, so their predicates can be reapplied. */
	private containers: RenderedContainer[] = [];

	/** The group search field's current query, if one has been typed. */
	private filter:
		| { group: SettingDefinitionGroup; query: string }
		| undefined;

	/**
	 * Creates a renderer bound to a settings store.
	 * @param host - Where rendered controls read and write their values
	 * @param extras - What this renderer cannot build on its own, supplied by
	 * the tab (the folder suggester Obsidian brings from 1.13)
	 */
	constructor(
		private readonly host: LegacySettingsHost,
		private readonly extras?: LegacyRenderExtras,
	) {}

	/**
	 * Clears the container and renders the definitions into it.
	 * @param containerEl - Element the tab body is rendered into
	 * @param items - The tab's definition tree
	 */
	render(
		containerEl: HTMLElement,
		items: readonly SettingDefinitionItem[],
	): void {
		this.release();
		this.filter = undefined;
		containerEl.empty();
		for (const item of items) {
			this.renderItem(containerEl, item, []);
		}
		this.refreshState();
	}

	/**
	 * Re-evaluates every rendered `visible` and `disabled` predicate and applies
	 * the result, the way the framework's `refreshDomState()` does. Containers
	 * are re-evaluated alongside rows, so a block revealed by a switch appears
	 * without rebuilding the tab.
	 */
	refreshState(): void {
		// One evaluation per container, reused by everything inside it: a
		// predicate reads live settings and a row would otherwise re-run every
		// ancestor's.
		const shown = new Map<SettingContainer, boolean>();
		const containerVisible = (
			ancestors: readonly SettingContainer[],
		): boolean =>
			ancestors.every((ancestor) => shown.get(ancestor) === true);
		for (const container of this.containers) {
			shown.set(
				container.definition,
				containerVisible(container.ancestors) &&
					evaluate(container.definition.visible, true),
			);
			const visible = shown.get(container.definition) === true;
			for (const el of container.els) {
				el.toggle(visible);
			}
		}
		for (const row of this.rows) {
			const visible =
				containerVisible(row.ancestors) &&
				evaluate(row.definition.visible, true) &&
				this.matchesFilter(row);
			// Obsidian's own toggle(), which is show()/hide() by another name:
			// a hidden row leaves the layout without needing a class the older
			// stylesheets do not have.
			row.settingEl.toggle(visible);
			const disabled = evaluate(disabledPredicate(row.definition), false);
			row.setDisabled?.(disabled);
		}
	}

	/**
	 * Whether a row passes the search field of the list it belongs to.
	 *
	 * A list's entries are matched, not its rows: where the entries are plain
	 * settings the two are the same thing, but where an entry is an entity with
	 * a page of its own (a profile), the rows on screen are that page's and the
	 * name the user is filtering by is the entry's. Rows the definition marks
	 * unsearchable always show, as they do in the framework.
	 * @param row - The rendered row to test
	 */
	private matchesFilter(row: RenderedRow): boolean {
		const filter = this.filter;
		if (!filter || filter.query === '') {
			return true;
		}
		const entries: readonly unknown[] = filter.group.items ?? [];
		const entry: SettingDefinition | SettingContainer | undefined =
			entries.includes(row.definition)
				? row.definition
				: row.ancestors.find((ancestor) => entries.includes(ancestor));
		// A list's entries are rows or pages, both of which carry a name; a
		// group is neither, so it is not an entry of anything.
		if (!entry || !('name' in entry)) {
			return true;
		}
		if (!evaluate(row.definition.searchable, true)) {
			return true;
		}
		// Matched on the entry's name, so one declared filter serves a list of
		// plain settings and a list of entities alike.
		return (
			filter.group.search?.match({ name: entry.name }, filter.query) ??
			true
		);
	}

	/**
	 * Runs the cleanup every render definition returned and forgets what was
	 * rendered. Called before a re-render and when the tab is left.
	 */
	release(): void {
		for (const row of this.rows) {
			const cleanup = row.cleanup;
			row.cleanup = undefined;
			try {
				cleanup?.();
			} catch (error) {
				console.error(error);
			}
		}
		this.rows = [];
		this.containers = [];
	}

	/**
	 * Renders one item of the tree.
	 *
	 * A container is rendered whether or not its predicate currently holds, and
	 * hidden by {@link refreshState} when it does not, because a container
	 * skipped here could never be revealed by a later change.
	 * @param containerEl - Element to render into
	 * @param item - A definition, a group, a list, or a page
	 * @param ancestors - The containers this item sits inside, outermost first
	 */
	private renderItem(
		containerEl: HTMLElement,
		item: SettingDefinitionItem,
		ancestors: readonly SettingContainer[],
	): void {
		if (!('type' in item)) {
			this.renderDefinition(containerEl, item, 0, ancestors);
			return;
		}
		const els: HTMLElement[] = [];
		this.containers.push({ definition: item, els, ancestors });
		const nested = [...ancestors, item];
		// Groups, lists, and pages all flatten to a heading and its rows: this
		// Obsidian has no group cards and no navigable sub-pages. A page's own
		// name is its heading here, since there is nothing to navigate to.
		const heading = item.type === 'page' ? item.name : item.heading;
		if (heading) {
			const headingRow = new Setting(containerEl)
				.setName(heading)
				.setHeading();
			if (item.type !== 'page' && item.extraButtons) {
				for (const build of item.extraButtons) {
					headingRow.addExtraButton(build);
				}
			}
			els.push(headingRow.settingEl);
		}
		const items = item.items ?? [];
		// Both group shapes declare type as 'group' | 'list', so the tag alone
		// does not narrow the union: read the list affordances through the list
		// shape once the tag says it is one.
		const list =
			item.type === 'list' ? (item as SettingDefinitionList) : undefined;
		if (item.type !== 'page' && item.search && items.length > 0) {
			els.push(this.renderGroupSearch(containerEl, item));
		}
		if (list && items.length === 0 && list.emptyState) {
			const empty = new Setting(containerEl).setName(list.emptyState);
			empty.settingEl.addClass(LEGACY_EMPTY_STATE_CLASS);
			els.push(empty.settingEl);
		}
		items.forEach((child, index) => {
			if ('type' in child) {
				this.renderItem(containerEl, child, nested);
				return;
			}
			this.renderDefinition(containerEl, child, index, nested, {
				...(list?.onDelete ? { onDelete: list.onDelete } : {}),
			});
		});
		if (list?.addItem) {
			els.push(this.renderAddItemRow(containerEl, list.addItem));
		}
	}

	/**
	 * Renders a list's add affordance. Obsidian puts a plus button in the group
	 * header from 1.13 on; this Obsidian has no group header, so it is a row of
	 * its own at the end of the list, which is what the framework does on mobile.
	 * @param containerEl - Element to render into
	 * @param addItem - The list's add-entry configuration
	 * @returns The row, which belongs to the list and is hidden with it
	 */
	private renderAddItemRow(
		containerEl: HTMLElement,
		addItem: { name: string; action: (el: HTMLElement) => void },
	): HTMLElement {
		const setting = new Setting(containerEl).setName(addItem.name);
		setting.settingEl.addClass(LEGACY_ADD_ITEM_CLASS);
		setting.addButton((button) =>
			button.setIcon('lucide-plus').onClick(() => {
				addItem.action(setting.settingEl);
			}),
		);
		return setting.settingEl;
	}

	/**
	 * Renders a group's search field, which filters its rows by the group's own
	 * predicate. The framework keeps the query across re-renders; here the field
	 * lives and dies with the rows it filters, which is the same behaviour for a
	 * list that is only re-rendered when its own data changes.
	 * @param containerEl - Element to render into
	 * @param group - The group whose rows are filtered
	 * @returns The row, which belongs to the group and is hidden with it
	 */
	private renderGroupSearch(
		containerEl: HTMLElement,
		group: SettingDefinitionGroup,
	): HTMLElement {
		const setting = new Setting(containerEl);
		setting.settingEl.addClass(LEGACY_SEARCH_ROW_CLASS);
		setting.addSearch((search) => {
			if (group.search?.placeholder) {
				search.setPlaceholder(group.search.placeholder);
			}
			search.onChange((query) => {
				this.filter = { group, query };
				this.refreshState();
			});
		});
		return setting.settingEl;
	}

	/**
	 * Renders a single setting row.
	 * @param containerEl - Element to render into
	 * @param definition - The setting to render
	 * @param index - The row's position among its siblings, which an action
	 * callback receives
	 * @param ancestors - The containers this row sits inside, outermost first
	 * @param list - The list affordances the row's collection declared, if any
	 */
	private renderDefinition(
		containerEl: HTMLElement,
		definition: SettingDefinition,
		index: number,
		ancestors: readonly SettingContainer[],
		list?: { onDelete?: (index: number) => void },
	): void {
		const setting = new Setting(containerEl).setName(definition.name);
		if (definition.desc) {
			setting.setDesc(definition.desc);
		}
		const row: RenderedRow = {
			definition,
			settingEl: setting.settingEl,
			ancestors,
			setDisabled: undefined,
			cleanup: undefined,
		};
		if (list?.onDelete) {
			const onDelete = list.onDelete;
			setting.addExtraButton((button) =>
				button
					.setIcon('lucide-x')
					.setTooltip('Delete')
					.onClick(() => {
						onDelete(index);
					}),
			);
		}
		if (definition.control) {
			Object.assign(row, {
				setDisabled: this.bindControl(setting, definition.control),
			});
		} else if (definition.action) {
			this.bindAction(setting, definition.action, index);
		} else if (definition.render) {
			// The framework passes the group the row belongs to; nothing in this
			// plugin's render callbacks reads it, and the class it is an instance
			// of does not exist on the Obsidian this renderer serves.
			const cleanup = definition.render(
				setting,
				undefined as unknown as SettingGroup,
			);
			row.cleanup = typeof cleanup === 'function' ? cleanup : undefined;
		}
		this.rows.push(row);
	}

	/**
	 * Makes the whole row run an action when clicked, which is what a 1.13
	 * action row does. The chevron is the affordance that says so.
	 *
	 * A control inside the row keeps its own click: the row's action is what
	 * clicking the row means, not what clicking everything within it means.
	 * @param setting - The row being bound
	 * @param action - The definition's action callback
	 * @param index - The row's position among its siblings
	 */
	private bindAction(
		setting: Setting,
		action: (el: HTMLElement, index: number) => void,
		index: number,
	): void {
		setting.settingEl.addClass(LEGACY_ACTION_ROW_CLASS);
		setting.settingEl.addEventListener('click', (event) => {
			if (
				event.target instanceof Element &&
				event.target.closest(INTERACTIVE_SELECTOR)
			) {
				return;
			}
			action(setting.settingEl, index);
		});
		setIcon(setting.controlEl.createSpan(), 'lucide-chevron-right');
	}

	/**
	 * Renders a control and binds it to the host's read and write hooks.
	 * @param setting - The row the control is added to
	 * @param control - The control to render
	 * @returns A hook applying the row's disabled state, when the control has one
	 */
	private bindControl(
		setting: Setting,
		control: SettingControl,
	): ((disabled: boolean) => void) | undefined {
		const stored = this.host.getControlValue(control.key);
		const write = (value: unknown): void => {
			void this.host.setControlValue(control.key, value);
			// The framework refreshes predicates after every change it persists;
			// a row revealed by this one appears here for the same reason.
			this.refreshState();
		};
		switch (control.type) {
			case 'toggle': {
				let hook: ((disabled: boolean) => void) | undefined;
				setting.addToggle((toggle) => {
					toggle
						.setValue(
							typeof stored === 'boolean'
								? stored
								: (control.defaultValue ?? false),
						)
						.onChange(write);
					hook = (disabled): void => {
						toggle.setDisabled(disabled);
					};
				});
				return hook;
			}
			case 'dropdown': {
				let hook: ((disabled: boolean) => void) | undefined;
				setting.addDropdown((dropdown) => {
					for (const [value, label] of Object.entries(
						control.options,
					)) {
						dropdown.addOption(value, label);
					}
					dropdown
						.setValue(
							typeof stored === 'string'
								? stored
								: (control.defaultValue ?? ''),
						)
						.onChange(write);
					hook = (disabled): void => {
						dropdown.setDisabled(disabled);
					};
				});
				return hook;
			}
			case 'text':
			case 'textarea': {
				return this.bindTextControl(setting, control, stored, write);
			}
			case 'folder': {
				let hook: ((disabled: boolean) => void) | undefined;
				setting.addText((text) => {
					this.extras?.attachFolderSuggest(text.inputEl);
					if (control.placeholder) {
						text.setPlaceholder(control.placeholder);
					}
					text.setValue(
						typeof stored === 'string'
							? stored
							: (control.defaultValue ?? ''),
					).onChange(write);
					hook = (disabled): void => {
						text.setDisabled(disabled);
					};
				});
				return hook;
			}
			case 'number': {
				return this.bindNumberControl(setting, control, stored, write);
			}
			default:
				// Control types this plugin does not use yet render as a plain
				// row rather than as a broken one.
				return undefined;
		}
	}

	/**
	 * Renders a text or text-area control, rejecting values its validator
	 * refuses the way the framework's inline error does.
	 * @param setting - The row the input is added to
	 * @param control - The text control being rendered
	 * @param stored - The current stored value
	 * @param write - Persists an accepted value
	 */
	private bindTextControl(
		setting: Setting,
		control: Extract<SettingControl, { type: 'text' | 'textarea' }>,
		stored: unknown,
		write: (value: string) => void,
	): (disabled: boolean) => void {
		let hook!: (disabled: boolean) => void;
		const bind = (text: {
			inputEl: HTMLInputElement | HTMLTextAreaElement;
			setPlaceholder(value: string): unknown;
			setValue(value: string): unknown;
			onChange(cb: (value: string) => void): unknown;
			setDisabled(disabled: boolean): unknown;
		}): void => {
			if (control.placeholder) {
				text.setPlaceholder(control.placeholder);
			}
			text.setValue(
				typeof stored === 'string'
					? stored
					: (control.defaultValue ?? ''),
			);
			text.onChange((value: string) => {
				const message = control.validate?.(value);
				const invalid = typeof message === 'string' && message !== '';
				text.inputEl.toggleClass(INVALID_INPUT_CLASS, invalid);
				if (invalid) {
					return;
				}
				write(value);
			});
			hook = (disabled): void => {
				text.setDisabled(disabled);
			};
		};
		if (control.type === 'textarea') {
			setting.addTextArea((text) => {
				if (control.rows !== undefined) {
					text.inputEl.rows = control.rows;
				}
				bind(text);
			});
			setting.settingEl.addClass(LEGACY_STACKED_CLASS);
			return hook;
		}
		setting.addText(bind);
		return hook;
	}

	/**
	 * Renders a numeric control as the number input the framework renders,
	 * committing on change and rejecting values outside its bounds.
	 * @param setting - The row the input is added to
	 * @param control - The number control being rendered
	 * @param stored - The current stored value
	 * @param write - Persists an accepted value
	 */
	private bindNumberControl(
		setting: Setting,
		control: Extract<SettingControl, { type: 'number' }>,
		stored: unknown,
		write: (value: number) => void,
	): (disabled: boolean) => void {
		let hook!: (disabled: boolean) => void;
		setting.addText((text) => {
			const input = text.inputEl;
			input.type = 'number';
			input.inputMode = 'decimal';
			if (control.min !== undefined) {
				input.min = String(control.min);
			}
			if (control.max !== undefined) {
				input.max = String(control.max);
			}
			if (control.step !== undefined) {
				input.step = String(control.step);
			}
			input.addClass(NUMBER_INPUT_CLASS);
			const current =
				typeof stored === 'number'
					? stored
					: (control.defaultValue ?? 0);
			text.setValue(String(current));
			input.addEventListener('change', () => {
				// The value space is the control's own declaration, bounds and
				// grid alike, so this Obsidian accepts exactly what 1.13
				// accepts instead of storing what the newer one would refuse.
				const parsed = Number(input.value);
				const rejection = numberControlRejection(control, parsed);
				input.toggleClass(INVALID_INPUT_CLASS, rejection !== undefined);
				if (rejection !== undefined) {
					return;
				}
				write(parsed);
			});
			hook = (disabled): void => {
				text.setDisabled(disabled);
			};
		});
		return hook;
	}
}

/**
 * The disabled predicate of a definition, which lives on the control for a
 * control row and on the definition itself for an action row.
 * @param definition - The definition to read
 */
function disabledPredicate(
	definition: SettingDefinition,
): boolean | (() => boolean) | undefined {
	if (definition.control) {
		return definition.control.disabled;
	}
	return 'disabled' in definition ? definition.disabled : undefined;
}
