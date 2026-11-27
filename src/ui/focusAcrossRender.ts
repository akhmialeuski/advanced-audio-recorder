/**
 * Keeps the keyboard focus where it was when a form of setting rows is
 * emptied and drawn again. The control that had the focus is gone after the
 * redraw, so the focus falls to the page and a keyboard user has to find
 * their place again after every choice that redraws the form. Rows are told
 * apart by their names, which a redraw keeps, and a control by its place
 * among the row's focusable elements.
 * @module ui/focusAcrossRender
 */

/** Elements a row can hand the focus to. */
const FOCUSABLE = 'input, select, textarea, button, [tabindex]';

/** Where the focus was: which row, and which of its controls. */
export interface FocusPlace {
	readonly rowName: string;
	readonly index: number;
}

/**
 * The focusable elements of a setting row, in document order.
 * @param row - The row
 * @returns Its focusable elements
 */
function focusables(row: Element): HTMLElement[] {
	return Array.from(row.querySelectorAll<HTMLElement>(FOCUSABLE));
}

/**
 * Where the focus is inside a form, by row name and control.
 * @param container - The form
 * @returns The place, or null when the focus is outside a named row of it
 */
export function focusPlace(container: HTMLElement): FocusPlace | null {
	const active = activeDocument.activeElement;
	const row = active?.closest('.setting-item');
	const rowName = row?.querySelector('.setting-item-name')?.textContent;
	if (!active || !row || !rowName || !container.contains(row)) {
		return null;
	}
	return { rowName, index: focusables(row).indexOf(active as HTMLElement) };
}

/**
 * Gives the focus back to the same control of the same row after a redraw.
 * Nothing moves when there was no place, or the row is no longer drawn.
 * @param container - The form, drawn again
 * @param place - Where the focus was before the redraw
 */
export function restoreFocus(
	container: HTMLElement,
	place: FocusPlace | null,
): void {
	if (!place) {
		return;
	}
	const row = Array.from(container.querySelectorAll('.setting-item')).find(
		(item) =>
			item.querySelector('.setting-item-name')?.textContent ===
			place.rowName,
	);
	if (row) {
		focusables(row)[place.index]?.focus();
	}
}
