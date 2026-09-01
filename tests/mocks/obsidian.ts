/**
 * The Obsidian API, as the test suite sees it.
 *
 * The `obsidian` package ships type definitions and no runtime at all
 * (`"main": ""`) - a real one is provided by the app - so a plugin's tests have
 * to supply the runtime themselves. This module is that runtime, wired in
 * through `moduleNameMapper`, which makes it the single Obsidian every suite
 * runs against.
 *
 * ## What is modelled
 *
 * Roughly fifty of the API's ~290 exports: the plugin lifecycle, the vault and
 * workspace (both event-backed), files and folders, modals and the settings
 * components, menus, notices, `requestUrl`, `Platform`, and the DOM extensions
 * Obsidian puts on every element. The Vault keeps a small in-memory store so
 * reads answer what was written; seed it with `vault.seed([...])`.
 *
 * ## What is not
 *
 * Editors beyond the handful of methods the plugin calls, views and leaves
 * beyond `getActiveViewOfType`, the canvas and bases APIs, and everything else
 * the plugin never touches. Absence is deliberate: an export nothing uses is an
 * export nothing keeps honest.
 *
 * ## Adding to it
 *
 * Add what a real test needs, when it needs it, and give the addition a test in
 * `tests/unit/mocks/` - the suite's correctness rests on this file behaving
 * like the thing it stands in for.
 *
 * Before adding, consider the alternative the Obsidian community recommends:
 * move the logic out from under the API. Code here that does not import
 * `obsidian` is markedly better covered than code that does, because it can be
 * tested without any of this.
 *
 * ## What not to do
 *
 * Do not shadow this module with `jest.mock('obsidian', () => ({ ... }))`. A
 * factory replaces the module wholesale, so that file alone gets a thinner
 * Obsidian than the rest of the suite and the two drift apart silently. When a
 * test genuinely needs one class to behave differently, spread this module and
 * override the one export - see `tests/mocks/modules/`.
 * @module tests/mocks/obsidian
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- the real API types
   each event name separately; the mock only has to accept any handler. */

/** A subscriber registered through {@link Events.on}. */
export type EventCallback = (...args: any[]) => void;

/** Handle returned by {@link Events.on}, accepted by offref. */
export interface EventRef {
	name: string;
	callback: EventCallback;
}

/**
 * Mock Events: the pub/sub base the real Vault, Workspace, and MetadataCache
 * extend.
 *
 * Without it a test could not deliver a vault rename or a workspace
 * window-open to the code that registered for it, so every such test grew its
 * own app-shaped literal with `on: jest.fn()` and reached into the mock's call
 * list to find the handler. The registrar and the context menu still have the
 * lowest branch coverage in the player for exactly that reason.
 */
export class Events {
	private readonly handlers = new Map<string, Set<EventCallback>>();

	on(name: string, callback: EventCallback): EventRef {
		const set = this.handlers.get(name) ?? new Set<EventCallback>();
		set.add(callback);
		this.handlers.set(name, set);
		return { name, callback };
	}

	off(name: string, callback: EventCallback): void {
		this.handlers.get(name)?.delete(callback);
	}

	offref(ref: EventRef): void {
		this.off(ref.name, ref.callback);
	}

	/**
	 * Delivers an event to everything currently subscribed.
	 * @param name - Event name
	 * @param args - Arguments passed to each handler
	 */
	trigger(name: string, ...args: unknown[]): void {
		// Copied first: a handler is allowed to unsubscribe itself.
		for (const handler of [...(this.handlers.get(name) ?? [])]) {
			handler(...args);
		}
	}

	/**
	 * How many handlers are listening, for a test asserting that a component
	 * unsubscribed on unload.
	 * @param name - Event name
	 * @returns Number of live handlers
	 */
	countHandlers(name: string): number {
		return this.handlers.get(name)?.size ?? 0;
	}
}

