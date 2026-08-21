/**
 * Contract tests for the vault and workspace doubles.
 *
 * These used to answer a fixed empty value - `getFileByPath` always null,
 * `adapter.read` always an empty string - which no test could configure, so
 * forty-four files built their own vault literal instead. The store behind
 * them is what makes the shared mock usable, so the store gets tests.
 * @module tests/unit/mocks/obsidianVault.test
 */

// Imported from the mock by path: seed and seedActiveView are the mock's own
// contract and are deliberately absent from the real type definitions.
import { App, TFile, TFolder, Vault } from '../../mocks/obsidian';
import type { VaultSeedFile } from '../../mocks/obsidian';
import { at } from '../../helpers/assertions';

/**
 * Builds an ArrayBuffer with recognisable contents.
 * @param bytes - Byte values to store
 * @returns A buffer holding exactly those bytes
 */
function bufferOf(bytes: number[]): ArrayBuffer {
	return new Uint8Array(bytes).buffer;
}

/**
 * Seeds one file and hands back the TFile, without the index-safety dance a
 * destructure would need.
 * @param vault - Vault to seed
 * @param entry - File to place in it
 * @returns The seeded file
 */
function seedOne(vault: Vault, entry: VaultSeedFile): TFile {
	return at(vault.seed([entry]), 0);
}

describe('Vault.seed', () => {
	it('makes a seeded file findable by path', () => {
		const vault = new Vault();

		const file = seedOne(vault, { path: 'Recordings/a.wav' });

		expect(vault.getFileByPath('Recordings/a.wav')).toBe(file);
	});

	it('answers null for a path it was never given', () => {
		const vault = new Vault();
		seedOne(vault, { path: 'Recordings/a.wav' });

		expect(vault.getFileByPath('Recordings/missing.wav')).toBeNull();
	});

	it('derives basename, extension, and name from the path', () => {
		const vault = new Vault();

		const file = seedOne(vault, { path: 'Recordings/take.2.wav' });

		expect(file.basename).toBe('take.2');
		expect(file.extension).toBe('wav');
		expect(file.name).toBe('take.2.wav');
	});

	it('reports the size and mtime it was seeded with', () => {
		const vault = new Vault();

		const file = seedOne(vault, {
			path: 'a.wav',
			size: 4096,
			mtime: 1_700_000_000,
		});

		expect(file.stat.size).toBe(4096);
		expect(file.stat.mtime).toBe(1_700_000_000);
	});

	it.each([
		{
			name: 'text contents',
			entry: { path: 'note.md', content: 'hello' },
			size: 5,
		},
		{
			name: 'binary contents',
			entry: { path: 'a.wav', data: new Uint8Array([1, 2, 3]).buffer },
			size: 3,
		},
		{ name: 'nothing at all', entry: { path: 'empty.md' }, size: 0 },
	])('derives the size from $name when none is given', ({ entry, size }) => {
		const vault = new Vault();

		expect(seedOne(vault, entry).stat.size).toBe(size);
	});

	it('reads back the text it was seeded with', async () => {
		const vault = new Vault();
		const file = seedOne(vault, { path: 'note.md', content: '# Title' });

		await expect(vault.read(file)).resolves.toBe('# Title');
		await expect(vault.cachedRead(file)).resolves.toBe('# Title');
		await expect(vault.adapter.read('note.md')).resolves.toBe('# Title');
	});

	it('reads back the bytes it was seeded with', async () => {
		const vault = new Vault();
		const file = seedOne(vault, {
			path: 'a.wav',
			data: bufferOf([7, 8, 9]),
		});

		const viaFile = await vault.readBinary(file);
		const viaAdapter = await vault.adapter.readBinary('a.wav');

		expect([...new Uint8Array(viaFile)]).toEqual([7, 8, 9]);
		expect([...new Uint8Array(viaAdapter)]).toEqual([7, 8, 9]);
	});

	it('keeps one TFile per path when a path is seeded twice', () => {
		const vault = new Vault();

		const first = seedOne(vault, { path: 'a.wav', size: 1 });
		const second = seedOne(vault, { path: 'a.wav', size: 2 });

		expect(second).toBe(first);
		expect(first.stat.size).toBe(2);
	});

	it('lists every seeded file', () => {
		const vault = new Vault();
		vault.seed([{ path: 'a.wav' }, { path: 'b.wav' }]);

		expect(vault.getFiles().map((file) => file.path)).toEqual([
			'a.wav',
			'b.wav',
		]);
	});
});

