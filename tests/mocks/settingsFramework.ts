/**
 * The part of Obsidian that renders a settings tab from its definitions, as the
 * test suite needs it.
 *
 * From 1.13 a tab hands Obsidian a tree of setting definitions and the app does
 * the rest: it builds the rows, binds each control to the tab's
 * `getControlValue`/`setControlValue`, runs the declared validators,
 * re-evaluates the `visible` and `disabled` predicates, and runs the cleanup a
 * render callback returns. None of that ships in the `obsidian` package, so a
 * suite asserting on the rendered tab needs a renderer of its own. This is it,
 * wired into the mock `SettingTab` (see `tests/mocks/obsidian.ts`), which is
 * the only place that constructs one.
 *
 * It models the framework closely enough for the plugin's tests and no closer.
 * A group, a list, or a page renders as a heading followed by its rows, because
 * a test reads the tab as one column; the real app gives a page a navigable
 * sub-page of its own. A list's search field, add row and empty state render as
 * rows of their own with the classes below, so a test can find them.
 * @module tests/mocks/settingsFramework
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

/** Class on a row whose whole surface runs an action when clicked. */
export const FRAMEWORK_ACTION_ROW_CLASS = 'mock-setting-action-row';

/** Class on the row that adds an entry to a list. */
export const FRAMEWORK_ADD_ITEM_CLASS = 'mock-setting-add-item-row';

/** Class on the row shown in place of an empty list. */
export const FRAMEWORK_EMPTY_STATE_CLASS = 'mock-setting-empty-state-row';

/** Class on the row holding a group's search field. */
export const FRAMEWORK_SEARCH_ROW_CLASS = 'mock-setting-search-row';

/** Class on a row whose control is a text area. */
export const FRAMEWORK_STACKED_CLASS = 'mock-setting-stacked';

/** Class on a text input holding a value its validator refused. */
export const FRAMEWORK_INVALID_INPUT_CLASS = 'mock-setting-input-invalid';

/** Class on the line stating why a control refused a value. */
export const FRAMEWORK_SETTING_ERROR_CLASS = 'mock-setting-error';

/** Class on the element a secret control shows the linked secret's ID in. */
export const FRAMEWORK_SECRET_VALUE_CLASS = 'mock-setting-secret-value';

/** Accessible name of the button that unlinks a secret control's secret. */
export const FRAMEWORK_SECRET_UNLINK_LABEL = 'Unlink secret';

/**
 * Largest share of one step a value may miss its grid point by and still count
 * as sitting on it. A grid of tenths cannot be walked in binary floating point
 * - `0.5 + 7 * 0.05` is not `0.85` - so the comparison is made against the
 * nearest grid point rather than by asking whether the quotient is an integer.
 */
const STEP_GRID_TOLERANCE = 1e-6;

/**
 * Why a number is outside what its control accepts, or undefined when it is
 * inside.
 *
 * A number control declares its whole value space: the bounds the value lies
 * between and the grid it sits on, which is `min + n * step`. Obsidian enforces
 * that space itself, refusing anything between two grid points, and this is
 * the same rule. It follows that a bound no grid point reaches is a declaration
 * that cannot be satisfied, which is why the definition tree is tested against
 * it rather than left to be discovered as a setting that will not save.
 * @param control - The number control the value was entered into
 * @param value - The number the field produced
 * @returns The reason it is refused, or undefined when it is accepted
 */
export function numberControlRejection(
	control: {
		min?: number | undefined;
		max?: number | undefined;
		/** `'any'` is the input's own way of declaring no grid at all. */
		step?: number | 'any' | undefined;
	},
	value: number,
): string | undefined {
	if (!Number.isFinite(value)) {
		return 'Enter a number.';
	}
	const { min, max, step } = control;
	if (min !== undefined && value < min) {
		return `Enter ${String(min)} or more.`;
	}
	if (max !== undefined && value > max) {
		return `Enter ${String(max)} or less.`;
	}
	if (step === undefined || step === 'any' || step <= 0) {
		return undefined;
	}
	const base = min ?? 0;
	const snapped = base + Math.round((value - base) / step) * step;
	return Math.abs(value - snapped) > step * STEP_GRID_TOLERANCE
		? `Enter a multiple of ${String(step)}${
				min === undefined ? '' : ` above ${String(min)}`
			}.`
		: undefined;
}