export { addObsidianDomExtensions } from './domExtensions';
import { addObsidianDomExtensions } from './domExtensions';

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

	/**
	 * Commands the plugin registered, in order.
	 *
	 * The real Obsidian keeps these in its command palette, which is where a
	 * user reaches them; recording them here is what lets a test invoke a
	 * command the way the palette would instead of calling the private method
	 * behind it.
	 */
	readonly registeredCommands: Command[] = [];

	/** Ribbon icons the plugin added, with the element each returned. */
	readonly ribbonIcons: {
		icon: string;
		title: string;
		callback: (event: MouseEvent) => void;
		el: HTMLElement;
	}[] = [];

	/** Status bar items the plugin added, in order. */
	readonly statusBarItems: HTMLElement[] = [];

	/** Setting tabs the plugin added, in order. */
	readonly settingTabs: PluginSettingTab[] = [];

	/** Intervals the plugin registered, in order. */
	readonly registeredIntervals: number[] = [];

	addCommand(command: Command): Command {
		this.registeredCommands.push(command);
		return command;
	}

	/**
	 * Runs a registered command the way the palette would.
	 * @param id - The command id
	 * @returns Whether a checkCallback reported the command as available
	 */
	invokeCommand(id: string): boolean {
		const command = this.registeredCommands.find(
			(entry) => entry.id === id,
		);
		if (!command) {
			const known = this.registeredCommands
				.map((entry) => entry.id)
				.join(', ');
			throw new Error(
				`No command "${id}". Registered: ${known || '(none)'}`,
			);
		}
		if (command.checkCallback) {
			// The palette asks first, then runs; a command that says no is
			// never shown, so a test that skipped the ask would exercise a
			// path the user cannot reach.
			if (!command.checkCallback(true)) {
				return false;
			}
			command.checkCallback(false);
			return true;
		}
		command.callback?.();
		return true;
	}

	addRibbonIcon(
		icon: string,
		title: string,
		callback: (event: MouseEvent) => void,
	): HTMLElement {
		const el = addObsidianDomExtensions(document.createElement('div'));
		this.ribbonIcons.push({ icon, title, callback, el });
		return el;
	}

	addSettingTab(settingTab: PluginSettingTab): void {
		this.settingTabs.push(settingTab);
	}

	addStatusBarItem(): HTMLElement {
		const el = addObsidianDomExtensions(document.createElement('div'));
		this.statusBarItems.push(el);
		return el;
	}

	registerInterval(id: number): number {
		this.registeredIntervals.push(id);
		return id;
	}

	/**
	 * Records an event registration so a test can assert the plugin releases
	 * it. The real Plugin unsubscribes these on unload; so does this one.
	 * @param ref - Handle returned by an Events.on call
	 * @returns The same handle, as the real API does
	 */
	registerEvent(ref: EventRef): EventRef {
		this.registeredEvents.push(ref);
		return ref;
	}

	/** Event handles passed to {@link registerEvent}, in order. */
	readonly registeredEvents: EventRef[] = [];

	async loadData(): Promise<unknown> {
		return {};
	}

	async saveData(_data: unknown): Promise<void> {
		// Mock implementation
	}

	/**
	 * CLI commands the plugin registered, in order. The real app answers these
	 * on the desktop command line; recording them is what lets a test run one
	 * the way a shell would.
	 */
	readonly registeredCliCommands: {
		id: string;
		description: string;
		flags: unknown;
		handler: (params: Record<string, string>) => string | Promise<string>;
	}[] = [];

	registerCliHandler(
		command: string,
		description: string,
		flags: unknown,
		handler: (params: Record<string, string>) => string | Promise<string>,
	): void {
		this.registeredCliCommands.push({
			id: command,
			description,
			flags,
			handler,
		});
	}

	/**
	 * Runs a registered CLI command the way the command line would.
	 * @param id - The command id, as typed
	 * @param params - Flags as typed
	 * @returns What the handler answers with
	 */
	async invokeCliCommand(
		id: string,
		params: Record<string, string> = {},
	): Promise<string> {
		const command = this.registeredCliCommands.find(
			(entry) => entry.id === id,
		);
		if (!command) {
			const known = this.registeredCliCommands
				.map((entry) => entry.id)
				.join(', ');
			throw new Error(
				`No CLI command "${id}". Registered: ${known || '(none)'}`,
			);
		}
		return command.handler(params);
	}
}

/**
 * Mock App class.
 */
export class App {
	vault: Vault = new Vault();
	workspace: Workspace = new Workspace();
	metadataCache: MetadataCache = new MetadataCache();
	fileManager: FileManager = new FileManager(this.vault);
	/**
	 * The settings dialog, which is internal API in the real app and absent
	 * unless a test stands one up (see obsidian/settingsNavigation).
	 */
	setting?: {
		closePage?: () => void;
		open?: () => void;
		openTabById?: (id: string) => void;
	};
}

