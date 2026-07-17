/**
 * Tests for the sidecar-based speaker-name persistence store.
 */

import type { App } from 'obsidian';
import { SpeakerNameStore } from 'src/speakers/SpeakerNameStore';
import type { SpeakerNames } from 'src/speakers/speakerNameModel';

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

function names(mapping: Record<string, string> = {}): SpeakerNames {
	return { speakers: ['Speaker 1', 'Speaker 2'], names: mapping };
}

describe('SpeakerNameStore (sidecar)', () => {
	it('returns an empty state for recordings without a sidecar', async () => {
		const { app } = makeApp();
		const store = new SpeakerNameStore(app);
		expect(await store.get('missing.wav')).toEqual({
			speakers: [],
			names: {},
		});
	});

	it('persists to a sidecar next to the recording and reloads it', async () => {
		const { app, files } = makeApp();
		const store = new SpeakerNameStore(app);
		await store.set('folder/rec.wav', names({ 'Speaker 1': 'Alex' }));
		expect(files.has('folder/rec.wav.speakers.json')).toBe(true);

		const reloaded = new SpeakerNameStore(app);
		expect(await reloaded.get('folder/rec.wav')).toEqual(
			names({ 'Speaker 1': 'Alex' }),
		);
	});

	it('normalizes on write: identity and empty names are not stored', async () => {
		const { app } = makeApp();
		const store = new SpeakerNameStore(app);
		await store.set(
			'rec.wav',
			names({ 'Speaker 1': 'Speaker 1', 'Speaker 2': '  ' }),
		);
		const reloaded = new SpeakerNameStore(app);
		expect(await reloaded.get('rec.wav')).toEqual(names({}));
	});

	it('removes the sidecar when set to an empty state', async () => {
		const { app, files } = makeApp();
		const store = new SpeakerNameStore(app);
		await store.set('rec.wav', names({ 'Speaker 1': 'Alex' }));
		await store.set('rec.wav', { speakers: [], names: {} });
		expect(files.has('rec.wav.speakers.json')).toBe(false);
	});

	it('starts empty when the sidecar is corrupt', async () => {
		const { app, files } = makeApp();
		files.set('rec.wav.speakers.json', 'not json');
		const store = new SpeakerNameStore(app);
		expect(await store.get('rec.wav')).toEqual({
			speakers: [],
			names: {},
		});
	});

	it('moves the sidecar with the recording on rename', async () => {
		const { app, files } = makeApp();
		const store = new SpeakerNameStore(app);
		await store.set('rec.wav', names({ 'Speaker 1': 'Alex' }));

		await store.handleRename('rec.wav', 'renamed.wav');
		expect(files.has('rec.wav.speakers.json')).toBe(false);
		expect(files.has('renamed.wav.speakers.json')).toBe(true);
		expect(await store.get('renamed.wav')).toEqual(
			names({ 'Speaker 1': 'Alex' }),
		);
	});

	it('removes the sidecar when the recording is deleted', async () => {
		const { app, files } = makeApp();
		const store = new SpeakerNameStore(app);
		await store.set('rec.wav', names({ 'Speaker 1': 'Alex' }));

		await store.handleDelete('rec.wav');
		expect(files.has('rec.wav.speakers.json')).toBe(false);
	});
});

describe('SpeakerNameStore - negative and concurrency cases', () => {
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
		const store = new SpeakerNameStore(app);
		await expect(
			store.set('rec.wav', names({ 'Speaker 1': 'Alex' })),
		).resolves.toBeUndefined();
	});

	it('returns an empty state when the adapter read fails', async () => {
		const app = {
			vault: {
				adapter: {
					exists: (): Promise<boolean> => Promise.resolve(true),
					read: (): Promise<string> =>
						Promise.reject(new Error('io error')),
				},
			},
		} as unknown as App;
		const store = new SpeakerNameStore(app);
		expect(await store.get('rec.wav')).toEqual({
			speakers: [],
			names: {},
		});
	});

	it('caches the first read and ignores later on-disk changes', async () => {
		const { app, files } = makeApp();
		const store = new SpeakerNameStore(app);
		await store.set('rec.wav', names({ 'Speaker 1': 'Alex' }));
		files.set(
			'rec.wav.speakers.json',
			JSON.stringify({ version: 1, speakers: [], names: {} }),
		);
		expect((await store.get('rec.wav')).names).toEqual({
			'Speaker 1': 'Alex',
		});
	});

	it('clearCache drops the cache so later reads hit the disk', async () => {
		const { app, files } = makeApp();
		const store = new SpeakerNameStore(app);
		await store.set('rec.wav', names({ 'Speaker 1': 'Alex' }));
		files.set(
			'rec.wav.speakers.json',
			JSON.stringify({
				version: 1,
				speakers: ['Speaker 1'],
				names: { 'Speaker 1': 'Kim' },
			}),
		);
		store.clearCache();
		expect((await store.get('rec.wav')).names).toEqual({
			'Speaker 1': 'Kim',
		});
	});

	it('serializes concurrent writes without corrupting the sidecar', async () => {
		const { app } = makeApp();
		const store = new SpeakerNameStore(app);
		await Promise.all([
			store.set('rec.wav', names({ 'Speaker 1': 'Alex' })),
			store.set(
				'rec.wav',
				names({ 'Speaker 1': 'Alex', 'Speaker 2': 'Kim' }),
			),
		]);
		const reloaded = new SpeakerNameStore(app);
		const stored = await reloaded.get('rec.wav');
		expect(stored.speakers).toEqual(['Speaker 1', 'Speaker 2']);
		expect(Object.keys(stored.names).length).toBeGreaterThan(0);
	});
});
