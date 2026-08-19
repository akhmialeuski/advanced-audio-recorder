/**
 * Reading the DOM a component rendered, without the null-checks in every test.
 *
 * `container.querySelector('.x')` types as `Element | null`, so every test that
 * uses it either adds a `?.` that quietly turns a missing element into a passing
 * assertion, or a non-null `!` that fails several lines later with
 * "Cannot read properties of null". These helpers fail at the lookup, naming
 * the selector that found nothing.
 * @module tests/helpers/dom
 */

/**
 * The one element matching a selector, asserting it is there.
 * @param root - Element or document fragment to search under
 * @param selector - CSS selector
 * @returns The matching element
 */
export function el<T extends HTMLElement = HTMLElement>(
	root: ParentNode,
	selector: string,
): T {
	const found = root.querySelector<T>(selector);
	if (!found) {
		throw new Error(
			`Expected an element matching "${selector}", found none`,
		);
	}
	return found;
}

/**
 * The one element matching a selector, or null when the UI omits it.
 *
 * For assertions about absence - a control the current state hides, a progress
 * bar that only appears once saving starts.
 * @param root - Element or document fragment to search under
 * @param selector - CSS selector
 * @returns The matching element, or null
 */
export function maybeEl<T extends HTMLElement = HTMLElement>(
	root: ParentNode,
	selector: string,
): T | null {
	return root.querySelector<T>(selector);
}

/**
 * Every element matching a selector, as an array.
 * @param root - Element or document fragment to search under
 * @param selector - CSS selector
 * @returns The matching elements
 */
export function allEls<T extends HTMLElement = HTMLElement>(
	root: ParentNode,
	selector: string,
): T[] {
	return [...root.querySelectorAll<T>(selector)];
}

/**
 * The text of the one element matching a selector.
 * @param root - Element or document fragment to search under
 * @param selector - CSS selector
 * @returns The element's text content, trimmed of nothing
 */
export function textOf(root: ParentNode, selector: string): string {
	return el(root, selector).textContent ?? '';
}

/**
 * The text of every element matching a selector.
 * @param root - Element or document fragment to search under
 * @param selector - CSS selector
 * @returns One string per matching element
 */
export function textsOf(root: ParentNode, selector: string): string[] {
	return allEls(root, selector).map((node) => node.textContent ?? '');
}

/**
 * A control by the label a screen reader would announce.
 *
 * Every button this plugin renders carries an `aria-label`, so looking one up
 * by that label asserts the accessible name is right at the same time as it
 * finds the element - and survives any CSS rename.
 * @param root - Element to search under
 * @param label - The control's aria-label
 * @returns The control
 */
export function control<T extends HTMLElement = HTMLElement>(
	root: ParentNode,
	label: string,
): T {
	return el<T>(root, `[aria-label="${label}"]`);
}

/**
 * A control by accessible name, or null when the current state hides it.
 * @param root - Element to search under
 * @param label - The control's aria-label
 * @returns The control, or null
 */
export function maybeControl<T extends HTMLElement = HTMLElement>(
	root: ParentNode,
	label: string,
): T | null {
	return maybeEl<T>(root, `[aria-label="${label}"]`);
}

/**
 * The accessible name of every control under an element, in document order.
 * @param root - Element to search under
 * @returns One label per control that has one
 */
export function controlLabels(root: ParentNode): string[] {
	return allEls(root, '[aria-label]').map(
		(node) => node.getAttribute('aria-label') ?? '',
	);
}

/**
 * Clicks the control with the given accessible name.
 * @param root - Element to search under
 * @param label - The control's aria-label
 */
export function clickControl(root: ParentNode, label: string): void {
	control(root, label).click();
}
