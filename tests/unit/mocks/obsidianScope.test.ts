/**
 * Contract tests for the keymap Scope double and the scope the mock Modal
 * makes active while it is open.
 *
 * A dialog that confirms on Enter registers on its scope and relies on the
 * keymap for the rest: which registration a key reaches, what returning false
 * does, and that the scope stops hearing keys once the dialog is closed. Each
 * of those is pinned down here, so a dialog test that passes is passing
 * against the keymap Obsidian has rather than one the double made up.
 * @module tests/unit/mocks/obsidianScope.test
 */

// Imported from the mock by path, not through the 'obsidian' specifier:
// handleKey is the step Obsidian's keymap takes internally, and is
// deliberately absent from the real type definitions.
import { App, Modal, Scope } from '../../mocks/obsidian';

/**
 * A keydown, cancelable so a test can read whether its default was prevented.
 * @param init - The key and modifiers
 * @returns The event, not yet dispatched
 */
function keydown(init: KeyboardEventInit): KeyboardEvent {
	return new KeyboardEvent('keydown', {
		bubbles: true,
		cancelable: true,
		...init,
	});
}

/**
 * A scope, the way a dialog or a view makes one.
 * @param parent - The scope that hears what this one has no listener for
 * @returns The scope
 */
function createSut(parent?: Scope): Scope {
	return new Scope(parent);
}

describe('Scope matching', () => {
	it('runs a listener registered for the key', () => {
		const scope = createSut();
		const listener = jest.fn();
		scope.register([], 'Enter', listener);

		scope.handleKey(keydown({ key: 'Enter' }));

		expect(listener).toHaveBeenCalledTimes(1);
	});

	it('matches a key regardless of case', () => {
		const scope = createSut();
		const listener = jest.fn();
		scope.register(['Mod'], 'K', listener);

		scope.handleKey(keydown({ key: 'k', ctrlKey: true }));

		expect(listener).toHaveBeenCalledTimes(1);
	});

	it.each([
		{ name: 'Shift is held', init: { shiftKey: true } },
		{ name: 'Ctrl is held', init: { ctrlKey: true } },
		{ name: 'Alt is held', init: { altKey: true } },
	])('passes over a plain registration while $name', ({ init }) => {
		const scope = createSut();
		const listener = jest.fn();
		scope.register([], 'Enter', listener);

		scope.handleKey(keydown({ key: 'Enter', ...init }));

		expect(listener).not.toHaveBeenCalled();
	});

	it('answers every modifier combination for a registration of null', () => {
		const scope = createSut();
		const listener = jest.fn();
		scope.register(null, 'Enter', listener);

		scope.handleKey(keydown({ key: 'Enter', shiftKey: true }));

		expect(listener).toHaveBeenCalledTimes(1);
	});

	it('answers every key for a registration without one', () => {
		const scope = createSut();
		const listener = jest.fn();
		scope.register(null, null, listener);

		scope.handleKey(keydown({ key: 'x' }));

		expect(listener).toHaveBeenCalledTimes(1);
	});

	it('runs only the first matching listener', () => {
		const scope = createSut();
		const first = jest.fn();
		const second = jest.fn();
		scope.register([], 'Enter', first);
		scope.register([], 'Enter', second);

		scope.handleKey(keydown({ key: 'Enter' }));

		expect(first).toHaveBeenCalledTimes(1);
		expect(second).not.toHaveBeenCalled();
	});

	it('stops running a listener once it is unregistered', () => {
		const scope = createSut();
		const listener = jest.fn();
		const handler = scope.register([], 'Enter', listener);

		scope.unregister(handler);
		scope.handleKey(keydown({ key: 'Enter' }));

		expect(listener).not.toHaveBeenCalled();
	});

	it('hands a key it has no listener for to its parent', () => {
		const parent = createSut();
		const listener = jest.fn();
		parent.register([], 'Escape', listener);

		createSut(parent).handleKey(keydown({ key: 'Escape' }));

		expect(listener).toHaveBeenCalledTimes(1);
	});
});

describe('Scope results', () => {
	it('prevents the default when the listener returns false', () => {
		const scope = createSut();
		scope.register([], 'Enter', () => false);
		const event = keydown({ key: 'Enter' });

		scope.handleKey(event);

		expect(event.defaultPrevented).toBe(true);
	});

	it.each([
		{ name: 'true', result: true },
		{ name: 'nothing', result: undefined },
	])(
		'leaves the default alone when the listener returns $name',
		({ result }) => {
			const scope = createSut();
			scope.register([], 'Enter', () => result);
			const event = keydown({ key: 'Enter' });

			scope.handleKey(event);

			expect(event.defaultPrevented).toBe(false);
		},
	);

	it('tells the listener which key it was registered for', () => {
		const scope = createSut();
		const listener = jest.fn();
		scope.register(['Shift'], 'Enter', listener);
		const event = keydown({ key: 'Enter', shiftKey: true });

		scope.handleKey(event);

		expect(listener).toHaveBeenCalledWith(event, {
			modifiers: 'Shift',
			key: 'Enter',
			vkey: 'Enter',
		});
	});
});

describe('Modal.scope', () => {
	/** An open dialog with a field in it and an Enter listener on its scope. */
	function openDialog(): {
		modal: Modal;
		field: HTMLElement;
		listener: jest.Mock;
	} {
		const modal = new Modal(new App());
		const field = modal.contentEl.createEl('input');
		const listener = jest.fn();
		modal.scope.register([], 'Enter', listener);
		modal.open();
		return { modal, field, listener };
	}

	it('hears a keydown inside the dialog while it is open', () => {
		const { field, listener } = openDialog();

		field.dispatchEvent(keydown({ key: 'Enter' }));

		expect(listener).toHaveBeenCalledTimes(1);
	});

	it('stops hearing keys once the dialog is closed', () => {
		const { modal, listener } = openDialog();

		modal.close();
		modal.modalEl.dispatchEvent(keydown({ key: 'Enter' }));

		expect(listener).not.toHaveBeenCalled();
	});

	it('hears nothing before the dialog is opened', () => {
		const modal = new Modal(new App());
		const listener = jest.fn();
		modal.scope.register([], 'Enter', listener);

		modal.modalEl.dispatchEvent(keydown({ key: 'Enter' }));

		expect(listener).not.toHaveBeenCalled();
	});
});
