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

	registerInterval(id: number): number {
		return id;
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

	getFileByPath(_path: string): TFile | null {
		return null;
	}

	getResourcePath(file: TFile): string {
		return `app://vault/${file.path}`;
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

	onLayoutReady(callback: () => void): void {
		// The mock workspace is always "ready"
		callback();
	}
}

/**
 * Mock Notice: a jest.fn-backed constructor so tests can assert on
 * `(Notice as jest.Mock).mock.calls` without re-mocking the module.
 * The global clearMocks option resets the calls between tests.
 */
export const Notice = jest.fn(function (
	this: { message: string | DocumentFragment; hide: jest.Mock },
	message: string | DocumentFragment,
	_timeout?: number,
) {
	this.message = message;
	this.hide = jest.fn();
});

/**
 * Mock MenuItem class. Builder methods are chainable like the real API.
 */
export class MenuItem {
	setTitle(_title: string): this {
		return this;
	}
	setIcon(_icon: string): this {
		return this;
	}
	setChecked(_checked: boolean): this {
		return this;
	}
	setSection(_section: string): this {
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
 * Mock Menu class. addItem invokes the builder with a MenuItem so callers
 * exercise their item-building code; showing is a no-op.
 */
export class Menu {
	addItem(callback: (item: MenuItem) => void): this {
		callback(new MenuItem());
		return this;
	}
	addSeparator(): this {
		return this;
	}
	showAtMouseEvent(_event: MouseEvent): this {
		return this;
	}
	showAtPosition(_position: { x: number; y: number }): this {
		return this;
	}
}

/**
 * Mock Component class mirroring Obsidian's load/unload child tree.
 * Faithful enough for embed controllers: addChild loads the child when the
 * parent is loaded, removeChild unloads it, and register callbacks fire on
 * unload.
 */
export class Component {
	private loaded = false;
	private readonly children: Component[] = [];
	private readonly registrations: Array<() => void> = [];

	load(): void {
		if (this.loaded) {
			return;
		}
		this.loaded = true;
		this.onload();
		this.children.forEach((child) => child.load());
	}

	onload(): void {
		// Overridden by subclasses
	}

	unload(): void {
		if (!this.loaded) {
			return;
		}
		this.loaded = false;
		while (this.children.length > 0) {
			this.children.pop()?.unload();
		}
		this.onunload();
		this.registrations.forEach((cb) => cb());
		this.registrations.length = 0;
	}

	onunload(): void {
		// Overridden by subclasses
	}

	addChild<T extends Component>(child: T): T {
		this.children.push(child);
		if (this.loaded) {
			child.load();
		}
		return child;
	}

	removeChild<T extends Component>(child: T): T {
		const index = this.children.indexOf(child);
		if (index >= 0) {
			this.children.splice(index, 1);
		}
		child.unload();
		return child;
	}

	register(cb: () => void): void {
		this.registrations.push(cb);
	}

	registerEvent(_eventRef: unknown): void {
		// Mock implementation
	}

	registerDomEvent(
		el: EventTarget,
		type: string,
		callback: EventListenerOrEventListenerObject,
	): void {
		// Faithful enough for tests: attach the listener and auto-remove it on
		// unload, so delegated handlers actually fire when events are dispatched.
		if (el && typeof el.addEventListener === 'function') {
			el.addEventListener(type, callback);
			this.register(() => el.removeEventListener(type, callback));
		}
	}

	registerInterval(_id: number): void {
		// Mock implementation
	}
}

/**
 * Mock MarkdownRenderChild bound to a container element.
 */
export class MarkdownRenderChild extends Component {
	containerEl: HTMLElement;

	constructor(containerEl: HTMLElement) {
		super();
		this.containerEl = containerEl;
	}
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

	titleEl: HTMLElement = addObsidianDomExtensions(
		document.createElement('div'),
	);

	open(): void {
		// Mirrors Obsidian: opening renders the modal contents
		this.onOpen();
	}

	close(): void {
		// Mirrors Obsidian: closing tears the contents down
		this.onClose();
	}

	setTitle(title: string): this {
		this.titleEl.setText(title);
		return this;
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
	buttonEl: HTMLButtonElement = addObsidianDomExtensions(
		document.createElement('button'),
	);

	setButtonText(text: string): this {
		this.buttonEl.textContent = text;
		return this;
	}

	setCta(): this {
		// Mirrors Obsidian, which marks the primary button with mod-cta; tests
		// locate the primary action by that class.
		this.buttonEl.classList.add('mod-cta');
		return this;
	}

	setWarning(): this {
		this.buttonEl.classList.add('mod-warning');
		return this;
	}

	setDestructive(): this {
		this.buttonEl.classList.add('mod-destructive');
		return this;
	}

	setTooltip(tooltip: string): this {
		this.buttonEl.setAttribute('aria-label', tooltip);
		return this;
	}

	setIcon(icon: string): this {
		this.buttonEl.setAttribute('data-icon', icon);
		return this;
	}

	setDisabled(disabled: boolean): this {
		this.buttonEl.disabled = disabled;
		return this;
	}

	onClick(callback: () => void): this {
		// Clicking buttonEl triggers the handler, as in Obsidian
		this.buttonEl.addEventListener('click', callback);
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
	controlEl: HTMLElement;

	constructor(containerEl: HTMLElement) {
		// Mirrors Obsidian: the setting row is attached to the container
		// so tests can locate rendered controls through the DOM
		this.settingEl = addObsidianDomExtensions(
			document.createElement('div'),
		);
		this.settingEl.classList.add('setting-item');
		this.nameEl = addObsidianDomExtensions(document.createElement('div'));
		this.nameEl.classList.add('setting-item-name');
		this.descEl = addObsidianDomExtensions(document.createElement('div'));
		this.descEl.classList.add('setting-item-description');
		this.controlEl = addObsidianDomExtensions(
			document.createElement('div'),
		);
		this.controlEl.classList.add('setting-item-control');
		this.settingEl.appendChild(this.nameEl);
		this.settingEl.appendChild(this.descEl);
		this.settingEl.appendChild(this.controlEl);
		containerEl.appendChild(this.settingEl);
	}

	setName(name: string): this {
		this.nameEl.textContent = name;
		return this;
	}

	/**
	 * Obsidian's own setDesc, which takes either plain text or a fragment - the
	 * latter is how a description carries a link. Mirrored here so a fragment
	 * lands as nodes rather than as "[object DocumentFragment]".
	 * @param desc - The description text, or the nodes making it up
	 */
	setDesc(desc: string | DocumentFragment): this {
		this.descEl.textContent = '';
		if (typeof desc === 'string') {
			this.descEl.textContent = desc;
		} else {
			this.descEl.appendChild(desc);
		}
		return this;
	}

	setHeading(): this {
		return this;
	}

	/**
	 * Obsidian's own clear(): drops the row's controls and the components
	 * bound to them, leaving the name and description elements alone. The
	 * framework calls this before it renders a row it already built again.
	 */
	clear(): this {
		this.controlEl.empty();
		this.components = [];
		return this;
	}

	/** Components created by the add* methods, in creation order. */
	components: Array<
		| TextComponent
		| TextAreaComponent
		| SearchComponent
		| ExtraButtonComponent
		| ToggleComponent
		| DropdownComponent
		| SliderComponent
		| ButtonComponent
	> = [];

	private addComponent<
		T extends
			| TextComponent
			| TextAreaComponent
			| SearchComponent
			| ExtraButtonComponent
			| ToggleComponent
			| DropdownComponent
			| SliderComponent
			| ButtonComponent,
	>(component: T, callback: (component: T) => void): this {
		this.components.push(component);
		// Attach the component's element like Obsidian does, so DOM
		// queries and clicks reach it
		const el =
			(component as { buttonEl?: HTMLElement }).buttonEl ??
			(component as { extraSettingsEl?: HTMLElement }).extraSettingsEl ??
			(component as { inputEl?: HTMLElement }).inputEl ??
			(component as { selectEl?: HTMLElement }).selectEl ??
			(component as { toggleEl?: HTMLElement }).toggleEl ??
			(component as { sliderEl?: HTMLElement }).sliderEl;
		if (el) {
			this.controlEl.appendChild(el);
		}
		callback(component);
		return this;
	}

	addText(callback: (text: TextComponent) => void): this {
		return this.addComponent(new TextComponent(), callback);
	}

	addTextArea(callback: (text: TextAreaComponent) => void): this {
		return this.addComponent(new TextAreaComponent(), callback);
	}

	addSearch(callback: (search: SearchComponent) => void): this {
		return this.addComponent(new SearchComponent(), callback);
	}

	addExtraButton(callback: (button: ExtraButtonComponent) => void): this {
		return this.addComponent(new ExtraButtonComponent(), callback);
	}

	addToggle(callback: (toggle: ToggleComponent) => void): this {
		return this.addComponent(new ToggleComponent(), callback);
	}

	addDropdown(callback: (dropdown: DropdownComponent) => void): this {
		return this.addComponent(new DropdownComponent(), callback);
	}

	addSlider(callback: (slider: SliderComponent) => void): this {
		return this.addComponent(new SliderComponent(), callback);
	}

	addButton(callback: (button: ButtonComponent) => void): this {
		return this.addComponent(new ButtonComponent(), callback);
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

	/**
	 * Obsidian 1.13's declarative re-render, which re-reads
	 * getSettingDefinitions() and renders the tab from it. Present here because
	 * the plugin builds against 1.13; a test that models an older Obsidian
	 * deletes it from this prototype before constructing its tab.
	 */
	update(): void {
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
		// split() always yields at least one element, so the last one is the
		// filename; the fallback only satisfies the index-safety check.
		const filename = parts[parts.length - 1] ?? path;
		const nameParts = filename.split('.');
		this.extension = nameParts.pop() ?? '';
		this.basename = nameParts.join('.');
	}
}

/**
 * Mock DropdownComponent class.
 */
export class DropdownComponent {
	selectEl: HTMLSelectElement = addObsidianDomExtensions(
		document.createElement('select'),
	);
	value = '';
	disabled = false;

	/** Change handler, stored as Obsidian does for test triggering. */
	changeCallback: ((value: string) => void) | null = null;

	addOption(value: string, display: string): this {
		const option = document.createElement('option');
		option.value = value;
		option.textContent = display;
		this.selectEl.appendChild(option);
		return this;
	}

	addOptions(options: Record<string, string>): this {
		for (const [value, display] of Object.entries(options)) {
			this.addOption(value, display);
		}
		return this;
	}

	setValue(value: string): this {
		this.value = value;
		// Mirrored onto the element like real Obsidian, so a test can read the
		// rendered selection (including a stale id resolving to the first
		// option) straight from the DOM
		this.selectEl.value = value;
		return this;
	}

	setDisabled(disabled: boolean): this {
		this.disabled = disabled;
		// Mirrored onto the element like real Obsidian, so DOM-level
		// assertions see the state
		this.selectEl.disabled = disabled;
		return this;
	}

	/** Guards the DOM listener so repeated onChange calls attach once. */
	private changeListenerAttached = false;

	onChange(callback: (value: string) => void): this {
		this.changeCallback = callback;
		if (!this.changeListenerAttached) {
			this.changeListenerAttached = true;
			// Real Obsidian dropdowns fire onChange from the select's
			// change event; wiring it lets tests drive them via the DOM
			this.selectEl.addEventListener('change', () => {
				this.changeCallback?.(this.selectEl.value);
			});
		}
		return this;
	}
}

/**
 * Mock TextComponent class.
 */
export class TextComponent {
	inputEl: HTMLInputElement = addObsidianDomExtensions(
		document.createElement('input'),
	);
	value = '';
	disabled = false;

	/** Change handler, stored as Obsidian does for test triggering. */
	changeCallback: ((value: string) => void) | null = null;

	constructor() {
		// Mirrors Obsidian: typing in the field fires the change handler, so a
		// DOM-driven test reaches the same code path a user does.
		this.inputEl.addEventListener('input', () => {
			if (this.disabled) {
				return;
			}
			this.value = this.inputEl.value;
			this.changeCallback?.(this.inputEl.value);
		});
	}

	setPlaceholder(placeholder: string): this {
		this.inputEl.placeholder = placeholder;
		return this;
	}

	setValue(value: string): this {
		this.value = value;
		this.inputEl.value = value;
		return this;
	}

	setDisabled(disabled: boolean): this {
		this.disabled = disabled;
		// Mirrored onto the element like real Obsidian, whose
		// AbstractTextComponent sets inputEl.disabled, so a DOM-level
		// assertion sees a field the user cannot type into.
		this.inputEl.disabled = disabled;
		return this;
	}

	onChange(callback: (value: string) => void): this {
		this.changeCallback = callback;
		return this;
	}
}

/**
 * Mock SearchComponent: a text input with Obsidian's search contract, which is
 * the same change wiring as a text field.
 */
export class SearchComponent extends TextComponent {
	clear(): void {
		this.setValue('');
	}
}

/**
 * Mock ExtraButtonComponent: the compact icon-only button beside a control.
 *
 * Obsidian builds it as a `div.clickable-icon.extra-setting-button`, not as a
 * `<button>` - which is why it has to be given a tabindex to be reachable at
 * all. Modelled here as the div it is: a mock that answered `button` let a
 * renderer distinguishing "a click on a control" from "a click on the row"
 * pass its tests while failing in Obsidian.
 */
export class ExtraButtonComponent {
	extraSettingsEl: HTMLElement = addObsidianDomExtensions(
		document.createElement('div'),
	);
	disabled = false;

	constructor() {
		this.extraSettingsEl.classList.add(
			'clickable-icon',
			'extra-setting-button',
		);
		this.extraSettingsEl.setAttribute('tabindex', '0');
	}

	setIcon(icon: string): this {
		// Recorded the way ButtonComponent records it, so a test can see which
		// icon a button currently shows rather than only that it was set once.
		this.extraSettingsEl.setAttribute('data-icon', icon);
		return this;
	}

	setTooltip(tooltip: string): this {
		this.extraSettingsEl.setAttribute('aria-label', tooltip);
		return this;
	}

	setDisabled(disabled: boolean): this {
		this.disabled = disabled;
		// Obsidian marks it disabled and takes it out of the tab order, which
		// is the whole of "non-interactive" for an icon button.
		this.extraSettingsEl.classList.toggle('is-disabled', disabled);
		if (disabled) {
			this.extraSettingsEl.removeAttribute('tabindex');
		} else {
			this.extraSettingsEl.setAttribute('tabindex', '0');
		}
		return this;
	}

	onClick(callback: () => void): this {
		this.extraSettingsEl.addEventListener('click', callback);
		return this;
	}
}

/**
 * Mock TextAreaComponent: the same contract as {@link TextComponent} over a
 * textarea element, which is what Obsidian's own component is.
 */
export class TextAreaComponent {
	inputEl: HTMLTextAreaElement = addObsidianDomExtensions(
		document.createElement('textarea'),
	);
	value = '';
	disabled = false;

	/** Change handler, stored as Obsidian does for test triggering. */
	changeCallback: ((value: string) => void) | null = null;

	constructor() {
		this.inputEl.addEventListener('input', () => {
			if (this.disabled) {
				return;
			}
			this.value = this.inputEl.value;
			this.changeCallback?.(this.inputEl.value);
		});
	}

	setPlaceholder(placeholder: string): this {
		this.inputEl.placeholder = placeholder;
		return this;
	}

	setValue(value: string): this {
		this.value = value;
		this.inputEl.value = value;
		return this;
	}

	setDisabled(disabled: boolean): this {
		this.disabled = disabled;
		// Mirrored onto the element like real Obsidian, whose
		// AbstractTextComponent sets inputEl.disabled, so a DOM-level
		// assertion sees a field the user cannot type into.
		this.inputEl.disabled = disabled;
		return this;
	}

	onChange(callback: (value: string) => void): this {
		this.changeCallback = callback;
		return this;
	}
}

/**
 * Mock ToggleComponent class.
 */
export class ToggleComponent {
	toggleEl: HTMLElement = addObsidianDomExtensions(
		document.createElement('div'),
	);
	value = false;
	disabled = false;

	/** Change handler, stored as Obsidian does for test triggering. */
	changeCallback: ((value: boolean) => void) | null = null;

	constructor() {
		// Mirrors Obsidian: clicking the toggle flips the value and
		// fires the change handler
		this.toggleEl.classList.add('checkbox-container');
		this.toggleEl.addEventListener('click', () => {
			if (this.disabled) {
				return;
			}
			this.value = !this.value;
			this.changeCallback?.(this.value);
		});
	}

	setValue(value: boolean): this {
		this.value = value;
		return this;
	}

	setDisabled(disabled: boolean): this {
		this.disabled = disabled;
		// Obsidian marks a disabled toggle with is-disabled rather than a DOM
		// disabled attribute, since it is a div and not an input.
		this.toggleEl.classList.toggle('is-disabled', disabled);
		return this;
	}

	setTooltip(_tooltip: string): this {
		return this;
	}

	onChange(callback: (value: boolean) => void): this {
		this.changeCallback = callback;
		return this;
	}
}

/**
 * Mock SliderComponent class.
 */
export class SliderComponent {
	sliderEl: HTMLInputElement = addObsidianDomExtensions(
		document.createElement('input'),
	);
	value = 0;
	disabled = false;

	/** Change handler, stored as Obsidian does for test triggering. */
	changeCallback: ((value: number) => void) | null = null;

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

	setDisabled(disabled: boolean): this {
		this.disabled = disabled;
		return this;
	}

	onChange(callback: (value: number) => void): this {
		this.changeCallback = callback;
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

/**
 * Splits a link text into its file path and subpath (`#...`), mirroring
 * Obsidian's parseLinktext. The alias (`|...`) is assumed already stripped, as
 * it is in the metadata cache's `link` field.
 */
export function parseLinktext(linktext: string): {
	path: string;
	subpath: string;
} {
	const hashIndex = linktext.indexOf('#');
	if (hashIndex < 0) {
		return { path: linktext, subpath: '' };
	}
	return {
		path: linktext.slice(0, hashIndex),
		subpath: linktext.slice(hashIndex),
	};
}

/**
 * Minimal request parameter the {@link requestUrl} mock receives. Mirrors the
 * fields the HTTP client passes (Obsidian's real `RequestUrlParam` has more).
 */
export interface MockRequestUrlParam {
	url: string;
	method?: string;
	headers?: Record<string, string>;
	body?: string | ArrayBuffer;
	contentType?: string;
	throw?: boolean;
}

/**
 * Minimal response the {@link requestUrl} mock returns - the subset of
 * Obsidian's `RequestUrlResponse` that the HTTP client reads.
 */
export interface MockRequestUrlResponse {
	status: number;
	headers: Record<string, string>;
	text: string;
}

/** Handler a test installs to script {@link requestUrl} responses. */
export type RequestUrlHandler = (
	param: MockRequestUrlParam,
) => MockRequestUrlResponse | Promise<MockRequestUrlResponse>;

let requestUrlHandler: RequestUrlHandler | null = null;

/**
 * Installs the handler the {@link requestUrl} mock delegates to (pass null to
 * clear). Tests script network responses through it and should clear it in an
 * afterEach so handlers do not leak between tests.
 */
export function __setRequestUrlHandler(
	handler: RequestUrlHandler | null,
): void {
	requestUrlHandler = handler;
}

/**
 * Mock requestUrl. Delegates to the test-installed handler; rejects when none
 * is installed so an unmocked network call fails loudly instead of hanging.
 */
export function requestUrl(
	param: MockRequestUrlParam,
): Promise<MockRequestUrlResponse> {
	if (!requestUrlHandler) {
		return Promise.reject(
			new Error(
				`requestUrl mock: no handler installed (called ${param.url})`,
			),
		);
	}
	return Promise.resolve(requestUrlHandler(param));
}

export const Platform = {
	isMobile: false,
	isMobileApp: false,
};

/** Mock of obsidian's module-level API version export. */
export const apiVersion = '1.12.3';

/**
 * Mock AbstractInputSuggest: enough surface for components that attach
 * popover suggestions to a text input (TextInputSuggest). Suggestions
 * never open in tests; the constructor and the value plumbing suffice.
 */
export abstract class AbstractInputSuggest<T> {
	limit = 100;

	constructor(
		public app: App,
		protected inputEl: HTMLInputElement | HTMLDivElement,
	) {}

	protected abstract getSuggestions(query: string): T[] | Promise<T[]>;
	abstract renderSuggestion(value: T, el: HTMLElement): void;

	setValue(value: string): void {
		if (this.inputEl instanceof HTMLInputElement) {
			this.inputEl.value = value;
		}
	}

	getValue(): string {
		return this.inputEl instanceof HTMLInputElement
			? this.inputEl.value
			: '';
	}

	selectSuggestion(_value: T, _evt: MouseEvent | KeyboardEvent): void {
		// Mock implementation
	}

	onSelect(
		_callback: (value: T, evt: MouseEvent | KeyboardEvent) => unknown,
	): this {
		return this;
	}

	open(): void {
		// Mock implementation
	}

	close(): void {
		// Mock implementation
	}
}

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
