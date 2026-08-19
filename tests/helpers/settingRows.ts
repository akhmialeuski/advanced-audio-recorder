/**
 * Reading a rendered settings tab the way a user looks at one.
 *
 * Obsidian renders every setting as a `.setting-item` with its name in a
 * `.setting-item-name` and its control somewhere inside, and the tests care
 * about "the Debug mode row's toggle", not about that structure. Naming the
 * lookups here keeps Obsidian's own class names out of the tests, and gives a
 * failure that says which row was missing rather than "cannot read properties
 * of null".
 * @module tests/helpers/settingRows
 */

import { allEls, el, maybeEl, textsOf } from './dom';
import { SETTING } from './selectors';

/** The names of the rows rendered into a container, in order. */
export function settingNames(container: ParentNode): string[] {
	return textsOf(container, SETTING.name)
		.map((name) => name.trim())
		.filter((name) => name.length > 0);
}

/**
 * The row carrying a given setting name.
 * @param container - The tab or group the rows were rendered into
 * @param name - The setting's name, as the user reads it
 * @returns The row element
 */
export function settingRow(container: ParentNode, name: string): HTMLElement {
	const row = allEls(container, SETTING.item).find(
		(candidate) =>
			maybeEl(candidate, SETTING.name)?.textContent?.trim() === name,
	);
	if (!row) {
		throw new Error(
			`Row not rendered: "${name}". Rendered rows: ` +
				(settingNames(container).join(', ') || '(none)'),
		);
	}
	return row;
}

/** The row's description, as the user reads it. */
export function rowDescription(row: ParentNode): string {
	return maybeEl(row, SETTING.description)?.textContent ?? '';
}

/** The row's text or number input. */
export function rowInput(row: ParentNode): HTMLInputElement {
	return el<HTMLInputElement>(row, 'input');
}

/** The row's dropdown. */
export function rowSelect(row: ParentNode): HTMLSelectElement {
	return el<HTMLSelectElement>(row, 'select');
}

/** The options the row's dropdown offers, as the user reads them. */
export function rowOptions(row: ParentNode): string[] {
	return textsOf(row, 'option');
}

/** The row's multi-line input. */
export function rowTextarea(row: ParentNode): HTMLTextAreaElement {
	return el<HTMLTextAreaElement>(row, 'textarea');
}

/** The row's toggle, which Obsidian renders as a clickable container. */
export function rowToggle(row: ParentNode): HTMLElement {
	return el(row, SETTING.checkbox);
}

/**
 * The row's button, by its text when the row has more than one.
 * @param row - The setting row
 * @param text - The button's label, when the row offers several
 * @returns The button
 */
export function rowButton(row: ParentNode, text?: string): HTMLElement {
	const buttons = allEls(row, 'button');
	const match =
		text === undefined
			? buttons[0]
			: buttons.find((button) => button.textContent?.trim() === text);
	if (!match) {
		throw new Error(
			`No button${text === undefined ? '' : ` labelled "${text}"`} in ` +
				`this row. Buttons: ` +
				(buttons
					.map((one) => `"${one.textContent ?? ''}"`)
					.join(', ') || '(none)'),
		);
	}
	return match;
}

/** Whether the container rendered a row with this name at all. */
export function hasSettingRow(container: ParentNode, name: string): boolean {
	return settingNames(container).includes(name);
}
