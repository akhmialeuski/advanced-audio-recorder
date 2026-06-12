/**
 * Mock implementations for Obsidian API.
 * @module tests/mocks/obsidian
 */

/**
 * Mock Plugin class.
 */
export class Plugin {
	app: App;
	manifest: PluginManifest;

	constructor(app: App, manifest: PluginManifest) {
		this.app = app;
		this.manifest = manifest;
	}

	addCommand(_command: Command): Command {
		return _command;
	}

	addRibbonIcon(
		_icon: string,
		_title: string,
		_callback: () => void,
	): HTMLElement {
		return document.createElement('div');
	}

	addSettingTab(_settingTab: PluginSettingTab): void {
		// Mock implementation
	}

	addStatusBarItem(): HTMLElement {
		return document.createElement('div');
	}

	async loadData(): Promise<unknown> {
		return {};
	}

	async saveData(_data: unknown): Promise<void> {
		// Mock implementation
	}
}

/**
 * Mock App class.
 */
export class App {
	vault: Vault = new Vault();
	workspace: Workspace = new Workspace();
}

/**
 * Mock Vault class.
 */
export class Vault {
	adapter = {
		exists: async (_path: string): Promise<boolean> => false,
		read: async (_path: string): Promise<string> => '',
		write: async (_path: string, _data: string): Promise<void> => {
			// Mock implementation
		},
		append: async (_path: string, _data: ArrayBuffer): Promise<void> => {
			// Mock implementation
		},
		rename: async (_oldPath: string, _newPath: string): Promise<void> => {
			// Mock implementation
		},
		readBinary: async (_path: string): Promise<ArrayBuffer> =>
			new ArrayBuffer(0),
		writeBinary: async (
			_path: string,
			_data: ArrayBuffer,
		): Promise<void> => {
			// Mock implementation
		},
		remove: async (_path: string): Promise<void> => {
			// Mock implementation
		},
	};

	async createBinary(_path: string, _data: ArrayBuffer): Promise<void> {
		// Mock implementation
	}

	getRoot(): TFolder {
		return new TFolder('');
	}

	static recurseChildren(
		_root: TFolder,
		_callback: (file: TAbstractFile) => void,
	): void {
		// Mock implementation
	}
}

/**
 * Mock Workspace class.
 */
export class Workspace {
	getActiveViewOfType<T>(_type: new (...args: unknown[]) => T): T | null {
		return null;
	}
}

/**
 * Mock Notice class.
 */
export class Notice {
	constructor(_message: string, _timeout?: number) {
		// Mock implementation
	}
}

/**
 * Adds Obsidian DOM extension methods to an HTMLElement.
 * Obsidian extends HTMLElement with helper methods like createEl, setText, etc.
 */