/**
 * Mock FileManager.
 *
 * Two methods, and the plugin cannot do without either: trashing a source
 * after a conversion, and building the wikilink a transcript timestamp is
 * written as. Both were absent, so anything that reached them from a test
 * driving the plugin threw on `undefined`.
 */
export class FileManager {
	constructor(private readonly vault: Vault) {}

	trashFile = jest.fn(
		async (file: TFile, _system?: boolean): Promise<void> => {
			this.vault.forget(file.path);
		},
	);

	// Obsidian drops the extension for a note and keeps it for anything else,
	// which is the difference between an audio embed that resolves and one
	// that silently points at nothing. Subpath and alias are appended as it
	// does.
	generateMarkdownLink = jest.fn(
		(
			file: TFile,
			_sourcePath: string,
			subpath?: string,
			alias?: string,
		): string => {
			const target = file.extension === 'md' ? file.basename : file.name;
			return `[[${target}${subpath ?? ''}${alias ? `|${alias}` : ''}]]`;
		},
	);
}

/**
 * Mock MetadataCache. Events-backed like the real one; the plugin listens for
 * `changed` and `resolved`.
 */
export class MetadataCache extends Events {
	/**
	 * The link graph Obsidian maintains: note path -> linked path -> count.
	 * The vault-wide link rewrite starts from this to find which notes to
	 * open at all, so a test that seeds no graph rewrites nothing.
	 */
	resolvedLinks: Record<string, Record<string, number>> = {};

	getFileCache = jest.fn((_file: TFile): unknown => null);
	getFirstLinkpathDest = jest.fn(
		(_linkpath: string, _sourcePath: string): TFile | null => null,
	);
}

/** One entry in a seeded vault. */
export interface VaultSeedFile {
	path: string;
	/** Text contents, for adapter.read and cachedRead. */
	content?: string;
	/** Binary contents, for adapter.readBinary and readBinary. */
	data?: ArrayBuffer;
	mtime?: number;
	size?: number;
}

/**
 * Mock Vault.
 *
 * Every method is a jest.fn so a test can both assert on the call and override
 * the answer, and the defaults read a small in-memory store rather than
 * returning a fixed empty value. Before that, `getFileByPath` always answered
 * null and `adapter.read` always answered an empty string, which is why so
 * many tests built their own vault literal instead of using this one.
 *
 * Seed the store with {@link Vault.seed}.
 */
export class Vault extends Events {
	private readonly files = new Map<string, TFile>();
	private readonly text = new Map<string, string>();
	private readonly binary = new Map<string, ArrayBuffer>();

	adapter = {
		exists: jest.fn(
			async (path: string): Promise<boolean> =>
				this.text.has(path) || this.binary.has(path),
		),
		read: jest.fn(
			async (path: string): Promise<string> => this.text.get(path) ?? '',
		),
		write: jest.fn(async (path: string, data: string): Promise<void> => {
			this.text.set(path, data);
		}),
		append: jest.fn(
			async (path: string, data: ArrayBuffer): Promise<void> => {
				const existing = this.binary.get(path);
				if (!existing) {
					this.binary.set(path, data);
					return;
				}
				const merged = new Uint8Array(
					existing.byteLength + data.byteLength,
				);
				merged.set(new Uint8Array(existing), 0);
				merged.set(new Uint8Array(data), existing.byteLength);
				this.binary.set(path, merged.buffer);
			},
		),
		rename: jest.fn(
			async (oldPath: string, newPath: string): Promise<void> => {
				const moveIn = <T>(store: Map<string, T>): void => {
					if (!store.has(oldPath)) {
						return;
					}
					store.set(newPath, store.get(oldPath) as T);
					store.delete(oldPath);
				};
				moveIn(this.text);
				moveIn(this.binary);
			},
		),
		readBinary: jest.fn(
			async (path: string): Promise<ArrayBuffer> =>
				this.binary.get(path) ?? new ArrayBuffer(0),
		),
		writeBinary: jest.fn(
			async (path: string, data: ArrayBuffer): Promise<void> => {
				this.binary.set(path, data);
			},
		),
		remove: jest.fn(async (path: string): Promise<void> => {
			this.text.delete(path);
			this.binary.delete(path);
		}),
	};

