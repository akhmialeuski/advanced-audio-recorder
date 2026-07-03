/**
 * Tests for the sidecar-based marker persistence store.
 */

import type { App } from 'obsidian';
import { MarkerStore } from 'src/markers/MarkerStore';
import type { PlayerMarker } from 'src/markers/markerModel';

/**
 * Builds a fake App whose adapter is backed by an in-memory file map,
 * and exposes that map for assertions.
 */
function makeApp(): { app: App; files: Map<string, string> } {
	const files = new Map<string, string>();
	const adapter = {
		exists: (path: string): Promise<boolean> =>
			Promise.resolve(files.has(path)),
		read: (path: string): Promise<string> =>
			Promise.resolve(files.get(path) ?? ''),
		write: (path: string, data: string): Promise<void> => {
			files.set(path, data);
			return Promise.resolve();
		},
		remove: (path: string): Promise<void> => {
			files.delete(path);
			return Promise.resolve();
		},
		rename: (from: string, to: string): Promise<void> => {
			const value = files.get(from);
			if (value !== undefined) {
				files.set(to, value);
				files.delete(from);
			}
			return Promise.resolve();
		},
	};
	const app = { vault: { adapter } } as unknown as App;
	return { app, files };
}

function marker(id: string, time: number): PlayerMarker {
	return { id, time, label: id, kind: 'bookmark' };
}

describe('MarkerStore (sidecar)', () => {
	it('returns an empty list for recordings without a sidecar', async () => {
		const { app } = makeApp();
		const store = new MarkerStore(app);
		expect(await store.get('missing.wav')).toEqual([]);
	});

	it('persists to a sidecar next to the recording and reloads it', async () => {
		const { app, files } = makeApp();
		const store = new MarkerStore(app);
		await store.set('folder/rec.wav', [marker('a', 10), marker('b', 5)]);
		expect(files.has('folder/rec.wav.markers.json')).toBe(true);

		// A fresh store reads what the first one wrote, time-sorted
		const reloaded = new MarkerStore(app);
		const markers = await reloaded.get('folder/rec.wav');
		expect(markers.map((m) => m.id)).toEqual(['b', 'a']);
	});

	it('removes the sidecar when set to an empty list', async () => {
		const { app, files } = makeApp();
		const store = new MarkerStore(app);
		await store.set('rec.wav', [marker('a', 1)]);
		await store.set('rec.wav', []);
		expect(files.has('rec.wav.markers.json')).toBe(false);

		const reloaded = new MarkerStore(app);
		expect(await reloaded.get('rec.wav')).toEqual([]);
	});

	it('starts empty when the sidecar is corrupt', async () => {
		const { app, files } = makeApp();
		files.set('rec.wav.markers.json', 'not json');
		const store = new MarkerStore(app);
		expect(await store.get('rec.wav')).toEqual([]);
	});

	it('moves the sidecar with the recording on rename', async () => {
		const { app, files } = makeApp();
		const store = new MarkerStore(app);
		await store.set('rec.wav', [marker('a', 1)]);

		await store.handleRename('rec.wav', 'renamed.wav');
		expect(files.has('rec.wav.markers.json')).toBe(false);
		expect(files.has('renamed.wav.markers.json')).toBe(true);
		expect(await store.get('renamed.wav')).toEqual([marker('a', 1)]);
	});

	it('removes the sidecar when the recording is deleted', async () => {
		const { app, files } = makeApp();
		const store = new MarkerStore(app);
		await store.set('rec.wav', [marker('a', 1)]);

		await store.handleDelete('rec.wav');
		expect(files.has('rec.wav.markers.json')).toBe(false);
	});
});

describe('MarkerStore - negative and concurrency cases', () => {
	it('does not throw when the adapter write fails', async () => {
		const app = {
			vault: {
				adapter: {
					exists: (): Promise<boolean> => Promise.resolve(false),
					read: (): Promise<string> => Promise.resolve(''),
					write: (): Promise<void> =>
						Promise.reject(new Error('disk full')),
					remove: (): Promise<void> => Promise.resolve(),
					rename: (): Promise<void> => Promise.resolve(),
				},
			},
		} as unknown as App;
		const store = new MarkerStore(app);
		await expect(
			store.set('rec.wav', [marker('a', 1)]),
		).resolves.toBeUndefined();
	});

	it('returns an empty list when the adapter read fails', async () => {
		const app = {
			vault: {
				adapter: {
					exists: (): Promise<boolean> => Promise.resolve(true),
					read: (): Promise<string> =>
						Promise.reject(new Error('io error')),
				},
			},
		} as unknown as App;
		const store = new MarkerStore(app);
		expect(await store.get('rec.wav')).toEqual([]);
	});

	it('rename is a no-op when no sidecar exists', async () => {
		const { app, files } = makeApp();
		const store = new MarkerStore(app);
		await store.handleRename('a.wav', 'b.wav');
		expect(files.size).toBe(0);
	});

	it('delete is a no-op when no sidecar exists', async () => {
		const { app, files } = makeApp();
		const store = new MarkerStore(app);
		await store.handleDelete('a.wav');
		expect(files.size).toBe(0);
	});

	it('caches the first read and ignores later on-disk changes', async () => {
		const { app, files } = makeApp();
		const store = new MarkerStore(app);
		await store.set('rec.wav', [marker('a', 1)]);
		// Mutate the file behind the cache; get must still return cached
		files.set(
			'rec.wav.markers.json',
			JSON.stringify({ version: 1, markers: [] }),
		);
		expect((await store.get('rec.wav')).map((m) => m.id)).toEqual(['a']);
	});

	it('serializes concurrent writes without corrupting the sidecar', async () => {
		const { app } = makeApp();
		const store = new MarkerStore(app);
		await Promise.all([
			store.set('rec.wav', [marker('a', 1)]),
			store.set('rec.wav', [marker('a', 1), marker('b', 2)]),
		]);
		const reloaded = new MarkerStore(app);
		const markers = await reloaded.get('rec.wav');
		expect(markers.length).toBeGreaterThan(0);
	});
});
