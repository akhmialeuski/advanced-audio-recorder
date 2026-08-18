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
		el.appendChild(child);
		return child;
	};

	extended['createDiv'] = (opts?: {
		cls?: string;
		text?: string;
	}): HTMLElement => {
		const createEl = extended['createEl'] as (
			tag: string,
			opts?: { cls?: string; text?: string },
		) => HTMLElement;
		return createEl(
			'div',
			opts
				? {
						...(opts.cls === undefined ? {} : { cls: opts.cls }),
						...(opts.text === undefined ? {} : { text: opts.text }),
					}
				: undefined,
		);
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
	}): HTMLElement => {
		const createEl = extended['createEl'] as (
			tag: string,
			opts?: { cls?: string; text?: string },
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

	return el;
}