	createBinary = jest.fn(
		async (path: string, data: ArrayBuffer): Promise<TFile> => {
			this.binary.set(path, data);
			return this.registerFile(path, data.byteLength);
		},
	);

	create = jest.fn(async (path: string, data: string): Promise<TFile> => {
		this.text.set(path, data);
		return this.registerFile(path, data.length);
	});

	read = jest.fn(
		async (file: TFile): Promise<string> => this.text.get(file.path) ?? '',
	);

	cachedRead = jest.fn(
		async (file: TFile): Promise<string> => this.text.get(file.path) ?? '',
	);

	readBinary = jest.fn(
		async (file: TFile): Promise<ArrayBuffer> =>
			this.binary.get(file.path) ?? new ArrayBuffer(0),
	);

	modify = jest.fn(async (file: TFile, data: string): Promise<void> => {
		this.text.set(file.path, data);
	});

	// The atomic read-modify-write Obsidian added for exactly the case a
	// plain read-then-modify gets wrong: an edit landing between the two.
	// Code that rewrites a note the user may have open uses this and nothing
	// else, so a vault without it fails every such rewrite.
	//
	// It refuses a path the vault does not hold, as the real one does.
	// Answering "" for an unknown file instead would make a rewrite aimed at
	// the wrong note report success - the rewrite of an empty string equals
	// the empty string, so nothing looks changed and nothing looks failed -
	// and would invent a file at that path for the rest of the test.
	process = jest.fn(
		async (file: TFile, fn: (data: string) => string): Promise<string> => {
			if (!this.text.has(file.path)) {
				throw new Error(
					`Vault.process: no file at ${file.path}. Seed it, or ` +
						'check the path the code under test resolved.',
				);
			}
			const next = fn(this.text.get(file.path) ?? '');
			this.text.set(file.path, next);
			return next;
		},
	);

	getFileByPath = jest.fn(
		(path: string): TFile | null => this.files.get(path) ?? null,
	);

	/**
	 * Drops a file from the index, the stores, and its folder, as trashing it
	 * does, then fires the `delete` event the real vault fires.
	 *
	 * Detaching from the folder matters: `Vault.recurseChildren` walks the
	 * tree, not the index, so a file removed from one and not the other is
	 * still listed by anything reading the tree - and re-creating the path
	 * would then give its folder two children for one file.
	 * @param path - Vault-relative path
	 */
	forget(path: string): void {
		const file = this.files.get(path);
		if (!file) {
			return;
		}
		const siblings = file.parent?.children;
		const index = siblings?.indexOf(file) ?? -1;
		if (siblings && index >= 0) {
			siblings.splice(index, 1);
		}
		this.files.delete(path);
		this.text.delete(path);
		this.binary.delete(path);
		this.trigger('delete', file);
	}

	getAbstractFileByPath = jest.fn(
		(path: string): TAbstractFile | null => this.files.get(path) ?? null,
	);

	getResourcePath = jest.fn(
		(file: TFile): string => `app://vault/${file.path}`,
	);

	getRoot = jest.fn((): TFolder => this.root);

	/**
	 * The vault's folder tree, grown as files are seeded so
	 * `Vault.recurseChildren` walks the same structure the paths describe.
	 * Obsidian's own root is a TFolder with an empty path.
	 */
	private readonly root = new TFolder('');

	/** Every folder in the tree, by path, so a seed reuses what exists. */
	private readonly folders = new Map<string, TFolder>();

	getFiles = jest.fn((): TFile[] => [...this.files.values()]);

	/**
	 * Fills the vault so its readers answer consistently: a seeded file is
	 * found by path, exists, and reads back what it was given.
	 * @param files - Files to place in the vault
	 * @returns The TFile objects created, in the order seeded
	 */
	seed(files: VaultSeedFile[]): TFile[] {
		return files.map((entry) => {
			if (entry.content !== undefined) {
				this.text.set(entry.path, entry.content);
			}
			if (entry.data !== undefined) {
				this.binary.set(entry.path, entry.data);
			}
			const size =
				entry.size ??
				entry.data?.byteLength ??
				entry.content?.length ??
				0;
			return this.registerFile(entry.path, size, entry.mtime ?? 0);
		});
	}

