/**
 * Jest global setup: polyfill APIs missing from jsdom
 * that are required by bundled dependencies (e.g., mediabunny).
 */

import { TextDecoder, TextEncoder } from 'util';

import { addObsidianDomExtensions } from './mocks/obsidian';

// Explicit resource management (`using`/`await using`) lowers through
// tslib helpers that require the well-known dispose symbols; jest's
// sandboxed global may lack them.
const symbolWithDispose = Symbol as {
	dispose?: symbol;
	asyncDispose?: symbol;
};
if (typeof symbolWithDispose.dispose === 'undefined') {
	Object.defineProperty(Symbol, 'dispose', {
		value: Symbol.for('Symbol.dispose'),
	});
}
if (typeof symbolWithDispose.asyncDispose === 'undefined') {
	Object.defineProperty(Symbol, 'asyncDispose', {
		value: Symbol.for('Symbol.asyncDispose'),
	});
}

if (typeof globalThis.TextDecoder === 'undefined') {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- globalThis type augmentation requires any
	(globalThis as any).TextDecoder = TextDecoder;
}
if (typeof globalThis.TextEncoder === 'undefined') {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- globalThis type augmentation requires any
	(globalThis as any).TextEncoder = TextEncoder;
}

// Obsidian injects activeWindow/activeDocument as globals at runtime; jsdom does not.
type ObsidianGlobals = {
	activeWindow?: Window;
	activeDocument?: Document;
};

if (typeof (globalThis as ObsidianGlobals).activeWindow === 'undefined') {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- globalThis type augmentation requires any
	(globalThis as any).activeWindow = globalThis.window;
}
if (typeof (globalThis as ObsidianGlobals).activeDocument === 'undefined') {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- globalThis type augmentation requires any
	(globalThis as any).activeDocument = globalThis.document;
}

// jsdom lacks ResizeObserver, which the waveform seek area observes.
if (
	typeof (globalThis as { ResizeObserver?: unknown }).ResizeObserver ===
	'undefined'
) {
	class ResizeObserverMock {
		observe(): void {
			// Mock implementation
		}
		unobserve(): void {
			// Mock implementation
		}
		disconnect(): void {
			// Mock implementation
		}
	}
	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- globalThis type augmentation requires any
	(globalThis as any).ResizeObserver = ResizeObserverMock;
}

// Obsidian augments Node with instanceOf; jsdom does not. The player's
// default-embed guard calls node.instanceOf on mutation-added nodes.
const nodeProto = globalThis.Node?.prototype as
	| (Node & { instanceOf?: unknown })
	| undefined;
if (nodeProto && typeof nodeProto.instanceOf === 'undefined') {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- prototype augmentation requires any
	(nodeProto as any).instanceOf = function (
		this: Node,
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirrors Obsidian's loose signature
		ctor: any,
	): boolean {
		return this instanceof ctor;
	};
}

// jsdom's Blob lacks arrayBuffer(); the recording and conversion
// pipelines call it on every write path. FileReader-backed so the
// bytes are the blob's real contents.
if (!Blob.prototype.arrayBuffer) {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test polyfill for jsdom
	(Blob.prototype as any).arrayBuffer = function (): Promise<ArrayBuffer> {
		return new Promise((resolve, reject) => {
			const reader = new FileReader();
			reader.onload = (): void => resolve(reader.result as ArrayBuffer);
			reader.onerror = (): void => reject(reader.error);
			reader.readAsArrayBuffer(this as Blob);
		});
	};
}

// Obsidian injects global element factories (createEl/createDiv/createSpan/
// createFragment) that build DETACHED elements with DomElementInfo applied;
// jsdom does not. Mirror the element-method handling from the obsidian mock so
// production code that uses the globals behaves the same under test.
type DomElementInfoLike =
	| string
	| {
			cls?: string | string[];
			text?: string;
			attr?: Record<string, string | number | boolean | null>;
	  };

function applyDomElementInfo(el: HTMLElement, info?: DomElementInfoLike): void {
	if (!info) {
		return;
	}
	if (typeof info === 'string') {
		el.className = info;
		return;
	}
	if (typeof info.text === 'string') {
		el.textContent = info.text;
	}
	if (info.cls) {
		const classes = Array.isArray(info.cls)
			? info.cls
			: info.cls.split(' ');
		classes.filter(Boolean).forEach((c) => el.classList.add(c));
	}
	if (info.attr) {
		for (const [key, value] of Object.entries(info.attr)) {
			if (value !== null) {
				el.setAttribute(key, String(value));
			}
		}
	}
}

if (typeof (globalThis as { createEl?: unknown }).createEl === 'undefined') {
	const createElGlobal = (
		tag: string,
		info?: DomElementInfoLike,
		callback?: (el: HTMLElement) => void,
	): HTMLElement => {
		const el = document.createElement(tag);
		addObsidianDomExtensions(el);
		applyDomElementInfo(el, info);
		callback?.(el);
		return el;
	};
	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- globalThis augmentation requires any
	(globalThis as any).createEl = createElGlobal;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- globalThis augmentation requires any
	(globalThis as any).createDiv = (
		info?: DomElementInfoLike,
		callback?: (el: HTMLElement) => void,
	): HTMLElement => createElGlobal('div', info, callback);
	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- globalThis augmentation requires any
	(globalThis as any).createSpan = (
		info?: DomElementInfoLike,
		callback?: (el: HTMLElement) => void,
	): HTMLElement => createElGlobal('span', info, callback);
	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- globalThis augmentation requires any
	(globalThis as any).createFragment = (
		callback?: (el: DocumentFragment) => void,
	): DocumentFragment => {
		const fragment = document.createDocumentFragment();
		callback?.(fragment);
		return fragment;
	};
}
