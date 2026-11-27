/**
 * Tests that a redrawn form gives the focus back to the control that had it,
 * found by the name of its row and its place in the row.
 * @module tests/unit/focusAcrossRender.test
 */

import { focusPlace, restoreFocus } from 'src/ui/focusAcrossRender';

/**
 * Draws a form of named rows, each with a list and a button, into the page.
 * @param container - Where the rows go, emptied first
 * @param names - The rows' names
 */
function draw(container: HTMLElement, names: readonly string[]): void {
	container.replaceChildren(
		...names.map((name) => {
			const row = document.createElement('div');
			row.className = 'setting-item';
			const label = document.createElement('div');
			label.className = 'setting-item-name';
			label.textContent = name;
			row.append(
				label,
				document.createElement('select'),
				document.createElement('button'),
			);
			return row;
		}),
	);
}

/**
 * The control of a row at a place.
 * @param container - The form
 * @param row - Position of the row
 * @param index - Position of the control in the row
 * @returns The control
 */
function control(
	container: HTMLElement,
	row: number,
	index: number,
): HTMLElement {
	const item = container.querySelectorAll('.setting-item')[row];
	return item?.querySelectorAll<HTMLElement>('select, button')[
		index
	] as HTMLElement;
}

describe('the focus across a redraw of a form', () => {
	let container: HTMLElement;

	beforeEach(() => {
		container = document.createElement('div');
		document.body.appendChild(container);
	});

	afterEach(() => {
		container.remove();
	});

	it('goes back to the same control of the same row', () => {
		draw(container, ['Preset', 'Language']);
		control(container, 0, 1).focus();

		const place = focusPlace(container);
		draw(container, ['Preset', 'Language']);
		restoreFocus(container, place);

		expect(document.activeElement).toBe(control(container, 0, 1));
	});

	it('follows its row when a redraw adds rows above it', () => {
		draw(container, ['Preset', 'Language']);
		control(container, 1, 0).focus();

		const place = focusPlace(container);
		draw(container, ['Preset', 'Engine', 'Language']);
		restoreFocus(container, place);

		expect(document.activeElement).toBe(control(container, 2, 0));
	});

	it('stays where the page put it when its row is no longer drawn', () => {
		draw(container, ['Preset', 'Speakers']);
		control(container, 1, 0).focus();

		const place = focusPlace(container);
		draw(container, ['Preset']);
		restoreFocus(container, place);

		expect(document.activeElement).toBe(document.body);
	});

	it('records no place when the focus is outside the form', () => {
		const outside = document.createElement('button');
		document.body.appendChild(outside);
		draw(container, ['Preset']);
		outside.focus();

		expect(focusPlace(container)).toBeNull();
		outside.remove();
	});

	it('moves nothing when there was no place to go back to', () => {
		draw(container, ['Preset']);

		restoreFocus(container, null);

		expect(document.activeElement).toBe(document.body);
	});
});
