/**
 * Shared App double for unit tests. Builds the vault/workspace/
 * metadataCache/fileManager surface most suites hand-roll, with every
 * method a fresh jest.fn per call, so tests only override what they
 * assert on. Also builds the TFile doubles those suites need.
 * @module tests/helpers/createApp
 */

import { TFile } from 'obsidian';
import type { App } from 'obsidian';

/** The mutable double returned by createMockApp. */
export interface MockApp {
	vault: {
		adapter: {
			exists: jest.Mock;
			stat: jest.Mock;
			rename: jest.Mock;
			readBinary: jest.Mock;
			writeBinary: jest.Mock;
			remove: jest.Mock;
		};
		createBinary: jest.Mock;
		createFolder: jest.Mock;
		readBinary: jest.Mock;
		read: jest.Mock;
		modify: jest.Mock;
		process: jest.Mock;
		getAbstractFileByPath: jest.Mock;
		getFileByPath: jest.Mock;
		getResourcePath: jest.Mock;
		on: jest.Mock;
	};
	workspace: {
		getActiveFile: jest.Mock;
		getActiveViewOfType: jest.Mock;
		getLeavesOfType: jest.Mock;
		on: jest.Mock;
		trigger: jest.Mock;
		onLayoutReady: jest.Mock;
	};
	metadataCache: {
		getFirstLinkpathDest: jest.Mock;
		getFileCache: jest.Mock;
	};
	fileManager: {
		trashFile: jest.Mock;
	};
}

/**
 * Deep-partial override shape for {@link createMockApp}.
 */
export type MockAppOverrides = {
	[K in keyof MockApp]?: Partial<MockApp[K]> & Record<string, unknown>;
};

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
				remove: jest.fn().mockResolvedValue(undefined),
				...(overrides.vault as { adapter?: object } | undefined)
					?.adapter,
			},
			createBinary: jest.fn().mockResolvedValue(undefined),
			createFolder: jest.fn().mockResolvedValue(undefined),
			readBinary: jest.fn().mockResolvedValue(new ArrayBuffer(0)),
			read: jest.fn().mockResolvedValue(''),
			modify: jest.fn().mockResolvedValue(undefined),
			process: jest.fn().mockResolvedValue(''),
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
			on: jest.fn().mockReturnValue({}),
			trigger: jest.fn(),
			onLayoutReady: jest.fn((callback: () => void) => callback()),
			...overrides.workspace,
		},
		metadataCache: {
			getFirstLinkpathDest: jest.fn().mockReturnValue(null),
			getFileCache: jest.fn().mockReturnValue(null),
			...overrides.metadataCache,
		},
		fileManager: {
			trashFile: jest.fn().mockResolvedValue(undefined),
			...overrides.fileManager,
		},
	};
	return { mock, app: mock as unknown as App };
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
export function createFile(path: string): TFile {
	const name = path.split('/').at(-1) ?? path;
	const parts = name.split('.');
	const extension = parts.length > 1 ? (parts.pop() ?? '') : '';
	return Object.assign(Object.create(TFile.prototype) as TFile, {
		path,
		name,
		basename: parts.join('.'),
		extension,
	});
}