	/**
	 * Adds a path to the file index, reusing the TFile if it is already known
	 * so identity survives a rewrite.
	 * @param path - Vault-relative path
	 * @param size - Byte size to report through stat
	 * @param mtime - Modification time to report through stat
	 * @returns The indexed file
	 */
	private registerFile(path: string, size: number, mtime = 0): TFile {
		const existing = this.files.get(path);
		const file = existing ?? new TFile(path);
		file.stat = { size, mtime, ctime: mtime };
		if (!existing) {
			const parent = this.registerFolders(path);
			file.parent = parent;
			parent.children.push(file);
		}
		this.files.set(path, file);
		return file;
	}

	/**
	 * Creates the folders a path lives in, reusing any that already exist.
	 * @param filePath - Vault-relative path of the file being indexed
	 * @returns The folder directly holding the file
	 */
	private registerFolders(filePath: string): TFolder {
		const segments = filePath.split('/').slice(0, -1);
		let parent = this.root;
		let prefix = '';
		for (const segment of segments) {
			prefix = prefix === '' ? segment : `${prefix}/${segment}`;
			const known = this.folders.get(prefix);
			if (known) {
				parent = known;
				continue;
			}
			const folder = new TFolder(prefix);
			folder.parent = parent;
			parent.children.push(folder);
			this.folders.set(prefix, folder);
			parent = folder;
		}
		return parent;
	}

	static recurseChildren(
		root: TFolder,
		callback: (file: TAbstractFile) => void,
	): void {
		const walk = (folder: TFolder): void => {
			for (const child of folder.children) {
				callback(child);
				if (child instanceof TFolder) {
					walk(child);
				}
			}
		};
		callback(root);
		walk(root);
	}
}

/**
 * Mock Workspace. Events-backed like the real one, so `window-open`,
 * `window-close`, and `active-leaf-change` can be delivered to whatever
 * registered for them.
 */
export class Workspace extends Events {
	private activeView: unknown = null;
	private activeFile: TFile | null = null;

	getActiveViewOfType = jest.fn(
		<T>(_type: new (...args: unknown[]) => T): T | null =>
			this.activeView as T | null,
	);

	// The file every file-action command resolves itself against: the palette
	// entries are checkCallbacks over whatever is open, so a workspace that
	// cannot report one leaves every one of them permanently unavailable.
	getActiveFile = jest.fn((): TFile | null => this.activeFile);

	onLayoutReady = jest.fn((callback: () => void): void => {
		// The mock workspace is always "ready"
		callback();
	});

	getLeavesOfType = jest.fn((_type: string): unknown[] => []);

	iterateAllLeaves = jest.fn((_callback: (leaf: unknown) => void): void => {
		// No leaves unless a test seeds them
	});

	/**
	 * Sets what getActiveViewOfType answers with.
	 * @param view - View to report as active, or null for none
	 */
	seedActiveView(view: unknown): void {
		this.activeView = view;
	}

	/**
	 * Sets what getActiveFile answers with.
	 * @param file - File to report as open, or null for none
	 */
	seedActiveFile(file: TFile | null): void {
		this.activeFile = file;
	}
}

/**
 * Mock Notice: a jest.fn-backed constructor so tests can assert on
 * `jest.mocked(Notice).mock.calls` without re-mocking the module.
 * The global clearMocks option resets the calls between tests.
 */
export const Notice = jest.fn(function (
	this: NoticeInstance,
	message: string | DocumentFragment,
	timeout?: number,
) {
	this.initialMessage = message;
	this.message = message;
	this.timeout = timeout;
	// The progress notices rewrite themselves in place, so setMessage has to
	// keep the latest text where a test can read it.
	this.setMessage = jest.fn((next: string | DocumentFragment) => {
		this.message = next;
		return this;
	});
	this.hide = jest.fn();
	noticeInstances.push(this);
});

/** A Notice the code under test raised. */
export interface NoticeInstance {
	/** What the notice was raised with, before any setMessage. */
	initialMessage: string | DocumentFragment;
	/** What the notice currently reads, after any setMessage. */
	message: string | DocumentFragment;
	timeout: number | undefined;
	setMessage: jest.Mock;
	hide: jest.Mock;
}

