/**
 * Tests for the marker persistence store.
 */

import type { App } from 'obsidian';
import { MarkerStore } from 'src/player/markers/MarkerStore';
import type { PlayerMarker } from 'src/player/markers/markerModel';

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
	};
	const app = { vault: { adapter } } as unknown as App;
	return { app, files };
}

function marker(id: string, time: number): PlayerMarker {
	return { id, time, label: id, kind: 'bookmark' };
}

const INDEX_PATH = '.obsidian/plugins/aar/player-markers.json';

describe('MarkerStore', () => {
	it('returns an empty list for unknown files', async () => {
		const { app } = makeApp();
		const store = new MarkerStore(app, INDEX_PATH);
		expect(await store.get('missing.wav')).toEqual([]);
	});

	it('persists and reloads markers across instances', async () => {
		const { app, files } = makeApp();
		const store = new MarkerStore(app, INDEX_PATH);
		await store.set('rec.wav', [marker('a', 10), marker('b', 5)]);

		// A fresh store reads what the first one wrote
		const reloaded = new MarkerStore(app, INDEX_PATH);
		const markers = await reloaded.get('rec.wav');
		expect(markers.map((m) => m.id)).toEqual(['b', 'a']);
		expect(files.has(INDEX_PATH)).toBe(true);
	});

	it('drops a file entry when set to an empty list', async () => {
		const { app } = makeApp();
		const store = new MarkerStore(app, INDEX_PATH);
		await store.set('rec.wav', [marker('a', 1)]);
		await store.set('rec.wav', []);
		expect(await store.get('rec.wav')).toEqual([]);

		const reloaded = new MarkerStore(app, INDEX_PATH);
		expect(await reloaded.get('rec.wav')).toEqual([]);
	});

	it('starts empty when the index file is corrupt', async () => {
		const { app, files } = makeApp();
		files.set(INDEX_PATH, 'not json');
		const store = new MarkerStore(app, INDEX_PATH);
		expect(await store.get('rec.wav')).toEqual([]);
	});

	it('keeps markers in memory when no index path is available', async () => {
		const { app } = makeApp();
		const store = new MarkerStore(app, null);
		await store.set('rec.wav', [marker('a', 1)]);
		expect(await store.get('rec.wav')).toEqual([marker('a', 1)]);
	});
});
