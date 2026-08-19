/**
 * Contract tests for the Events base in the obsidian mock.
 *
 * Production code registers vault and workspace listeners and expects them to
 * fire, to stop firing after an offref, and to survive a handler that
 * unsubscribes itself mid-delivery. The mock is what those tests run against,
 * so its own behaviour is worth pinning down.
 * @module tests/unit/mocks/obsidianEvents.test
 */

// Imported from the mock by path, not through the 'obsidian' specifier: the
// helpers under test (seed, countHandlers, registeredEvents) are the mock's
// own contract and are deliberately absent from the real type definitions.
import { App, Events, Plugin, TFile } from '../../mocks/obsidian';
import type { EventRef } from '../../mocks/obsidian';

describe('Events', () => {
	it('delivers an event to a registered handler', () => {
		const events = new Events();
		const handler = jest.fn();
		events.on('changed', handler);

		events.trigger('changed', 'a', 'b');

		expect(handler).toHaveBeenCalledWith('a', 'b');
	});

	it('delivers to every handler registered for the name', () => {
		const events = new Events();
		const first = jest.fn();
		const second = jest.fn();
		events.on('changed', first);
		events.on('changed', second);

		events.trigger('changed');

		expect(first).toHaveBeenCalledTimes(1);
		expect(second).toHaveBeenCalledTimes(1);
	});

	it('leaves handlers of other names alone', () => {
		const events = new Events();
		const other = jest.fn();
		events.on('renamed', other);

		events.trigger('changed');

		expect(other).not.toHaveBeenCalled();
	});

	it('stops delivering after off', () => {
		const events = new Events();
		const handler = jest.fn();
		events.on('changed', handler);

		events.off('changed', handler);
		events.trigger('changed');

		expect(handler).not.toHaveBeenCalled();
	});

	it('stops delivering after offref', () => {
		const events = new Events();
		const handler = jest.fn();
		const ref = events.on('changed', handler);

		events.offref(ref);
		events.trigger('changed');

		expect(handler).not.toHaveBeenCalled();
	});

	it('lets a handler unsubscribe itself while the event is being delivered', () => {
		const events = new Events();
		const second = jest.fn();
		let ref: EventRef | null = null;
		const first = jest.fn(() => {
			if (ref) {
				events.offref(ref);
			}
		});
		ref = events.on('changed', first);
		events.on('changed', second);

		events.trigger('changed');
		events.trigger('changed');

		// The first handler removed itself during the first delivery; the
		// second is untouched and hears both.
		expect(first).toHaveBeenCalledTimes(1);
		expect(second).toHaveBeenCalledTimes(2);
	});

	it('reports how many handlers are listening', () => {
		const events = new Events();
		const handler = jest.fn();

		expect(events.countHandlers('changed')).toBe(0);
		const ref = events.on('changed', handler);
		expect(events.countHandlers('changed')).toBe(1);
		events.offref(ref);
		expect(events.countHandlers('changed')).toBe(0);
	});

	it('triggers nothing for a name no one registered', () => {
		const events = new Events();

		expect(() => {
			events.trigger('nobody-listening');
		}).not.toThrow();
	});
});

describe('Events on the vault, workspace, and metadata cache', () => {
	it.each([
		{ name: 'vault', collaborator: (app: App) => app.vault },
		{ name: 'workspace', collaborator: (app: App) => app.workspace },
		{
			name: 'metadataCache',
			collaborator: (app: App) => app.metadataCache,
		},
	])('$name delivers events like the real one', ({ collaborator }) => {
		const app = new App();
		const handler = jest.fn();

		collaborator(app).on('changed', handler);
		collaborator(app).trigger('changed', 'payload');

		expect(handler).toHaveBeenCalledWith('payload');
	});

	it('carries a rename through with the file and its old path', () => {
		const app = new App();
		const handler = jest.fn();
		app.vault.on('rename', handler);
		const [file] = app.vault.seed([{ path: 'Recordings/new.wav' }]);

		app.vault.trigger('rename', file, 'Recordings/old.wav');

		expect(handler).toHaveBeenCalledWith(file, 'Recordings/old.wav');
	});
});

describe('Plugin.registerEvent', () => {
	it('returns the handle it was given, like the real API', () => {
		const plugin = new Plugin(new App(), {
			id: 'test',
			name: 'Test',
			version: '0.0.0',
			minAppVersion: '1.0.0',
			author: 'Test',
		});
		const ref = plugin.app.vault.on('delete', jest.fn());

		expect(plugin.registerEvent(ref)).toBe(ref);
	});

	it('records every registration so a test can assert what was hooked up', () => {
		const plugin = new Plugin(new App(), {
			id: 'test',
			name: 'Test',
			version: '0.0.0',
			minAppVersion: '1.0.0',
			author: 'Test',
		});

		plugin.registerEvent(plugin.app.vault.on('rename', jest.fn()));
		plugin.registerEvent(plugin.app.vault.on('delete', jest.fn()));

		expect(plugin.registeredEvents.map((ref) => ref.name)).toEqual([
			'rename',
			'delete',
		]);
	});
});

describe('TFile identity through the vault', () => {
	it('keeps one TFile per path so handlers can compare by reference', () => {
		const vault = new App().vault;
		const [seeded] = vault.seed([{ path: 'a.wav' }]);

		expect(vault.getFileByPath('a.wav')).toBe(seeded);
		expect(vault.getFileByPath('a.wav')).toBeInstanceOf(TFile);
	});
});