/**
 * The text of a notice, whether it was raised with a string or a fragment.
 * @param notice - A recorded notice
 * @returns Its current message as plain text
 */
export function noticeText(notice: NoticeInstance): string {
	return asText(notice.message);
}

/**
 * The text of every notice raised so far, in order.
 *
 * Reading `Notice.mock.calls` directly gives `string | DocumentFragment`, which
 * a test then has to stringify - and stringifying a fragment yields
 * "[object DocumentFragment]" rather than its text.
 * @returns One string per notice
 */
export function noticeMessages(): string[] {
	return noticeInstances.map(noticeInitialText);
}

/**
 * The text a notice was first raised with, before any in-place update.
 * @param notice - A recorded notice
 * @returns Its original message as plain text
 */
export function noticeInitialText(notice: NoticeInstance): string {
	return asText(notice.initialMessage);
}

/**
 * Reads a notice message that may be a string or a fragment.
 * @param message - The message to read
 * @returns Its plain text
 */
function asText(message: string | DocumentFragment): string {
	return typeof message === 'string' ? message : (message.textContent ?? '');
}

/**
 * Every Notice raised so far, newest last.
 *
 * `Notice` is a jest.fn, so the constructor arguments are already in
 * `mock.calls`; this is for the notices that are updated after they are shown,
 * where the final message is the interesting one.
 */
export const noticeInstances: NoticeInstance[] = [];

// Cleared per test from tests/setupAfterEnv.ts: this module is loaded by
// setupFiles, which runs before the test framework exists.

/**
 * Every Menu built so far, newest last.
 *
 * A menu is usually constructed inside the code under test and shown straight
 * away, so a test has no reference to assert against. Cleared per test from
 * tests/setupAfterEnv.ts.
 */
export const menuInstances: Menu[] = [];

/**
 * Mock MenuItem. Builder methods are chainable like the real API, and unlike
 * the real API they keep what they were given: the previous mock threw the
 * click handler away, so no test could invoke a context-menu entry through the
 * shared mock and every menu test had to shadow the whole obsidian module.
 */
export class MenuItem {
	title = '';
	icon = '';
	section = '';
	checked = false;
	disabled = false;
	/** The handler registered through onClick, if any. */
	clickHandler: ((event?: MouseEvent | KeyboardEvent) => void) | null = null;

	setTitle(title: string | DocumentFragment): this {
		this.title =
			typeof title === 'string' ? title : (title.textContent ?? '');
		return this;
	}
	setIcon(icon: string | null): this {
		this.icon = icon ?? '';
		return this;
	}
	setChecked(checked: boolean | null): this {
		this.checked = checked ?? false;
		return this;
	}
	setSection(section: string): this {
		this.section = section;
		return this;
	}
	setDisabled(disabled: boolean): this {
		this.disabled = disabled;
		return this;
	}
	onClick(callback: (event?: MouseEvent | KeyboardEvent) => void): this {
		this.clickHandler = callback;
		return this;
	}

	/**
	 * Invokes the registered handler, the way a user picking the entry would.
	 * @param event - Event handed to the handler
	 */
	click(event?: MouseEvent | KeyboardEvent): void {
		if (this.disabled) {
			throw new Error(`Menu item "${this.title}" is disabled`);
		}
		if (!this.clickHandler) {
			throw new Error(`Menu item "${this.title}" has no click handler`);
		}
		this.clickHandler(event);
	}
}

/**
 * Mock Menu. Builds real MenuItem objects and keeps them, so a test can read
 * the menu a component produced and pick an entry from it.
 */
export class Menu {
	constructor() {
		menuInstances.push(this);
	}

	/** Items added so far, in order. */
	readonly items: MenuItem[] = [];
	/** Where separators fall, as indices into {@link items}. */
	readonly separatorsAfter: number[] = [];
	shown = false;

	addItem(callback: (item: MenuItem) => void): this {
		const item = new MenuItem();
		callback(item);
		this.items.push(item);
		return this;
	}
	addSeparator(): this {
		this.separatorsAfter.push(this.items.length - 1);
		return this;
	}

	/** The event the menu was opened from, when it was opened from one. */
	shownAtEvent: MouseEvent | null = null;
	/** Where the menu was opened, when it was opened at a position. */
	shownAtPosition: { x: number; y: number } | null = null;

