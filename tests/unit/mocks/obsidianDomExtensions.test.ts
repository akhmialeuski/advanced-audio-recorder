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
import { flushMicrotasks } from '../../helpers/async';
import { addObsidianDomExtensions } from '../../mocks/domExtensions';

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

/**
 * A second window standing in for a pop-out: an iframe's, which jsdom gives a
 * document, a requestAnimationFrame and a devicePixelRatio of its own.
 * @returns The pop-out window
 */
function popoutWindow(): Window {
	const frame = document.body.appendChild(document.createElement('iframe'));
	const win = frame.contentWindow;
	if (!win) {
		throw new Error('jsdom gave the iframe no window');
	}
	return win;
}

describe('win and doc', () => {
	afterEach(() => {
		document.body.innerHTML = '';
	});

	it('answer the main window and document for an element shown there', () => {
		const element = document.body.appendChild(extendedEl());

		expect(element.win).toBe(window);
		expect(element.doc).toBe(document);
	});

	it('answer the pop-out window for an element moved into one', () => {
		const popout = popoutWindow();
		const element = extendedEl();

		popout.document.body.appendChild(element);

		expect(element.win).toBe(popout);
		expect(element.doc).toBe(popout.document);
	});

	// Obsidian falls back to the global window, which is what a document made
	// for a test without one of its own has to read as.
	it('fall back to the main window for a document without one', () => {
		const doc = document.implementation.createHTMLDocument('detached');
		const element = addObsidianDomExtensions(doc.createElement('div'));

		expect(element.win).toBe(window);
	});
});

describe('onNodeInserted', () => {
	afterEach(() => {
		document.body.innerHTML = '';
	});

	it('calls back once the element is inserted', async () => {
		const element = extendedEl();
		const listener = jest.fn();
		element.onNodeInserted(listener);

		document.body.appendChild(element);
		await flushMicrotasks();

		expect(listener).toHaveBeenCalledTimes(1);
	});

	it('calls back when an ancestor brings the element in', async () => {
		const parent = extendedEl();
		const element = parent.createDiv();
		const listener = jest.fn();
		element.onNodeInserted(listener);

		document.body.appendChild(parent);
		await flushMicrotasks();

		expect(listener).toHaveBeenCalledTimes(1);
	});

	// The real event comes from an animation starting, which is never in the
	// same task as the insertion that caused it.
	it('does not call back in the same task as the insertion', () => {
		const element = extendedEl();
		const listener = jest.fn();
		element.onNodeInserted(listener);

		document.body.appendChild(element);

		expect(listener).not.toHaveBeenCalled();
	});

	it('stays quiet while the element is still detached', async () => {
		const element = extendedEl();
		const listener = jest.fn();
		element.onNodeInserted(listener);

		document.body.appendChild(extendedEl());
		await flushMicrotasks();

		expect(listener).not.toHaveBeenCalled();
	});

	it('calls back on every re-insertion', async () => {
		const element = extendedEl();
		const listener = jest.fn();
		element.onNodeInserted(listener);

		document.body.appendChild(element);
		await flushMicrotasks();
		element.remove();
		await flushMicrotasks();
		document.body.appendChild(element);
		await flushMicrotasks();

		expect(listener).toHaveBeenCalledTimes(2);
	});

	it('calls back only for the first insertion when asked for once', async () => {
		const element = extendedEl();
		const listener = jest.fn();
		element.onNodeInserted(listener, true);

		document.body.appendChild(element);
		await flushMicrotasks();
		element.remove();
		await flushMicrotasks();
		document.body.appendChild(element);
		await flushMicrotasks();

		expect(listener).toHaveBeenCalledTimes(1);
	});

	it('stops calling back once unregistered', async () => {
		const element = extendedEl();
		const listener = jest.fn();
		const unregister = element.onNodeInserted(listener);

		unregister();
		document.body.appendChild(element);
		await flushMicrotasks();

		expect(listener).not.toHaveBeenCalled();
	});

	it('hears an insertion into a pop-out document', async () => {
		const popout = popoutWindow();
		const element = addObsidianDomExtensions(
			popout.document.createElement('div'),
		);
		const listener = jest.fn();
		element.onNodeInserted(listener);

		popout.document.body.appendChild(element);
		await flushMicrotasks();

		expect(listener).toHaveBeenCalledTimes(1);
	});

	// A suite that swaps the global to count the plugin's own observers must
	// not count this one, which stands in for a CSS animation.
	it('uses no observer a suite installed after it', async () => {
		const installed = jest.spyOn(window, 'MutationObserver');
		const element = extendedEl();
		const listener = jest.fn();

		element.onNodeInserted(listener);
		document.body.appendChild(element);
		await flushMicrotasks();

		expect(installed).not.toHaveBeenCalled();
		expect(listener).toHaveBeenCalledTimes(1);
	});

	// Obsidian's animation restarts whenever the element is rendered afresh,
	// and a widget taken out and put straight back is rendered afresh.
	it('calls back for an element removed and put back in one go', async () => {
		const element = document.body.appendChild(extendedEl());
		const listener = jest.fn();
		element.onNodeInserted(listener);

		element.remove();
		document.body.appendChild(element);
		await flushMicrotasks();

		expect(listener).toHaveBeenCalledTimes(1);
	});
});

describe('onWindowMigrated', () => {
	afterEach(() => {
		document.body.innerHTML = '';
	});

	it('calls back with the new window when the element moves to a pop-out', async () => {
		const popout = popoutWindow();
		const element = document.body.appendChild(extendedEl());
		const listener = jest.fn();
		element.onWindowMigrated(listener);

		popout.document.body.appendChild(element);
		await flushMicrotasks();

		expect(listener).toHaveBeenCalledWith(popout);
	});

	it('stays quiet for a re-insertion into the same window', async () => {
		const element = document.body.appendChild(extendedEl());
		const listener = jest.fn();
		element.onWindowMigrated(listener);

		element.remove();
		await flushMicrotasks();
		document.body.appendChild(element);
		await flushMicrotasks();

		expect(listener).not.toHaveBeenCalled();
	});

	it('calls back again when the element moves back', async () => {
		const popout = popoutWindow();
		const element = document.body.appendChild(extendedEl());
		const listener = jest.fn();
		element.onWindowMigrated(listener);

		popout.document.body.appendChild(element);
		await flushMicrotasks();
		document.body.appendChild(element);
		await flushMicrotasks();

		expect(listener).toHaveBeenCalledTimes(2);
		expect(listener).toHaveBeenLastCalledWith(window);
	});

	it('stops calling back once unregistered', async () => {
		const popout = popoutWindow();
		const element = document.body.appendChild(extendedEl());
		const listener = jest.fn();
		const unregister = element.onWindowMigrated(listener);

		unregister();
		popout.document.body.appendChild(element);
		await flushMicrotasks();

		expect(listener).not.toHaveBeenCalled();
	});
});
