/**
 * Obsidian's DOM extensions, applied to a plain jsdom element.
 *
 * Its own module rather than part of the obsidian mock so both the mock and the
 * settings capture double can use it: the capture double is installed *into*
 * the mock, and importing back from it would be a cycle that leaves the helper
 * undefined at call time.
 * @module tests/mocks/domExtensions
 */

/**
 * jsdom's own MutationObserver, taken before any suite can replace the global.
 * Obsidian detects an insertion with a CSS animation rather than an observer,
 * so a suite that swaps MutationObserver to count the plugin's observers must
 * not find the mock's in its count.
 */
const NativeMutationObserver = MutationObserver;

/**
 * The window a node belongs to, as Obsidian's `win` reads it: its document's
 * window, or the global one for a document that has none (such as one made
 * with `document.implementation.createHTMLDocument`).
 * @param node - Any node
 * @returns The window the node is shown in
 */
function windowOf(node: Node): Window {
	return node.ownerDocument?.defaultView ?? window;
}

/**
 * Calls back whenever an element goes from detached to attached, the stand-in
 * for Obsidian's `onNodeInserted`.
 *
 * Obsidian hears an insertion through an `animationstart` event that a CSS
 * animation on the element raises once it is rendered, and jsdom runs no
 * animations. This model observes the element's document instead and fires
 * when a batch of mutations there leaves the element connected after it was
 * either detached or removed and put back, which is when the real animation
 * restarts. It fires asynchronously (as a microtask) the way the real event
 * does, and again on every later re-insertion unless `once` is set. It follows
 * the element into another document when the move is one step, an append into
 * the other document, which is how Obsidian moves a leaf into a pop-out
 * window; an element left detached and inserted elsewhere later is not seen.
 * Unlike the real one it does not fire for an element that was already
 * attached when the listener was added, and it ignores whether the element is
 * displayed.
 * @param el - The element to watch
 * @param listener - Called on each insertion
 * @param once - Stop after the first insertion
 * @returns Stops listening; safe to call more than once
 */
function watchInsertion(
	el: HTMLElement,
	listener: () => unknown,
	once = false,
): () => void {
	let watched: Document | null = null;
	let connected = el.isConnected;
	let stopped = false;
	const tookElementOut = (record: MutationRecord): boolean =>
		[...record.removedNodes].some((node) => node.contains(el));
	const observer = new NativeMutationObserver((records) => {
		if (stopped) {
			return;
		}
		follow();
		const inserted =
			el.isConnected && (!connected || records.some(tookElementOut));
		connected = el.isConnected;
		if (!inserted) {
			return;
		}
		if (once) {
			stop();
		}
		listener();
	});
	function follow(): void {
		if (el.ownerDocument !== watched) {
			observer.disconnect();
			watched = el.ownerDocument;
			observer.observe(watched, { childList: true, subtree: true });
		}
	}
	function stop(): void {
		stopped = true;
		observer.disconnect();
	}
	follow();
	return stop;
}

/**
 * Adds Obsidian DOM extension methods to an HTMLElement.
 * Obsidian extends HTMLElement with helper methods like createEl, setText, etc.
 * Exported so DOM-driven tests can extend elements Obsidian extends at
 * runtime (e.g. document.body for body-mounted UI like RecordingBanner).
 */
export function addObsidianDomExtensions<T extends HTMLElement>(el: T): T {
	// Use unknown cast to avoid TypeScript's overloaded HTMLElement extension conflicts
	const extended = el as unknown as Record<string, unknown>;

	extended['createEl'] = (
		tag: string,
		opts?: {
			text?: string;
			cls?: string | string[];
			attr?: Record<string, string>;
			value?: string;
		},
	): HTMLElement => {
		const child = document.createElement(tag);
		addObsidianDomExtensions(child);
		if (opts?.text) child.textContent = opts.text;
		if (opts?.cls) {
			const classes = Array.isArray(opts.cls)
				? opts.cls
				: opts.cls.split(' ');
			classes.forEach((c) => child.classList.add(c));
		}
		if (opts?.attr) {
			Object.entries(opts.attr).forEach(([k, v]) =>
				child.setAttribute(k, v),
			);
		}
		// Obsidian's DomElementInfo carries `value`, and it is the property
		// rather than the attribute: an <option> built without it cannot be
		// selected by value, so a <select> silently refuses every assignment.
		if (opts?.value !== undefined) {
			if ('value' in child) {
				(child as HTMLInputElement).value = opts.value;
			} else {
				child.setAttribute('value', opts.value);
			}
		}
		el.appendChild(child);
		return child;
	};

	// Obsidian's createDiv takes the same DomElementInfo as createEl.
	extended['createDiv'] = (opts?: Record<string, unknown>): HTMLElement => {
		const createEl = extended['createEl'] as (
			tag: string,
			opts?: Record<string, unknown>,
		) => HTMLElement;
		return createEl('div', opts);
	};

	extended['setText'] = (text: string): void => {
		el.textContent = text;
	};

	extended['addClass'] = (...classes: string[]): void => {
		classes.forEach((c) => el.classList.add(c));
	};

	extended['removeClass'] = (...classes: string[]): void => {
		classes.forEach((c) => el.classList.remove(c));
	};

	extended['empty'] = (): void => {
		while (el.firstChild) {
			el.removeChild(el.firstChild);
		}
	};

	extended['createSpan'] = (opts?: {
		cls?: string;
		text?: string;
		attr?: Record<string, string>;
	}): HTMLElement => {
		const createEl = extended['createEl'] as (
			tag: string,
			opts?: {
				cls?: string;
				text?: string;
				attr?: Record<string, string>;
			},
		) => HTMLElement;
		return createEl('span', opts);
	};

	extended['setCssProps'] = (props: Record<string, string>): void => {
		Object.entries(props).forEach(([key, value]) => {
			el.style.setProperty(key, value);
		});
	};

	extended['toggleClass'] = (cls: string, force?: boolean): void => {
		el.classList.toggle(cls, force);
	};

	extended['hasClass'] = (cls: string): boolean => el.classList.contains(cls);

	// Obsidian's own visibility helpers, which set and clear the inline display
	// rather than toggling a class, so a test asserting on style.display sees
	// what the app leaves behind.
	extended['show'] = (): void => {
		el.style.removeProperty('display');
	};

	extended['hide'] = (): void => {
		el.style.setProperty('display', 'none');
	};

	extended['toggle'] = (show: boolean): void => {
		const helper = extended[show ? 'show' : 'hide'] as () => void;
		helper();
	};

	// Obsidian defines these on every node, and they are read live, so an
	// element moved into a pop-out window answers with that window at once.
	Object.defineProperty(el, 'win', {
		configurable: true,
		get: (): Window => windowOf(el),
	});
	Object.defineProperty(el, 'doc', {
		configurable: true,
		get: (): Document => el.ownerDocument,
	});

	extended['onNodeInserted'] = (
		listener: () => unknown,
		once?: boolean,
	): (() => void) => watchInsertion(el, listener, once);

	// Obsidian builds this on the insertion signal as well: an insertion that
	// leaves the element in a different window than before is a migration.
	extended['onWindowMigrated'] = (
		listener: (win: Window) => unknown,
	): (() => void) => {
		let current = windowOf(el);
		return watchInsertion(el, () => {
			const next = windowOf(el);
			if (next !== current) {
				current = next;
				listener(next);
			}
		});
	};

	return el;
}