/**
 * The read and write path a rendered control is bound to: the tab's own
 * `getControlValue`/`setControlValue`, as Obsidian calls them.
 */
export interface SettingsFrameworkHost {
	/** Current value of a control key. */
	getControlValue(key: string): unknown;
	/** Persists a new value for a control key. */
	setControlValue(key: string, value: unknown): void | Promise<void>;
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
 * predicate has to be re-evaluated after every change. The tree renders as one
 * column here, so a container is remembered by the elements it contributed
 * itself (its heading and a list's own affordance rows) plus the ancestors that
 * can hide it in turn.
 */
interface RenderedContainer {
	readonly definition: SettingContainer;
	/** Elements this container owns, hidden with it. */
	readonly els: HTMLElement[];
	/** The containers it sits inside, outermost first. */
	readonly ancestors: readonly SettingContainer[];
}

/**
 * Why a control's own validator refuses a value, or undefined when it takes it.
 * Only a synchronous verdict is applied, since nothing in the plugin declares
 * an asynchronous one.
 * @param validate - The control's declared validator, when it has one
 * @param value - The value the control produced
 * @returns The message it is refused with, or undefined when it is accepted
 */
function validatorRejection<V>(
	validate:
		((value: V) => string | void | Promise<string | void>) | undefined,
	value: V,
): string | undefined {
	const message = validate?.(value);
	return typeof message === 'string' && message !== '' ? message : undefined;
}

/**
 * The line a refusal is stated on, created only once there is something to
 * state, under the row's own description.
 * @param setting - The row being reported on
 * @returns Shows a message, or clears the line when given undefined
 */
function rejectionReporter(
	setting: Setting,
): (message: string | undefined) => void {
	let errorEl: HTMLElement | null = null;
	return (message): void => {
		if (!errorEl) {
			if (message === undefined) {
				return;
			}
			errorEl = setting.descEl.createDiv({
				cls: FRAMEWORK_SETTING_ERROR_CLASS,
			});
		}
		errorEl.setText(message ?? '');
		errorEl.toggle(message !== undefined);
	};
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
 * Renders setting definitions the way Obsidian's settings framework does, and
 * keeps enough state to refresh their predicates and release what they own.
 */
export class SettingsFramework {
	private rows: RenderedRow[] = [];

	/** Every rendered group, list, and page, so their predicates can be reapplied. */
	private containers: RenderedContainer[] = [];

	/**
	 * The query typed into each group's search field. One per group, since the
	 * tree renders as one column and every list's filter is on screen at once.
	 */
	private readonly filters = new Map<SettingDefinitionGroup, string>();

	/**
	 * Creates a renderer bound to a settings tab.
	 * @param host - Where rendered controls read and write their values
	 */
	constructor(private readonly host: SettingsFrameworkHost) {}

	/**
	 * Clears the container and renders the definitions into it, releasing the
	 * previous rows first, which is what Obsidian does on every `update()`.
	 * @param containerEl - Element the tab body is rendered into
	 * @param items - The tab's definition tree
	 */
	render(
		containerEl: HTMLElement,
		items: readonly SettingDefinitionItem[],
	): void {
		this.release();
		containerEl.empty();
		for (const item of items) {
			this.renderItem(containerEl, item, []);
		}
		this.refreshState();
	}

	/**
	 * Re-evaluates every rendered `visible` and `disabled` predicate and applies
	 * the result in place: `SettingTab.refreshDomState()`.
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
			row.settingEl.toggle(visible);
			const disabled = evaluate(disabledPredicate(row.definition), false);
			row.setDisabled?.(disabled);
		}
	}

	/**
	 * Whether a row passes the search field of every group that filters it. A
	 * group filters only its own entries, and rows the definition marks
	 * unsearchable always show.
	 * @param row - The rendered row to test
	 */
	private matchesFilter(row: RenderedRow): boolean {
		if (!evaluate(row.definition.searchable, true)) {
			return true;
		}
		for (const [group, query] of this.filters) {
			const entry = query === '' ? undefined : entryOf(group, row);
			if (
				entry &&
				!(group.search?.match({ name: entry.name }, query) ?? true)
			) {
				return false;
			}
		}
		return true;
	}

	/**
	 * Runs the cleanup every render definition returned and forgets what was
	 * rendered. Called before a re-render and when the tab is hidden.
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
		this.filters.clear();
	}

	/**
	 * Renders one item of the tree. A container is rendered whether or not its
	 * predicate currently holds and hidden by {@link refreshState} when it does
	 * not, so a later change can reveal it.
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
			empty.settingEl.addClass(FRAMEWORK_EMPTY_STATE_CLASS);
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
	 * Renders a list's add affordance as a row closing the list, which is what
	 * Obsidian draws on mobile and the shape a test finds most easily.
	 * @param containerEl - Element to render into
	 * @param addItem - The list's add-entry configuration
	 * @returns The row, which belongs to the list and is hidden with it
	 */
	private renderAddItemRow(
		containerEl: HTMLElement,
		addItem: { name: string; action: (el: HTMLElement) => void },
	): HTMLElement {
		const setting = new Setting(containerEl).setName(addItem.name);
		setting.settingEl.addClass(FRAMEWORK_ADD_ITEM_CLASS);
		setting.addButton((button) =>
			button.setIcon('lucide-plus').onClick(() => {
				addItem.action(setting.settingEl);
			}),
		);
		return setting.settingEl;
	}

	/**
	 * Renders a group's search field, which filters its rows by the group's own
	 * predicate.
	 * @param containerEl - Element to render into
	 * @param group - The group whose rows are filtered
	 * @returns The row, which belongs to the group and is hidden with it
	 */
	private renderGroupSearch(
		containerEl: HTMLElement,
		group: SettingDefinitionGroup,
	): HTMLElement {
		const setting = new Setting(containerEl);
		setting.settingEl.addClass(FRAMEWORK_SEARCH_ROW_CLASS);
		setting.addSearch((search) => {
			if (group.search?.placeholder) {
				search.setPlaceholder(group.search.placeholder);
			}
			search.onChange((query) => {
				this.filters.set(group, query);
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
			setting.addExtraButton((button) => {
				button.setIcon('lucide-x').setTooltip('Delete');
				// A delete ends the click where it lands, as Obsidian's does, so
				// a row with an action of its own does not also run it.
				button.extraSettingsEl.addEventListener('click', (event) => {
					event.stopPropagation();
					onDelete(index);
				});
			});
		}
		if (definition.control) {
			Object.assign(row, {
				setDisabled: this.bindControl(setting, definition.control),
			});
		} else if (definition.action) {
			this.bindAction(setting, definition.action, index);
		} else if (definition.render) {
			// The framework passes the group the row belongs to; nothing in the
			// plugin's render callbacks reads it.
			const cleanup = definition.render(
				setting,
				undefined as unknown as SettingGroup,
			);
			row.cleanup = typeof cleanup === 'function' ? cleanup : undefined;
		}
		this.rows.push(row);
	}

	/**
	 * Makes the whole row run an action when clicked, with the chevron that says
	 * so.
	 * @param setting - The row being bound
	 * @param action - The definition's action callback
	 * @param index - The row's position among its siblings
	 */
	private bindAction(
		setting: Setting,
		action: (el: HTMLElement, index: number) => void,
		index: number,
	): void {
		setting.settingEl.addClass(FRAMEWORK_ACTION_ROW_CLASS);
		setting.settingEl.addEventListener('click', () => {
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
		const report = rejectionReporter(setting);
		const persist = (value: unknown): void => {
			void this.host.setControlValue(control.key, value);
			// The framework refreshes predicates after every change it persists.
			this.refreshState();
		};
		switch (control.type) {
			case 'toggle': {
				let hook: ((disabled: boolean) => void) | undefined;
				setting.addToggle((toggle) => {
					const seed =
						typeof stored === 'boolean'
							? stored
							: (control.defaultValue ?? false);
					toggle.setValue(seed).onChange(
						guardedWrite({
							seed,
							rejectionOf: (value) =>
								validatorRejection(control.validate, value),
							report,
							restore: () => {
								toggle.setValue(seed);
							},
							write: persist,
						}),
					);
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
					const seed =
						typeof stored === 'string'
							? stored
							: (control.defaultValue ?? '');
					dropdown.setValue(seed).onChange(
						guardedWrite({
							seed,
							rejectionOf: (value) =>
								validatorRejection(control.validate, value),
							report,
							restore: () => {
								dropdown.setValue(seed);
							},
							write: persist,
						}),
					);
					hook = (disabled): void => {
						dropdown.setDisabled(disabled);
					};
				});
				return hook;
			}
			case 'text':
			case 'textarea':
			case 'folder':
			case 'file':
				// The two path controls are text fields with a suggester the
				// app draws under them; the value is the path as typed.
				return this.bindTextControl(setting, control, stored, {
					report,
					persist,
				});
			case 'number':
				return this.bindNumberControl(setting, control, stored, {
					report,
					persist,
				});
			case 'secret':
				return this.bindSecretControl(setting, control, stored, {
					report,
					persist,
				});
			default:
				// Control types the plugin does not use render as a plain row.
				return undefined;
		}
	}

	/**
	 * Renders a text, text-area, folder or file control, rejecting values its
	 * validator refuses.
	 * @param setting - The row the input is added to
	 * @param control - The text control being rendered
	 * @param stored - The current stored value
	 * @param hooks - Where a refusal is reported and an accepted value stored
	 */
	private bindTextControl(
		setting: Setting,
		control: Extract<
			SettingControl,
			{ type: 'text' | 'textarea' | 'folder' | 'file' }
		>,
		stored: unknown,
		hooks: ControlWriteHooks,
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
			const seed =
				typeof stored === 'string'
					? stored
					: (control.defaultValue ?? '');
			text.setValue(seed);
			text.onChange(
				guardedWrite({
					seed,
					rejectionOf: (value: string) =>
						validatorRejection(control.validate, value),
					report: markingInput(text.inputEl, hooks.report),
					write: hooks.persist,
				}),
			);
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
			setting.settingEl.addClass(FRAMEWORK_STACKED_CLASS);
			return hook;
		}
		setting.addText(bind);
		return hook;
	}

	/**
	 * Renders a numeric control as a number input, committing on change and
	 * rejecting values its declaration refuses.
	 * @param setting - The row the input is added to
	 * @param control - The number control being rendered
	 * @param stored - The current stored value
	 * @param hooks - Where a refusal is reported and an accepted value stored
	 */
	private bindNumberControl(
		setting: Setting,
		control: Extract<SettingControl, { type: 'number' }>,
		stored: unknown,
		hooks: ControlWriteHooks,
	): (disabled: boolean) => void {
		let hook!: (disabled: boolean) => void;
		setting.addText((text) => {
			const input = text.inputEl;
			input.type = 'number';
			if (control.min !== undefined) {
				input.min = String(control.min);
			}
			if (control.max !== undefined) {
				input.max = String(control.max);
			}
			if (control.step !== undefined) {
				input.step = String(control.step);
			}
			const seed =
				typeof stored === 'number'
					? stored
					: (control.defaultValue ?? 0);
			text.setValue(String(seed));
			const commit = guardedWrite({
				seed,
				rejectionOf: (value: number) =>
					numberControlRejection(control, value) ??
					validatorRejection(control.validate, value),
				report: markingInput(input, hooks.report),
				write: hooks.persist,
			});
			input.addEventListener('change', () => {
				commit(Number(input.value));
			});
			hook = (disabled): void => {
				text.setDisabled(disabled);
			};
		});
		return hook;
	}

	/**
	 * Renders a secret control: the stand-in for Obsidian's keychain picker.
	 *
	 * The real control opens a modal that lists the keychain and can add to it,
	 * and writes the chosen secret's ID; it shows a masked value when that secret
	 * exists, nothing when it does not, and an unlink button that writes null.
	 * The stand-in keeps the part a test reads and the part that reaches the tab:
	 * it shows the stored ID, and its unlink button writes null exactly as the
	 * real one does. Choosing a secret is driven through the tab's own
	 * `setControlValue`, which is where the real picker's choice arrives.
	 * @param setting - The row the control is added to
	 * @param control - The secret control being rendered
	 * @param stored - The current stored value, the linked secret's ID
	 * @param hooks - Where a refusal is reported and an accepted value stored
	 * @returns A hook applying the row's disabled state
	 */
	private bindSecretControl(
		setting: Setting,
		control: Extract<SettingControl, { type: 'secret' }>,
		stored: unknown,
		hooks: ControlWriteHooks,
	): (disabled: boolean) => void {
		const id =
			typeof stored === 'string' ? stored : (control.defaultValue ?? '');
		const valueEl = setting.controlEl.createDiv({
			cls: FRAMEWORK_SECRET_VALUE_CLASS,
			text: id,
		});
		const unlink = setting.controlEl.createEl('button', {
			attr: { 'aria-label': FRAMEWORK_SECRET_UNLINK_LABEL },
		});
		const write = guardedWrite<string | null>({
			seed: id,
			rejectionOf: (value) =>
				value === null
					? undefined
					: validatorRejection(control.validate, value),
			report: hooks.report,
			write: hooks.persist,
		});
		unlink.addEventListener('click', () => {
			if (unlink.disabled) {
				return;
			}
			valueEl.setText('');
			write(null);
		});
		return (disabled): void => {
			unlink.disabled = disabled;
			valueEl.toggleClass('is-disabled', disabled);
		};
	}
}

/** Where a bound control reports a refusal and stores an accepted value. */
interface ControlWriteHooks {
	/** States why a value was refused, or clears the statement. */
	readonly report: (message: string | undefined) => void;
	/** Persists an accepted value and refreshes the tab's predicates. */
	readonly persist: (value: unknown) => void;
}

/** How one control's writes are guarded. */
interface GuardedWrite<V> {
	/** The value the control was rendered holding. */
	readonly seed: V;
	/** Why a candidate is refused, or undefined when it is accepted. */
	readonly rejectionOf: (value: V) => string | undefined;
	/** States the refusal on the row. */
	readonly report: (message: string | undefined) => void;
	/** Puts a control whose value space is discrete back to what is stored. */
	readonly restore?: (() => void) | undefined;
	/** Persists an accepted value. */
	readonly write: (value: V) => void;
}

/**
 * The write path of one control: what its declaration refuses is not stored,
 * the reason is stated on the row, and a control whose value space is discrete
 * is put back to what actually is stored. The seeded value is checked once as
 * the row is built and reported, never rewritten.
 * @param guard - The seed, the rule, and where the outcome goes
 * @returns The control's onChange handler
 */
function guardedWrite<V>(guard: GuardedWrite<V>): (value: V) => void {
	guard.report(guard.rejectionOf(guard.seed));
	// Restoring a control re-enters its own change handler, whose components
	// notify on setValue; without this the put-back would be stored.
	let restoring = false;
	return (value: V): void => {
		if (restoring) {
			return;
		}
		const rejection = guard.rejectionOf(value);
		guard.report(rejection);
		if (rejection === undefined) {
			guard.write(value);
			return;
		}
		restoring = true;
		try {
			guard.restore?.();
		} finally {
			restoring = false;
		}
	};
}

/**
 * A reporter that also marks the input a refused value sits in.
 * @param inputEl - The field holding the value
 * @param report - The row's own reporter
 */
function markingInput(
	inputEl: HTMLInputElement | HTMLTextAreaElement,
	report: (message: string | undefined) => void,
): (message: string | undefined) => void {
	return (message): void => {
		inputEl.toggleClass(
			FRAMEWORK_INVALID_INPUT_CLASS,
			message !== undefined,
		);
		report(message);
	};
}

/**
 * The entry of a group that a rendered row speaks for, or undefined when the
 * row belongs to some other part of the tree. Where an entry is an entity with
 * a page of its own (a profile), the rows on screen are that page's while the
 * name the user is filtering by is the entry's.
 * @param group - The group whose entries are being looked through
 * @param row - The rendered row to place
 */
function entryOf(
	group: SettingDefinitionGroup,
	row: RenderedRow,
): { name: string } | undefined {
	const entries: readonly unknown[] = group.items ?? [];
	const entry: SettingDefinition | SettingContainer | undefined =
		entries.includes(row.definition)
			? row.definition
			: row.ancestors.find((ancestor) => entries.includes(ancestor));
	return entry && 'name' in entry ? entry : undefined;
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
