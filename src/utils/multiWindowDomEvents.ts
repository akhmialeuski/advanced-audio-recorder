/**
 * Document-level DOM event registration that spans every Obsidian window.
 * @module utils/multiWindowDomEvents
 */

import { Component } from 'obsidian';
import type { App, Plugin } from 'obsidian';

/**
 * Registers a document-level DOM event listener on the document of every
 * Obsidian window - the main window, any pop-out window already open when
 * this runs, and any pop-out opened later - and removes each listener when
 * its window closes or the plugin unloads.
 *
 * Obsidian pop-out windows each own a separate `document`, and events raised
 * inside one do not bubble into the main window. A single
 * `registerDomEvent(activeDocument, ...)` therefore only ever covers the one
 * window that was focused when it ran, so a note moved into a pop-out loses
 * every delegated handler bound this way (its player context menu and its
 * timecode-link clicks stop working). Binding per window is the direct fix.
 *
 * Each window's listener is owned by its own child {@link Component}: adding
 * it as a plugin child makes plugin unload detach it, and `window-close`
 * detaches it explicitly, so nothing outlives the window it belongs to.
 *
 * @param plugin - Owning plugin; its lifecycle bounds every listener
 * @param app - Obsidian app, used to observe window open/close
 * @param type - DOM event name to listen for on each window's document
 * @param handler - Invoked with the event and the document it fired on
 * @param options - Standard addEventListener options (e.g. capture)
 */
export function registerDomEventOnAllWindows<K extends keyof DocumentEventMap>(
	plugin: Plugin,
	app: App,
	type: K,
	handler: (event: DocumentEventMap[K], doc: Document) => void,
	options?: boolean | AddEventListenerOptions,
): void {
	const { workspace } = app;
	// One child Component per window document owns that window's listener. The
	// map both prevents attaching the same document twice (the main window is
	// reached by both the explicit attach and the leaf sweep) and lets
	// window-close find the owner to unload.
	const owners = new Map<Document, Component>();

	const attach = (doc: Document): void => {
		if (owners.has(doc)) {
			return;
		}
		const owner = new Component();
		owner.registerDomEvent(
			doc,
			type,
			(event) => handler(event, doc),
			options,
		);
		// addChild loads the owner at once (the plugin is already loaded), so
		// the listener is live immediately and is removed on plugin unload.
		plugin.addChild(owner);
		owners.set(doc, owner);
	};

	const detach = (doc: Document): void => {
		const owner = owners.get(doc);
		if (!owner) {
			return;
		}
		owners.delete(doc);
		// removeChild unloads the owner, which removes its listener.
		plugin.removeChild(owner);
	};

	// The currently focused window plus every window that already holds a leaf
	// (the main window and any pop-out open when this runs); the map dedupes
	// the overlap between the two.
	attach(activeDocument);
	workspace.iterateAllLeaves((leaf) => attach(leaf.getContainer().doc));

	plugin.registerEvent(workspace.on('window-open', (win) => attach(win.doc)));
	plugin.registerEvent(
		workspace.on('window-close', (win) => detach(win.doc)),
	);
}