describe('Vault.adapter', () => {
	it.each([
		{ name: 'a seeded text file', path: 'note.md', expected: true },
		{ name: 'a seeded binary file', path: 'a.wav', expected: true },
		{ name: 'an unknown path', path: 'nowhere.md', expected: false },
	])('exists answers $expected for $name', async ({ path, expected }) => {
		const vault = new Vault();
		vault.seed([
			{ path: 'note.md', content: 'x' },
			{ path: 'a.wav', data: bufferOf([1]) },
		]);

		await expect(vault.adapter.exists(path)).resolves.toBe(expected);
	});

	it('makes a written file exist and read back', async () => {
		const vault = new Vault();

		await vault.adapter.write('note.md', 'written');

		await expect(vault.adapter.exists('note.md')).resolves.toBe(true);
		await expect(vault.adapter.read('note.md')).resolves.toBe('written');
	});

	it('appends onto the bytes already stored', async () => {
		const vault = new Vault();

		await vault.adapter.append('a.pcm', bufferOf([1, 2]));
		await vault.adapter.append('a.pcm', bufferOf([3]));

		const stored = await vault.adapter.readBinary('a.pcm');
		expect([...new Uint8Array(stored)]).toEqual([1, 2, 3]);
	});

	it('treats an append to an unknown path as the first write', async () => {
		const vault = new Vault();

		await vault.adapter.append('a.pcm', bufferOf([4]));

		const stored = await vault.adapter.readBinary('a.pcm');
		expect([...new Uint8Array(stored)]).toEqual([4]);
	});

	it('moves the contents on rename', async () => {
		const vault = new Vault();
		await vault.adapter.write('old.md', 'body');

		await vault.adapter.rename('old.md', 'new.md');

		await expect(vault.adapter.exists('old.md')).resolves.toBe(false);
		await expect(vault.adapter.read('new.md')).resolves.toBe('body');
	});

	it('drops the contents on remove', async () => {
		const vault = new Vault();
		await vault.adapter.write('note.md', 'body');

		await vault.adapter.remove('note.md');

		await expect(vault.adapter.exists('note.md')).resolves.toBe(false);
	});

	it('answers an empty read for an unknown path rather than throwing', async () => {
		const vault = new Vault();

		await expect(vault.adapter.read('nowhere.md')).resolves.toBe('');
		const bytes = await vault.adapter.readBinary('nowhere.wav');
		expect(bytes.byteLength).toBe(0);
	});
});

describe('Vault writers', () => {
	it('createBinary returns a TFile for the path it wrote', async () => {
		const vault = new Vault();

		const file = await vault.createBinary('out/a.wav', bufferOf([1, 2]));

		expect(file).toBeInstanceOf(TFile);
		expect(file.path).toBe('out/a.wav');
		expect(file.stat.size).toBe(2);
	});

	it('createBinary indexes what it wrote so the vault can find it', async () => {
		const vault = new Vault();

		await vault.createBinary('out/a.wav', bufferOf([1]));

		expect(vault.getFileByPath('out/a.wav')?.path).toBe('out/a.wav');
	});

	it('create stores text that reads back', async () => {
		const vault = new Vault();

		const file = await vault.create('note.md', 'body');

		await expect(vault.read(file)).resolves.toBe('body');
	});

	it('modify replaces the stored text', async () => {
		const vault = new Vault();
		const file = seedOne(vault, { path: 'note.md', content: 'before' });

		await vault.modify(file, 'after');

		await expect(vault.read(file)).resolves.toBe('after');
	});

	// The atomic rewrite: production code that touches a note the user may
	// have open reaches for this and nothing else.
	it('process hands the current text to the callback', async () => {
		const vault = new Vault();
		const file = seedOne(vault, { path: 'note.md', content: 'before' });
		const seen: string[] = [];

		await vault.process(file, (data) => {
			seen.push(data);
			return data;
		});

		expect(seen).toEqual(['before']);
	});

	it('process stores what the callback returned', async () => {
		const vault = new Vault();
		const file = seedOne(vault, { path: 'note.md', content: 'before' });

		await vault.process(file, () => 'after');

		await expect(vault.read(file)).resolves.toBe('after');
	});

	it('process answers with the text it stored', async () => {
		const vault = new Vault();
		const file = seedOne(vault, { path: 'note.md', content: 'before' });

		await expect(vault.process(file, () => 'after')).resolves.toBe('after');
	});

	// Answering "" for a file the vault does not hold would make a rewrite
	// aimed at the wrong note report success: rewriting an empty string
	// yields an empty string, so nothing reads as changed and nothing reads
	// as failed. The real API throws, and so does this.
	it('process refuses a path the vault does not hold', async () => {
		const vault = new Vault();
		const file = seedOne(vault, { path: 'note.md', content: 'body' });
		const missing = new TFile('gone.md');

		await expect(vault.process(missing, (data) => data)).rejects.toThrow(
			'no file at gone.md',
		);
		// The refused path is not invented on the way out.
		await expect(vault.read(file)).resolves.toBe('body');
		expect(vault.getFileByPath('gone.md')).toBeNull();
	});

	it('is a spy, so a test can assert the call as well as the result', async () => {
		const vault = new Vault();

		await vault.createBinary('out/a.wav', bufferOf([1]));

		expect(vault.createBinary).toHaveBeenCalledWith(
			'out/a.wav',
			expect.anything(),
		);
	});

	it('can be overridden per test without replacing the vault', () => {
		const vault = new Vault();
		seedOne(vault, { path: 'a.wav' });

		vault.getFileByPath.mockReturnValue(null);

		expect(vault.getFileByPath('a.wav')).toBeNull();
	});
});