function addObsidianDomExtensions(el: HTMLElement): HTMLElement {
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

	extended['createDiv'] = (opts?: { cls?: string }): HTMLElement => {
		const createEl = extended['createEl'] as (
			tag: string,
			opts?: { cls?: string },
		) => HTMLElement;
		return createEl('div', opts ? { cls: opts.cls } : undefined);
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

	return el;
}

/**
 * Mock Modal class.
 */
export class Modal {
	app: App;
	contentEl: HTMLElement;

	constructor(app: App) {
		this.app = app;
		this.contentEl = addObsidianDomExtensions(
			document.createElement('div'),
		);
	}

	open(): void {
		// Mock implementation
	}

	close(): void {
		// Mock implementation
	}

	onOpen(): void {
		// Mock implementation
	}

	onClose(): void {
		// Mock implementation
	}
}

/**
 * Mock ButtonComponent class.
 */
export class ButtonComponent {
	buttonEl: HTMLElement = document.createElement('button');

	setButtonText(_text: string): this {
		return this;
	}

	setCta(): this {
		return this;
	}

	setDisabled(_disabled: boolean): this {
		return this;
	}

	onClick(_callback: () => void): this {
		return this;
	}
}

/**
 * Mock Setting class.
 */
export class Setting {
	settingEl: HTMLElement;
	nameEl: HTMLElement;
	descEl: HTMLElement;

	constructor(_containerEl: HTMLElement) {
		this.settingEl = addObsidianDomExtensions(
			document.createElement('div'),
		);
		this.nameEl = addObsidianDomExtensions(document.createElement('div'));
		this.descEl = addObsidianDomExtensions(document.createElement('div'));
	}

	setName(_name: string): this {
		return this;
	}

	setDesc(_desc: string): this {
		return this;
	}

	setHeading(): this {
		return this;
	}

	addText(_callback: (text: TextComponent) => void): this {
		return this;
	}

	addToggle(_callback: (toggle: ToggleComponent) => void): this {
		return this;
	}

	addDropdown(_callback: (dropdown: DropdownComponent) => void): this {
		return this;
	}

	addSlider(_callback: (slider: SliderComponent) => void): this {
		return this;
	}

	addButton(_callback: (button: ButtonComponent) => void): this {
		return this;
	}
}

/**
 * Mock PluginSettingTab class.
 */
export class PluginSettingTab {
	app: App;
	containerEl: HTMLElement = addObsidianDomExtensions(
		document.createElement('div'),
	);
	plugin: Plugin;

	constructor(app: App, plugin: Plugin) {
		this.app = app;
		this.plugin = plugin;
	}

	display(): void {
		// Mock implementation
	}

	hide(): void {
		// Mock implementation
	}
}

/**
 * Mock MarkdownView class.
 */
export class MarkdownView {
	editor: Editor | null = null;
}

/**
 * Mock Editor class.
 */
export class Editor {
	replaceSelection(_text: string): void {
		// Mock implementation
	}
}

/**
 * Mock TAbstractFile class.
 */
export class TAbstractFile {
	path: string;

	constructor(path: string) {
		this.path = path;
	}
}

/**
 * Mock TFolder class.
 */
export class TFolder extends TAbstractFile {
	children: TAbstractFile[] = [];
}

/**
 * Mock TFile class.
 */
export class TFile extends TAbstractFile {
	basename: string;
	extension: string;

	constructor(path: string) {
		super(path);
		const parts = path.split('/');
		const filename = parts[parts.length - 1];
		const nameParts = filename.split('.');
		this.extension = nameParts.pop() ?? '';
		this.basename = nameParts.join('.');
	}
}

/**
 * Mock DropdownComponent class.
 */
export class DropdownComponent {
	value = '';

	addOption(_value: string, _display: string): this {
		return this;
	}

	setValue(value: string): this {
		this.value = value;
		return this;
	}

	onChange(_callback: (value: string) => void): this {
		return this;
	}
}

/**
 * Mock TextComponent class.
 */
export class TextComponent {
	inputEl: HTMLInputElement = document.createElement('input');
	value = '';

	setPlaceholder(_placeholder: string): this {
		return this;
	}

	setValue(value: string): this {
		this.value = value;
		return this;
	}

	onChange(_callback: (value: string) => void): this {
		return this;
	}
}

/**
 * Mock ToggleComponent class.
 */
export class ToggleComponent {
	value = false;

	setValue(value: boolean): this {
		this.value = value;
		return this;
	}

	onChange(_callback: (value: boolean) => void): this {
		return this;
	}
}

/**
 * Mock SliderComponent class.
 */
export class SliderComponent {
	value = 0;

	setLimits(_min: number, _max: number, _step: number): this {
		return this;
	}

	setValue(value: number): this {
		this.value = value;
		return this;
	}

	setDynamicTooltip(): this {
		return this;
	}

	onChange(_callback: (value: number) => void): this {
		return this;
	}
}

/**
 * Mock normalizePath function.
 */
export function normalizePath(path: string): string {
	return path.replace(/\\/g, '/').replace(/\/+/g, '/');
}

/**
 * Mock setIcon function.
 */
export function setIcon(_el: HTMLElement, _iconId: string): void {
	// Mock implementation
}

/**
 * Mock getLinkpath function: strips the subpath (heading/block
 * reference) from a link text, mirroring the Obsidian behavior.
 */
export function getLinkpath(linktext: string): string {
	const hashIndex = linktext.indexOf('#');
	return hashIndex >= 0 ? linktext.slice(0, hashIndex) : linktext;
}

export const Platform = {
	isMobile: false,
	isMobileApp: false,
};

/**
 * Debounced function type returned by the debounce mock.
 */
export type Debouncer<T extends unknown[], V> = ((...args: T) => void) & {
	cancel: () => void;
	run: () => V | undefined;
};

/**
 * Mock debounce function. Defers the callback to a timer like the real
 * implementation so tests can flush it with fake timers or run().
 */
export function debounce<T extends unknown[], V>(
	cb: (...args: T) => V,
	timeout?: number,
	_resetTimer?: boolean,
): Debouncer<T, V> {
	let timer: ReturnType<typeof setTimeout> | null = null;
	let pendingArgs: T | null = null;

	const debounced = ((...args: T): void => {
		pendingArgs = args;
		if (timer !== null) {
			clearTimeout(timer);
		}
		timer = setTimeout(() => {
			timer = null;
			if (pendingArgs) {
				const callArgs = pendingArgs;
				pendingArgs = null;
				cb(...callArgs);
			}
		}, timeout ?? 0);
	}) as Debouncer<T, V>;

	debounced.cancel = (): void => {
		if (timer !== null) {
			clearTimeout(timer);
			timer = null;
		}
		pendingArgs = null;
	};

	debounced.run = (): V | undefined => {
		if (timer === null || !pendingArgs) {
			return undefined;
		}
		clearTimeout(timer);
		timer = null;
		const callArgs = pendingArgs;
		pendingArgs = null;
		return cb(...callArgs);
	};

	return debounced;
}

// Type definitions
export interface PluginManifest {
	id: string;
	name: string;
	version: string;
	dir?: string;
}

export interface Command {
	id: string;
	name: string;
	callback?: () => void;
}
