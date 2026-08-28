/**
 * Tests for the DOM extensions the Obsidian mock adds to every element.
 *
 * The double is only useful while it answers the way the real API does, and
 * `value` is the case that proves it: an option built without one cannot be
 * selected, so a select silently refuses every assignment and a test asserting
 * on the chosen value passes against a control that never changed.
 * @module tests/unit/mocks/obsidianDomExtensions.test
 */

import { App, Modal } from 'obsidian';

/** An element carrying the extensions, the way the plugin always sees them. */
function extendedEl(): HTMLElement {
	return new Modal(new App()).contentEl.createDiv();
}

describe('createEl', () => {
	it('sets the value of an option so a select can choose it', () => {
		const select = extendedEl().createEl('select');

		select.createEl('option', { value: '', text: 'No colour' });
		select.createEl('option', { value: 'blue', text: 'Blue' });
		select.value = 'blue';

		expect(select.value).toBe('blue');
	});

	it('leaves a select on its first option until one is chosen', () => {
		const select = extendedEl().createEl('select');

		select.createEl('option', { value: '', text: 'No colour' });
		select.createEl('option', { value: 'red', text: 'Red' });

		expect(select.value).toBe('');
	});

	it('sets the value of an input as a property, not only an attribute', () => {
		const input = extendedEl().createEl('input', {
			value: 'typed',
		});

		expect(input.value).toBe('typed');
	});

	it('falls back to the attribute on an element with no value property', () => {
		const span = extendedEl().createEl('span', { value: 'data' });

		expect(span.getAttribute('value')).toBe('data');
	});

	it('applies text, classes and attributes together', () => {
		const button = extendedEl().createEl('button', {
			text: 'Delete',
			cls: 'aar-thing',
			attr: { 'aria-label': 'Delete marker' },
		});

		expect(button.textContent).toBe('Delete');
		expect(button.hasClass('aar-thing')).toBe(true);
		expect(button.getAttribute('aria-label')).toBe('Delete marker');
	});
});
