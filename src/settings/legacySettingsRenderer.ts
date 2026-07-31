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
 * another row does it here too without rebuilding the tab.
 * @module settings/legacySettingsRenderer
 */

import { Setting, setIcon } from 'obsidian';
import type {
	SettingControl,
	SettingDefinition,
	SettingDefinitionItem,
	SettingGroup,
} from 'obsidian';

/** Class applied to a row whose whole surface runs an action when clicked. */
export const LEGACY_ACTION_ROW_CLASS = 'aar-action-row';

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

/** A rendered row, kept so its predicates can be re-evaluated in place. */
interface RenderedRow {
	readonly definition: SettingDefinition;
	readonly settingEl: HTMLElement;
	/** Applies a disabled state to the row's control, when it has one. */
	readonly setDisabled: ((disabled: boolean) => void) | undefined;
	/** Cleanup returned by a render definition, if it returned one. */
	cleanup: (() => void) | undefined;
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
 * Renders setting definitions with the pre-1.13 API and keeps enough state to
 * refresh their predicates and release what they own.
 */
export class LegacySettingsRenderer {
	private rows: RenderedRow[] = [];

	/**
	 * Creates a renderer bound to a settings store.
	 * @param host - Where rendered controls read and write their values
	 */
	constructor(private readonly host: LegacySettingsHost) {}

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
		containerEl.empty();
		for (const item of items) {
			this.renderItem(containerEl, item);
		}
		this.refreshState();
	}

	/**
	 * Re-evaluates every rendered row's `visible` and `disabled` predicate and
	 * applies the result, the way the framework's `refreshDomState()` does.
	 */
	refreshState(): void {
		for (const row of this.rows) {
			const visible = evaluate(row.definition.visible, true);
			// Obsidian's own show()/hide() toggle the inline display, and doing
			// the same keeps a hidden row out of the layout without needing a
			// class the older stylesheets do not have.
			row.settingEl.style.display = visible ? '' : 'none';
			const disabled = evaluate(disabledPredicate(row.definition), false);
			row.setDisabled?.(disabled);
		}
	}

	/**
	 * Runs the cleanup every render definition returned and forgets the rows.
	 * Called before a re-render and when the tab is left.
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
	}

	/**
	 * Renders one item of the tree.
	 * @param containerEl - Element to render into
	 * @param item - A definition, a group, a list, or a page
	 */
	private renderItem(
		containerEl: HTMLElement,
		item: SettingDefinitionItem,
	): void {
		if (!('type' in item)) {
			this.renderDefinition(containerEl, item, 0);
			return;
		}
		if (!evaluate(item.visible, true)) {
			return;
		}
		// Groups, lists, and pages all flatten to a heading and its rows: this
		// Obsidian has no group cards and no navigable sub-pages. A page's own
		// name is its heading here, since there is nothing to navigate to.
		const heading = item.type === 'page' ? item.name : item.heading;
		if (heading) {
			new Setting(containerEl).setName(heading).setHeading();
		}
		const items = item.items ?? [];
		items.forEach((child, index) => {
			if ('type' in child) {
				this.renderItem(containerEl, child);
				return;
			}
			this.renderDefinition(containerEl, child, index);
		});
	}

	/**
	 * Renders a single setting row.
	 * @param containerEl - Element to render into
	 * @param definition - The setting to render
	 * @param index - The row's position among its siblings, which an action
	 * callback receives
	 */
	private renderDefinition(
		containerEl: HTMLElement,
		definition: SettingDefinition,
		index: number,
	): void {
		const setting = new Setting(containerEl).setName(definition.name);
		if (definition.desc) {
			setting.setDesc(definition.desc);
		}
		const row: RenderedRow = {
			definition,
			settingEl: setting.settingEl,
			setDisabled: undefined,
			cleanup: undefined,
		};
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
			input.addClass('aar-number-input');
			const current =
				typeof stored === 'number'
					? stored
					: (control.defaultValue ?? 0);
			text.setValue(String(current));
			input.addEventListener('change', () => {
				const parsed = Number(input.value);
				const outOfRange =
					Number.isNaN(parsed) ||
					(control.min !== undefined && parsed < control.min) ||
					(control.max !== undefined && parsed > control.max);
				input.toggleClass(INVALID_INPUT_CLASS, outOfRange);
				if (outOfRange) {
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