	// Plain methods rather than instance spies: a test watching every menu the
	// code opens does it with spyOn(Menu.prototype, ...), which an instance
	// property would hide. What was opened where is recorded on the instance
	// instead, which reads better than digging through mock.calls anyway.
	showAtMouseEvent(event: MouseEvent): this {
		this.shown = true;
		this.shownAtEvent = event;
		return this;
	}
	showAtPosition(position: { x: number; y: number }): this {
		this.shown = true;
		this.shownAtPosition = position;
		return this;
	}

	/**
	 * Finds an entry by its title.
	 * @param title - Exact title set through setTitle
	 * @returns The item, or undefined when the menu has no such entry
	 */
	item(title: string): MenuItem | undefined {
		return this.items.find((entry) => entry.title === title);
	}

	/**
	 * Picks an entry by title, failing loudly when it is missing so the error
	 * names the menu instead of surfacing as "cannot read property of
	 * undefined".
	 * @param title - Exact title set through setTitle
	 */
	click(title: string): void {
		const item = this.item(title);
		if (!item) {
			const available = this.items.map((entry) => entry.title).join(', ');
			throw new Error(
				`Menu has no item "${title}". Available: ${available || '(none)'}`,
			);
		}
		item.click();
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
 * Mock Modal class.
 */
/**
 * Every dialog opened since the last test, in the order they were opened.
 *
 * A test driving a command cannot construct the dialog the command opened, and
 * reaching it through the constructor mock only works for a suite that
 * replaced the class. Recording the instances lets a test read what the user
 * would be looking at. Cleared in tests/setupAfterEnv.ts.
 */
export const modalInstances: Modal[] = [];

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

	// Prototype methods, not instance spies: a test that wants to watch these
	// spies the instance (or the prototype, to catch a modal it never sees),
	// and an instance-level jest.fn would put neither within reach of spyOn.
	open(): void {
		modalInstances.push(this);
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

/** One item a fuzzy search matched, as Obsidian hands it to a renderer. */
export interface FuzzyMatch<T> {
	item: T;
	match: { score: number; matches: number[][] };
}

/**
 * Mock FuzzySuggestModal. Obsidian's own fuzzy ranking is not modelled: what
 * a plugin owns is which items it offers, how each is named, what it draws
 * for a row, and what choosing one does, so the query filter here is a plain
 * case-insensitive substring test over the item text the plugin supplies.
 *
 * The surface is Obsidian's own, so a test drives the dialog the way the
 * dialog is really driven: `getSuggestions` for a keystroke and
 * `onChooseSuggestion` for a pick. Rendering happens inside getSuggestions
 * rather than in a separate pass, which is the one shortcut taken here, so a
 * test that types can read what the rows say.
 */
export abstract class FuzzySuggestModal<T> extends Modal {
	inputEl: HTMLInputElement = document.createElement('input');

	resultContainerEl: HTMLElement = addObsidianDomExtensions(
		document.createElement('div'),
	);

	emptyStateText = 'No results found.';

	abstract getItems(): T[];

	abstract getItemText(item: T): string;

	abstract onChooseItem(item: T, evt: MouseEvent | KeyboardEvent): void;

	renderSuggestion(_match: FuzzyMatch<T>, _el: HTMLElement): void {
		// Obsidian draws the item text by default; a plugin overrides this.
	}

	setPlaceholder(placeholder: string): void {
		this.inputEl.placeholder = placeholder;
	}

	override open(): void {
		super.open();
		this.getSuggestions('');
	}

	getSuggestions(query: string): FuzzyMatch<T>[] {
		const needle = query.toLowerCase();
		const matches = this.getItems()
			.filter((item) =>
				this.getItemText(item).toLowerCase().includes(needle),
			)
			.map((item) => ({ item, match: { score: 0, matches: [] } }));
		this.resultContainerEl.empty();
		for (const match of matches) {
			this.renderSuggestion(match, this.resultContainerEl.createDiv());
		}
		return matches;
	}

	onChooseSuggestion(match: FuzzyMatch<T>, evt: MouseEvent | KeyboardEvent) {
		this.onChooseItem(match.item, evt);
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
	// The real MarkdownView carries the file through FileView; production code
	// narrows a leaf to a MarkdownView and then reads view.file.
	file: TFile | null = null;
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
	name: string;
	parent: TFolder | null = null;

	// The path defaults to empty so `new TFile()` works the way the previous
	// per-file `TFile: jest.fn()` doubles did, for tests that only need an
	// object of the right shape and set the fields they care about.
	constructor(path = '') {
		this.path = path;
		const parts = path.split('/');
		this.name = parts[parts.length - 1] ?? path;
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
	stat: { size: number; mtime: number; ctime: number } = {
		size: 0,
		mtime: 0,
		ctime: 0,
	};

	constructor(path = '') {
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
 * The shared body of Obsidian's text inputs, which is what Obsidian itself
 * calls `AbstractTextComponent`: the same value/disabled/change contract over
 * either an `<input>` or a `<textarea>`. Mirroring that hierarchy rather than
 * copying the body twice keeps the two components from drifting apart.
 */
export abstract class AbstractTextComponent<
	T extends HTMLInputElement | HTMLTextAreaElement,
> {
	value = '';
	disabled = false;

	/** Change handler, stored as Obsidian does for test triggering. */
	changeCallback: ((value: string) => void) | null = null;

	readonly inputEl: T;

	constructor(inputEl: T) {
		this.inputEl = inputEl;
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
 * Mock TextComponent class.
 */
export class TextComponent extends AbstractTextComponent<HTMLInputElement> {
	constructor() {
		super(addObsidianDomExtensions(document.createElement('input')));
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
export class TextAreaComponent extends AbstractTextComponent<HTMLTextAreaElement> {
	constructor() {
		super(addObsidianDomExtensions(document.createElement('textarea')));
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
			this.setValue(!this.value);
			this.changeCallback?.(this.value);
		});
	}

	setValue(value: boolean): this {
		this.value = value;
		// Obsidian marks an on toggle with is-enabled rather than a checked
		// attribute, since it is a div and not an input. Without this a test
		// asking what the row shows reads nothing at all, and an assertion
		// that the toggle is off passes however it was set.
		this.toggleEl.classList.toggle('is-enabled', value);
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
 * Mock setIcon: records the icon on the element as `data-icon`.
 *
 * The real one renders an SVG, which a test cannot reasonably assert on. The
 * attribute is the observable stand-in, and a spy so a test can also assert
 * that the icon was set at all.
 */
export const setIcon = jest.fn((el: HTMLElement, iconId: string): void => {
	el.setAttribute('data-icon', iconId);
});

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

/**
 * Mock of obsidian's module-level API version export, holding the version the
 * plugin builds against. Writable because it is also what requireApiVersion()
 * answers from: a test that models an older Obsidian moves it (through
 * __setApiVersion) rather than keeping a second version beside this one.
 */
export const DEFAULT_MOCK_API_VERSION = '1.13.0';

export let apiVersion: string = DEFAULT_MOCK_API_VERSION;

/**
 * Sets the app version the mock reports, for a test that models a specific
 * Obsidian. Restore the previous value when the test is done.
 * @param version - Version to report from now on
 */
export function __setApiVersion(version: string): void {
	apiVersion = version;
}

/**
 * Mock of obsidian's requireApiVersion: whether the running app is at least
 * the requested version, compared the way the real one compares - numerically,
 * segment by segment.
 * @param version - Lowest version the caller needs
 * @returns Whether the reported version is that version or newer
 */
export function requireApiVersion(version: string): boolean {
	const parse = (value: string): number[] =>
		value.split('.').map((part) => Number.parseInt(part, 10) || 0);
	const running = parse(apiVersion);
	const required = parse(version);
	const segments = Math.max(running.length, required.length);
	for (let index = 0; index < segments; index++) {
		const here = running[index] ?? 0;
		const needed = required[index] ?? 0;
		if (here !== needed) {
			return here > needed;
		}
	}
	return true;
}

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
	minAppVersion?: string;
	author?: string;
	description?: string;
	isDesktopOnly?: boolean;
	dir?: string;
}

export interface Command {
	id: string;
	name: string;
	callback?: () => void;
	/**
	 * Obsidian's conditional command: called with true to ask whether the
	 * command applies right now, and with false to run it.
	 */
	checkCallback?: (checking: boolean) => boolean | void;
	editorCallback?: (...args: unknown[]) => void;
	icon?: string;
}
