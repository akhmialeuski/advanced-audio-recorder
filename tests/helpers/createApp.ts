/**
 * Shared App double for unit tests. Builds the vault/workspace/
 * metadataCache/fileManager surface most suites hand-roll, with every
 * method a fresh jest.fn per call, so tests only override what they
 * assert on. Also builds the TFile doubles those suites need.
 * @module tests/helpers/createApp
 */

import { MarkdownView, TFile } from 'obsidian';
import type { App, Editor } from 'obsidian';

/** The mutable double returned by createMockApp. */
export interface MockApp {
	vault: {
		adapter: {
			exists: jest.Mock;
			stat: jest.Mock;
			rename: jest.Mock;
			readBinary: jest.Mock;
			writeBinary: jest.Mock;
			read: jest.Mock;
			write: jest.Mock;
			append: jest.Mock;
			mkdir: jest.Mock;
			remove: jest.Mock;
		};
		createBinary: jest.Mock;
		createFolder: jest.Mock;
		create: jest.Mock;
		readBinary: jest.Mock;
		read: jest.Mock;
		modify: jest.Mock;
		process: jest.Mock;
		rename: jest.Mock;
		delete: jest.Mock;
		getFiles: jest.Mock;
		getAbstractFileByPath: jest.Mock;
		getFileByPath: jest.Mock;
		getResourcePath: jest.Mock;
		on: jest.Mock;
	};
	workspace: {
		getActiveFile: jest.Mock;
		getActiveViewOfType: jest.Mock;
		getLeavesOfType: jest.Mock;
		iterateAllLeaves: jest.Mock;
		on: jest.Mock;
		trigger: jest.Mock;
		onLayoutReady: jest.Mock;
	};
	metadataCache: {
		getFirstLinkpathDest: jest.Mock;
		getFileCache: jest.Mock;
		on: jest.Mock;
		resolvedLinks: Record<string, Record<string, number>>;
	};
	fileManager: {
		trashFile: jest.Mock;
		generateMarkdownLink: jest.Mock;
	};
}

/**
 * Override shape for {@link createMockApp}. Every section is optional and its
 * members are typed `unknown`, because a double stands in for a method rather
 * than reimplementing it: a suite hands over a bare arrow, a `jest.fn`, or a
 * whole `Vault` from the obsidian mock, and all three are legitimate. Keys
 * outside the four sections pass through untouched.
 */
export type MockAppOverrides = {
	[K in keyof MockApp]?: { [P in keyof MockApp[K]]?: unknown };
} & Record<string, unknown>;

/**
 * Builds a fresh App double. Pass overrides to replace individual
 * methods or add extra ones; everything else keeps a benign default.
 * @param overrides - Per-section replacements merged over the defaults
 * @returns The double, plus an `app` view typed as Obsidian's App
 */
export function createMockApp(overrides: MockAppOverrides = {}): {
	mock: MockApp;
	app: App;
} {
	const mock: MockApp = {
		vault: {
			adapter: {
				exists: jest.fn().mockResolvedValue(false),
				stat: jest.fn().mockResolvedValue(null),
				rename: jest.fn().mockResolvedValue(undefined),
				readBinary: jest.fn().mockResolvedValue(new ArrayBuffer(0)),
				writeBinary: jest.fn().mockResolvedValue(undefined),
				read: jest.fn().mockResolvedValue(''),
				write: jest.fn().mockResolvedValue(undefined),
				append: jest.fn().mockResolvedValue(undefined),
				mkdir: jest.fn().mockResolvedValue(undefined),
				remove: jest.fn().mockResolvedValue(undefined),
				...(overrides.vault as { adapter?: object } | undefined)
					?.adapter,
			},
			createBinary: jest.fn().mockResolvedValue(undefined),
			createFolder: jest.fn().mockResolvedValue(undefined),
			create: jest.fn().mockResolvedValue(undefined),
			readBinary: jest.fn().mockResolvedValue(new ArrayBuffer(0)),
			read: jest.fn().mockResolvedValue(''),
			modify: jest.fn().mockResolvedValue(undefined),
			process: jest.fn().mockResolvedValue(''),
			rename: jest.fn().mockResolvedValue(undefined),
			delete: jest.fn().mockResolvedValue(undefined),
			getFiles: jest.fn().mockReturnValue([]),
			getAbstractFileByPath: jest.fn().mockReturnValue(null),
			getFileByPath: jest.fn().mockReturnValue(null),
			getResourcePath: jest.fn().mockReturnValue('app://audio'),
			on: jest.fn().mockReturnValue({}),
			...stripNested(overrides.vault, 'adapter'),
		},
		workspace: {
			getActiveFile: jest.fn().mockReturnValue(null),
			getActiveViewOfType: jest.fn().mockReturnValue(null),
			getLeavesOfType: jest.fn().mockReturnValue([]),
			iterateAllLeaves: jest.fn(),
			on: jest.fn().mockReturnValue({}),
			trigger: jest.fn(),
			onLayoutReady: jest.fn((callback: () => void) => callback()),
			...(overrides.workspace as object | undefined),
		},
		metadataCache: {
			getFirstLinkpathDest: jest.fn().mockReturnValue(null),
			getFileCache: jest.fn().mockReturnValue(null),
			on: jest.fn().mockReturnValue({}),
			resolvedLinks: {},
			...(overrides.metadataCache as object | undefined),
		},
		fileManager: {
			trashFile: jest.fn().mockResolvedValue(undefined),
			generateMarkdownLink: jest.fn().mockReturnValue('[[link]]'),
			...(overrides.fileManager as object | undefined),
		},
		...extraSections(overrides),
	};
	return { mock, app: mock as unknown as App };
}

