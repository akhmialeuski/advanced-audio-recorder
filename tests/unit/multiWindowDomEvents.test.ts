/**
 * Unit tests for registerDomEventOnAllWindows. The primitive exists because
 * Obsidian pop-out windows each own a separate `document` whose events never
 * reach the main window, so a listener bound once to activeDocument silently
 * misses every pop-out. These tests drive the REAL primitive against several
 * jsdom documents and assert that a listener reaches the main window, any
 * pop-out already open at registration, and pop-outs opened later, and that it
 * is removed on window-close and on plugin unload.
 * @module tests/unit/multiWindowDomEvents.test
 */

import { Component } from 'obsidian';
import type { App, Plugin, WorkspaceLeaf } from 'obsidian';
import { registerDomEventOnAllWindows } from 'src/utils/multiWindowDomEvents';

/** A pop-out-like window handle, as workspace window events carry it. */
interface WindowLike {
	doc: Document;
}

/**
 * A faithful plugin/app double: a real Component (so addChild/removeChild and
 * registerDomEvent behave like Obsidian's, attaching and detaching listeners
 * for real) plus a workspace that records its window-open/close callbacks and
 * iterates a configurable set of already-open leaves.
 */
class FakePlugin extends Component {
	readonly windowListeners: Record<string, (win: WindowLike) => void> = {};
	readonly app: App;

	constructor(preOpenDocs: Document[]) {
		super();
		const leaves: WorkspaceLeaf[] = preOpenDocs.map(
			(doc) =>
				({
					getContainer: () => ({ doc }),
				}) as unknown as WorkspaceLeaf,
		);
		this.app = {
			workspace: {
				iterateAllLeaves: (cb: (leaf: WorkspaceLeaf) => void): void => {
					leaves.forEach(cb);
				},
				on: (name: string, cb: (win: WindowLike) => void): object => {
					this.windowListeners[name] = cb;
					return {};
				},
			},
		} as unknown as App;
	}

	/** Fires a recorded workspace window event, as Obsidian would. */
	emit(name: 'window-open' | 'window-close', doc: Document): void {
		this.windowListeners[name]?.({ doc });
	}
}

/** A fresh, independent document, standing in for a pop-out window. */
function makeDoc(): Document {
	return document.implementation.createHTMLDocument('popout');
}

/** Dispatches a bubbling click on a document, returning nothing. */
function click(doc: Document): void {
	doc.dispatchEvent(new Event('click', { bubbles: true }));
}

describe('registerDomEventOnAllWindows', () => {
	it('reaches the main window and a pop-out open at registration time', () => {
		const preOpen = makeDoc();
		const plugin = new FakePlugin([preOpen]);
		plugin.load();
		const seen: Document[] = [];

		registerDomEventOnAllWindows(
			plugin as unknown as Plugin,
			plugin.app,
			'click',
			(_event, doc) => seen.push(doc),
		);

		click(document);
		click(preOpen);

		expect(seen).toContain(document);
		expect(seen).toContain(preOpen);
	});

	it('reaches a pop-out opened after registration', () => {
		const plugin = new FakePlugin([]);
		plugin.load();
		const seen: Document[] = [];
		registerDomEventOnAllWindows(
			plugin as unknown as Plugin,
			plugin.app,
			'click',
			(_event, doc) => seen.push(doc),
		);
		const popout = makeDoc();

		// Before the window opens, its document has no listener
		click(popout);
		expect(seen).not.toContain(popout);

		plugin.emit('window-open', popout);
		click(popout);

		expect(seen).toContain(popout);
	});

	it('stops reaching a pop-out once its window closes', () => {
		const plugin = new FakePlugin([]);
		plugin.load();
		const seen: Document[] = [];
		registerDomEventOnAllWindows(
			plugin as unknown as Plugin,
			plugin.app,
			'click',
			(_event, doc) => seen.push(doc),
		);
		const popout = makeDoc();
		plugin.emit('window-open', popout);

		plugin.emit('window-close', popout);
		click(popout);

		expect(seen).not.toContain(popout);
	});

	it('attaches a document only once even if it opens twice', () => {
		const plugin = new FakePlugin([]);
		plugin.load();
		const seen: Document[] = [];
		registerDomEventOnAllWindows(
			plugin as unknown as Plugin,
			plugin.app,
			'click',
			(_event, doc) => seen.push(doc),
		);
		const popout = makeDoc();

		plugin.emit('window-open', popout);
		plugin.emit('window-open', popout);
		click(popout);

		expect(seen.filter((doc) => doc === popout)).toHaveLength(1);
	});

	it('removes every window listener when the plugin unloads', () => {
		const preOpen = makeDoc();
		const plugin = new FakePlugin([preOpen]);
		plugin.load();
		const seen: Document[] = [];
		registerDomEventOnAllWindows(
			plugin as unknown as Plugin,
			plugin.app,
			'click',
			(_event, doc) => seen.push(doc),
		);
		const popout = makeDoc();
		plugin.emit('window-open', popout);

		plugin.unload();
		click(document);
		click(preOpen);
		click(popout);

		expect(seen).toHaveLength(0);
	});

	it('forwards addEventListener options (capture) to each window', () => {
		const attach = jest.spyOn(Component.prototype, 'registerDomEvent');
		try {
			const plugin = new FakePlugin([]);
			plugin.load();

			registerDomEventOnAllWindows(
				plugin as unknown as Plugin,
				plugin.app,
				'click',
				() => {},
				{ capture: true },
			);

			expect(attach).toHaveBeenCalledWith(
				document,
				'click',
				expect.any(Function),
				{ capture: true },
			);
		} finally {
			attach.mockRestore();
		}
	});

	it('ignores the closing of a window it never attached to', () => {
		// Every pop-out close fires this event, including ones that closed
		// before the listener was registered.
		const plugin = new FakePlugin([]);
		plugin.load();
		registerDomEventOnAllWindows(
			plugin as unknown as Plugin,
			plugin.app,
			'click',
			() => undefined,
		);

		expect(() => {
			plugin.emit('window-close', makeDoc());
		}).not.toThrow();
	});
});