describe('Workspace', () => {
	it('reports no active view until one is seeded', () => {
		const { workspace } = new App();

		expect(workspace.getActiveViewOfType(class {})).toBeNull();
	});

	it('reports the view it was seeded with', () => {
		const { workspace } = new App();
		const view = { file: null };

		workspace.seedActiveView(view);

		expect(workspace.getActiveViewOfType(class {})).toBe(view);
	});

	it('runs an onLayoutReady callback at once', () => {
		const { workspace } = new App();
		const callback = jest.fn();

		workspace.onLayoutReady(callback);

		expect(callback).toHaveBeenCalledTimes(1);
	});
});

describe('Vault.recurseChildren', () => {
	it('visits the root and every descendant', () => {
		const root = new TFolder('');
		const nested = new TFolder('Recordings');
		nested.children.push(new TFile('Recordings/a.wav'));
		root.children.push(nested);
		const seen: string[] = [];

		Vault.recurseChildren(root, (file) => {
			seen.push(file.path);
		});

		expect(seen).toEqual(['', 'Recordings', 'Recordings/a.wav']);
	});

	it('visits only the root when it has no children', () => {
		const seen: string[] = [];

		Vault.recurseChildren(new TFolder('Empty'), (file) => {
			seen.push(file.path);
		});

		expect(seen).toEqual(['Empty']);
	});
});

describe('the vault folder tree', () => {
	it('grows the folders a seeded path lives in', () => {
		// getFolderOptions and every other Vault.recurseChildren caller walks
		// this tree, so a flat file index would leave them seeing nothing.
		const vault = new Vault();
		vault.seed([{ path: 'Archive/2024/old.webm' }]);

		const seen: string[] = [];
		Vault.recurseChildren(vault.getRoot(), (file) => {
			seen.push(file.path);
		});

		expect(seen).toEqual([
			'',
			'Archive',
			'Archive/2024',
			'Archive/2024/old.webm',
		]);
	});

	it('reuses a folder two files share', () => {
		const vault = new Vault();
		vault.seed([
			{ path: 'Recordings/one.webm' },
			{ path: 'Recordings/two.webm' },
		]);

		const folders: string[] = [];
		Vault.recurseChildren(vault.getRoot(), (file) => {
			if (file instanceof TFolder) {
				folders.push(file.path);
			}
		});

		expect(folders).toEqual(['', 'Recordings']);
	});

	it('points a file at the folder holding it', () => {
		const vault = new Vault();
		const file = at(vault.seed([{ path: 'Recordings/one.webm' }]), 0);

		expect(file.parent?.path).toBe('Recordings');
	});

	it('adds a file at the root straight to the root', () => {
		const vault = new Vault();
		vault.seed([{ path: 'loose.webm' }]);

		expect(vault.getRoot().children.map((child) => child.path)).toEqual([
			'loose.webm',
		]);
	});

	it('does not add a file twice when it is written again', () => {
		const vault = new Vault();
		vault.seed([{ path: 'Recordings/one.webm', content: 'first' }]);
		vault.seed([{ path: 'Recordings/one.webm', content: 'second' }]);

		expect(vault.getRoot().children).toHaveLength(1);
		expect(at(vault.getRoot().children, 0)).toBeInstanceOf(TFolder);
		expect(
			(at(vault.getRoot().children, 0) as TFolder).children,
		).toHaveLength(1);
	});
});

describe('Vault.forget', () => {
	// The tree and the index are read by different callers - recurseChildren
	// walks the tree, getFileByPath reads the index - so a trash that clears
	// only one leaves the vault contradicting itself.
	it('drops the file from the index and from its folder', () => {
		const vault = new Vault();
		const file = seedOne(vault, {
			path: 'Audio/rec.wav',
			content: 'x',
		});
		const folder = at(vault.getRoot().children, 0) as TFolder;

		vault.forget('Audio/rec.wav');

		expect(vault.getFileByPath('Audio/rec.wav')).toBeNull();
		expect(folder.children).not.toContain(file);
	});

	it('gives the folder one child again when the path is re-created', async () => {
		const vault = new Vault();
		seedOne(vault, { path: 'Audio/rec.wav', content: 'x' });
		const folder = at(vault.getRoot().children, 0) as TFolder;

		vault.forget('Audio/rec.wav');
		await vault.create('Audio/rec.wav', 'again');

		expect(folder.children).toHaveLength(1);
	});

	it('tells the listeners the file is gone', () => {
		const vault = new Vault();
		const file = seedOne(vault, { path: 'Audio/rec.wav', content: 'x' });
		const deleted = jest.fn();
		vault.on('delete', deleted);

		vault.forget('Audio/rec.wav');

		expect(deleted).toHaveBeenCalledWith(file);
	});

	it('does nothing for a path it never held', () => {
		const vault = new Vault();
		const deleted = jest.fn();
		vault.on('delete', deleted);

		vault.forget('Audio/never.wav');

		expect(deleted).not.toHaveBeenCalled();
	});
});
