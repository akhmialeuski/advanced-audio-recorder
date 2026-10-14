/**
 * Contract tests for the Component double in the obsidian mock.
 *
 * The player scopes everything a render pass sets up to a child Component it
 * adds per render and removes on the next one, so a re-render that leaves a
 * listener behind is only caught if the double unloads children, runs their
 * registrations, and removes a DOM listener the way it was added.
 * @module tests/unit/mocks/obsidianComponent.test
 */

import { Component } from 'obsidian';

/** A loaded parent with one child added, as a render pass builds them. */
function createSut(): { parent: Component; child: Component } {
	const parent = new Component();
	parent.load();
	const child = parent.addChild(new Component());
	return { parent, child };
}

describe('Component children', () => {
	it('loads a child added to a loaded parent', () => {
		const parent = new Component();
		parent.load();
		const child = new Component();
		const onload = jest.spyOn(child, 'onload');

		parent.addChild(child);

		expect(onload).toHaveBeenCalledTimes(1);
	});

	it('defers loading a child until its parent loads', () => {
		const parent = new Component();
		const child = new Component();
		const onload = jest.spyOn(child, 'onload');
		parent.addChild(child);

		expect(onload).not.toHaveBeenCalled();

		parent.load();

		expect(onload).toHaveBeenCalledTimes(1);
	});

	it('runs the registrations of a removed child', () => {
		const { parent, child } = createSut();
		const cleanup = jest.fn();
		child.register(cleanup);

		parent.removeChild(child);

		expect(cleanup).toHaveBeenCalledTimes(1);
	});

	it('runs the registrations of every child when the parent unloads', () => {
		const { parent, child } = createSut();
		const cleanup = jest.fn();
		child.register(cleanup);

		parent.unload();

		expect(cleanup).toHaveBeenCalledTimes(1);
	});

	// A child that was never loaded has nothing to unload, which is why the
	// player loads its render child itself rather than relying on its own load.
	it('runs nothing for a child that was never loaded', () => {
		const parent = new Component();
		const child = parent.addChild(new Component());
		const cleanup = jest.fn();
		child.register(cleanup);

		parent.removeChild(child);

		expect(cleanup).not.toHaveBeenCalled();
	});

	it('does not run a removed child a second time when the parent unloads', () => {
		const { parent, child } = createSut();
		const cleanup = jest.fn();
		child.register(cleanup);
		parent.removeChild(child);

		parent.unload();

		expect(cleanup).toHaveBeenCalledTimes(1);
	});
});

describe('Component.registerDomEvent', () => {
	it('delivers events to the listener while loaded', () => {
		const { child } = createSut();
		const target = document.createElement('div');
		const listener = jest.fn();
		child.registerDomEvent(target, 'click', listener);

		target.click();

		expect(listener).toHaveBeenCalledTimes(1);
	});

	it('removes the listener on unload', () => {
		const { parent, child } = createSut();
		const target = document.createElement('div');
		const listener = jest.fn();
		child.registerDomEvent(target, 'click', listener);

		parent.removeChild(child);
		target.click();

		expect(listener).not.toHaveBeenCalled();
	});

	// removeEventListener without capture leaves a capture listener in place,
	// so dropping the options on either call would leak it past unload.
	it('removes a capture listener on unload', () => {
		const { parent, child } = createSut();
		const listener = jest.fn();
		child.registerDomEvent(document, 'click', listener, true);

		parent.removeChild(child);
		document.body.click();

		expect(listener).not.toHaveBeenCalled();
	});

	it('adds the listener in the capture phase when asked to', () => {
		const { child } = createSut();
		const outer = document.createElement('div');
		const inner = outer.appendChild(document.createElement('div'));
		const order: string[] = [];
		inner.addEventListener('click', () => order.push('target'));
		child.registerDomEvent(outer, 'click', () => order.push('capture'), {
			capture: true,
		});

		inner.click();

		expect(order).toEqual(['capture', 'target']);
	});
});

describe('Component.registerInterval', () => {
	it('hands back the id it was given', () => {
		const { child } = createSut();
		const id = window.setInterval(() => undefined, 1000);

		expect(child.registerInterval(id)).toBe(id);

		window.clearInterval(id);
	});

	it('clears the interval on unload', () => {
		jest.useFakeTimers();
		try {
			const { parent, child } = createSut();
			const tick = jest.fn();
			child.registerInterval(window.setInterval(tick, 100));

			parent.removeChild(child);
			jest.advanceTimersByTime(500);

			expect(tick).not.toHaveBeenCalled();
		} finally {
			jest.useRealTimers();
		}
	});
});
