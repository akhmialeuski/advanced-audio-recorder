/**
 * Tests for the cross-session media-kind cache (issue #39: without it,
 * the first probe of every file - and the embed work behind it - repeated
 * every Obsidian session). The cache must be strictly best-effort: stale
 * entries are dropped by mtime/size, and a missing or corrupt file only
 * means files are re-probed.
 */

import { TFile } from 'obsidian';
import type { App } from 'obsidian';
import { MediaKindStore } from 'src/player/MediaKindStore';

const STORE_PATH = '.obsidian/plugins/advanced-audio-recorder/media-kinds.json';

/** In-memory adapter backing so two stores can share "disk". */
function makeApp(files: Map<string, string> = new Map()): {
	app: App;
	files: Map<string, string>;
	write: jest.Mock;
} {
	const write = jest.fn((path: string, data: string) => {
		files.set(path, data);
		return Promise.resolve();
	});
	const app = {
		vault: {
			adapter: {
				exists: (path: string) => Promise.resolve(files.has(path)),
				read: (path: string) => {
					const data = files.get(path);
					return data === undefined
						? Promise.reject(new Error('missing'))
						: Promise.resolve(data);
				},
				write,
			},
		},
	} as unknown as App;
	return { app, files, write };
}

/** Builds a TFile stub with the stats the store validates against. */
function fileWithStat(path: string, mtime: number, size: number): TFile {
	return Object.assign(Object.create(TFile.prototype), {
		path,
		stat: { ctime: 0, mtime, size },
	}) as TFile;
}

describe('MediaKindStore', () => {
	it('persists entries and loads them back in a later session', async () => {
		const { app, files } = makeApp();
		const first = new MediaKindStore(app, STORE_PATH);
		first.set(fileWithStat('a.webm', 111, 5), 'audio');
		first.set(fileWithStat('b.mp4', 222, 9), 'video');
		first.flush();
		await Promise.resolve();
		expect(files.has(STORE_PATH)).toBe(true);

		// A fresh store (next session) reads the same file back
		const second = new MediaKindStore(app, STORE_PATH);
		await second.load();
		expect(second.get(fileWithStat('a.webm', 111, 5))).toBe('audio');
		expect(second.get(fileWithStat('b.mp4', 222, 9))).toBe('video');
	});

	it('drops an entry whose mtime or size changed (file was edited/replaced)', () => {
		const { app } = makeApp();
		const store = new MediaKindStore(app, STORE_PATH);
		store.set(fileWithStat('a.webm', 111, 5), 'audio');

		expect(store.get(fileWithStat('a.webm', 999, 5))).toBeNull();
		// The stale entry was dropped, so even the original stats miss now
		// and the caller re-probes the current content
		expect(store.get(fileWithStat('a.webm', 111, 5))).toBeNull();
	});

	it('lets entries set before load completes win over loaded ones', async () => {
		const { app, files } = makeApp();
		files.set(
			STORE_PATH,
			JSON.stringify({
				version: 1,
				entries: { 'a.webm': { kind: 'video', mtime: 1, size: 1 } },
			}),
		);
		const store = new MediaKindStore(app, STORE_PATH);

		// A probe from this session lands before the async load finishes
		store.set(fileWithStat('a.webm', 2, 2), 'audio');
		await store.load();

		expect(store.get(fileWithStat('a.webm', 2, 2))).toBe('audio');
	});

	it('tolerates a corrupt cache file (everything just re-probes)', async () => {
		const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
		try {
			const { app, files } = makeApp();
			files.set(STORE_PATH, 'not json at all');
			const store = new MediaKindStore(app, STORE_PATH);

			await expect(store.load()).resolves.toBeUndefined();
			expect(store.get(fileWithStat('a.webm', 1, 1))).toBeNull();
		} finally {
			warnSpy.mockRestore();
		}
	});

	it('ignores a cache file with an unknown version or malformed entries', async () => {
		const { app, files } = makeApp();
		files.set(
			STORE_PATH,
			JSON.stringify({
				version: 999,
				entries: { 'a.webm': { kind: 'audio', mtime: 1, size: 1 } },
			}),
		);
		const store = new MediaKindStore(app, STORE_PATH);
		await store.load();
		expect(store.get(fileWithStat('a.webm', 1, 1))).toBeNull();

		files.set(
			STORE_PATH,
			JSON.stringify({
				version: 1,
				entries: {
					'bad-kind.webm': { kind: 'noise', mtime: 1, size: 1 },
					'bad-stat.webm': { kind: 'audio', mtime: 'x', size: 1 },
					'good.webm': { kind: 'audio', mtime: 1, size: 1 },
				},
			}),
		);
		const second = new MediaKindStore(app, STORE_PATH);
		await second.load();
		expect(second.get(fileWithStat('bad-kind.webm', 1, 1))).toBeNull();
		expect(second.get(fileWithStat('bad-stat.webm', 1, 1))).toBeNull();
		expect(second.get(fileWithStat('good.webm', 1, 1))).toBe('audio');
	});

	it('moves an entry on rename and drops it on delete', () => {
		const { app } = makeApp();
		const store = new MediaKindStore(app, STORE_PATH);
		store.set(fileWithStat('old.webm', 111, 5), 'audio');

		store.handleRename('old.webm', 'new.webm');
		expect(store.get(fileWithStat('old.webm', 111, 5))).toBeNull();
		expect(store.get(fileWithStat('new.webm', 111, 5))).toBe('audio');

		store.handleDelete('new.webm');
		expect(store.get(fileWithStat('new.webm', 111, 5))).toBeNull();
	});

	it('evicts the oldest entries beyond the cap', () => {
		const { app } = makeApp();
		const store = new MediaKindStore(app, STORE_PATH);
		// One over the cap: the first inserted entry must give way
		for (let i = 0; i <= 2000; i++) {
			store.set(fileWithStat(`file-${String(i)}.webm`, i, i), 'audio');
		}

		expect(store.get(fileWithStat('file-0.webm', 0, 0))).toBeNull();
		expect(store.get(fileWithStat('file-2000.webm', 2000, 2000))).toBe(
			'audio',
		);
	});

	it('is inert without a file path (plugin directory unknown)', async () => {
		const { app, write } = makeApp();
		const store = new MediaKindStore(app, null);

		store.set(fileWithStat('a.webm', 1, 1), 'audio');
		store.flush();
		await store.load();
		await Promise.resolve();

		expect(write).not.toHaveBeenCalled();
		// The in-memory side still works for the current session
		expect(store.get(fileWithStat('a.webm', 1, 1))).toBe('audio');
	});

	it('keeps the change pending when a write fails, and retries on the next flush', async () => {
		const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
		try {
			const { app, write } = makeApp();
			write.mockRejectedValueOnce(new Error('disk full'));
			const store = new MediaKindStore(app, STORE_PATH);

			store.set(fileWithStat('a.webm', 1, 1), 'audio');
			store.flush();
			await Promise.resolve();
			await Promise.resolve();

			// The failed write left the store dirty; another change + flush
			// writes everything
			store.set(fileWithStat('b.webm', 2, 2), 'audio');
			store.flush();
			await Promise.resolve();
			expect(write).toHaveBeenCalledTimes(2);
			const lastPayload = JSON.parse(
				write.mock.calls[1][1] as string,
			) as { entries: Record<string, unknown> };
			expect(Object.keys(lastPayload.entries)).toEqual([
				'a.webm',
				'b.webm',
			]);
		} finally {
			warnSpy.mockRestore();
		}
	});
});