/** The override keys the factory builds itself; anything else passes through. */
const BUILT_IN_SECTIONS = [
	'vault',
	'workspace',
	'metadataCache',
	'fileManager',
];

/**
 * Returns the override sections the factory does not build itself, so a suite
 * can hang an extra App surface (say `embedRegistry`) off the same double.
 * @param overrides - The full override object
 * @returns Only the keys outside {@link BUILT_IN_SECTIONS}
 */
function extraSections(overrides: MockAppOverrides): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(overrides).filter(
			([key]) => !BUILT_IN_SECTIONS.includes(key),
		),
	);
}

/** Returns the override object without the given nested key. */
function stripNested(
	overrides: Record<string, unknown> | undefined,
	key: string,
): Record<string, unknown> {
	if (!overrides) {
		return {};
	}
	const { [key]: _nested, ...rest } = overrides;
	return rest;
}

/**
 * Builds a TFile for a vault path, with the derived name/basename/extension
 * Obsidian fills in.
 *
 * Obsidian's own `TFile` takes no constructor arguments (a real one is minted
 * by the vault), so a test cannot build one directly and type-check against the
 * published API. This produces the same shape through the mock's prototype, so
 * `instanceof TFile` still holds for the production code that checks it.
 * @param path - Vault path, e.g. 'Recordings/take.webm'
 * @returns A file with path, name, basename, and extension set
 */
export function createFile(
	path: string,
	stat: Partial<TFile['stat']> = {},
): TFile {
	const name = path.split('/').at(-1) ?? path;
	const parts = name.split('.');
	const extension = parts.length > 1 ? (parts.pop() ?? '') : '';
	return Object.assign(Object.create(TFile.prototype) as TFile, {
		path,
		name,
		basename: parts.join('.'),
		extension,
		stat: { size: 0, mtime: 0, ctime: 0, ...stat },
	});
}

/** The editor surface a note-writing test drives, all of it spied. */
export interface SpiedEditor {
	getCursor: jest.Mock;
	setCursor: jest.Mock;
	replaceRange: jest.Mock;
	replaceSelection: jest.Mock;
	getValue: jest.Mock;
	lastLine: jest.Mock;
}

/** A MarkdownView whose editor is spied, so a test can read what was written. */
export interface SpiedMarkdownView extends MarkdownView {
	editor: Editor & SpiedEditor;
}

/**
 * Builds a MarkdownView double with a spied editor.
 *
 * Built through the prototype for the same reason {@link createFile} is: the
 * production code narrows a workspace leaf with `instanceof MarkdownView`, and
 * Obsidian's own class cannot be constructed from a test.
 * @param options - The file the view shows and where its cursor sits
 * @returns The view, with every editor method a jest.fn
 */
export function createMarkdownView(
	options: {
		file?: TFile | null;
		cursor?: { line: number; ch: number } | null;
	} = {},
): SpiedMarkdownView {
	const editor: SpiedEditor = {
		getCursor: jest
			.fn()
			.mockReturnValue(options.cursor ?? { line: 0, ch: 0 }),
		setCursor: jest.fn(),
		replaceRange: jest.fn(),
		replaceSelection: jest.fn(),
		getValue: jest.fn().mockReturnValue(''),
		lastLine: jest.fn().mockReturnValue(0),
	};
	return Object.assign(
		Object.create(MarkdownView.prototype) as SpiedMarkdownView,
		{
			file: options.file ?? null,
			editor: options.cursor === null ? null : editor,
		},
	);
}

/** A vault adapter backed by a Map, with every call a spy. */
export interface FakeVaultFiles {
	/** The files themselves, for seeding and for reading back what was written. */
	files: Map<string, string>;
	/** The adapter surface, shaped for `createMockApp({ vault: { adapter } })`. */
	adapter: {
		exists: jest.Mock;
		read: jest.Mock;
		write: jest.Mock;
		remove: jest.Mock;
		rename: jest.Mock;
	};
}

/**
 * Builds an in-memory stand-in for the vault's file adapter.
 *
 * Four suites hand-rolled the same Map behind the same five calls. Sharing it
 * is not only about the lines: `read` rejects for a path that is not there,
 * which is what Obsidian's adapter does, so a store that reads without asking
 * `exists` first fails here rather than in a vault.
 * @param seed - Files present before the test starts
 * @returns The file map and the adapter reading from it
 */
export function fakeVaultFiles(
	seed: Iterable<readonly [string, string]> = [],
): FakeVaultFiles {
	const files = new Map<string, string>(seed);
	const adapter = {
		exists: jest.fn((path: string) => Promise.resolve(files.has(path))),
		read: jest.fn((path: string) => {
			const content = files.get(path);
			return content === undefined
				? Promise.reject(new Error(`ENOENT: ${path}`))
				: Promise.resolve(content);
		}),
		write: jest.fn((path: string, data: string) => {
			files.set(path, data);
			return Promise.resolve();
		}),
		remove: jest.fn((path: string) => {
			files.delete(path);
			return Promise.resolve();
		}),
		rename: jest.fn((from: string, to: string) => {
			const value = files.get(from);
			if (value !== undefined) {
				files.set(to, value);
				files.delete(from);
			}
			return Promise.resolve();
		}),
	};
	return { files, adapter };
}

/**
 * One reference the metadata cache reports for a note: the link text and the
 * line span it sits on. Three suites declared this shape for themselves.
 */
export interface LinkRef {
	link: string;
	position: { start: { line: number }; end: { line: number } };
}

/** A note's parsed references, as `metadataCache.getFileCache` reports them. */
export interface NoteCache {
	links?: LinkRef[];
	embeds?: LinkRef[];
	frontmatterLinks?: { link: string }[];
}
