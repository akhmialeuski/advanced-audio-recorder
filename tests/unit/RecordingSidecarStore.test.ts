/**
 * Tests for the shared per-recording sidecar store: reading version-1 files,
 * migrating to version 2 on write, keeping markers and transcript data from
 * clobbering each other, output upserts, the history cap, deleting the file
 * only when fully empty, rename/delete mirroring, and concurrent writes to
 * both sections.
 */

import type { App } from 'obsidian';
import type { PlayerMarker } from 'src/markers/markerModel';
import { RecordingSidecarStore } from 'src/sidecar/RecordingSidecarStore';
import type { NoteOutput } from 'src/sidecar/recordingSidecarModel';

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

function noteOutput(path: string, llmProcessed = false): NoteOutput {
	return {
		path,
		templates: {
			lineFormat: '{timestamp} {speaker} {text}',
			speakerFormat: '**{speaker}**',
			includeTimestamps: true,
			timestampLinks: true,
			mergeConsecutiveSpeaker: true,
		},
		llmProcessed,
		writtenAt: '2026-07-21T10:00:00Z',
	};
}

/** Reads and parses the raw sidecar file for assertions. */
function rawSidecar(
	files: Map<string, string>,
	path = 'rec.wav.markers.json',
): Record<string, unknown> {
	return JSON.parse(files.get(path) ?? '{}') as Record<string, unknown>;
}

describe('RecordingSidecarStore', () => {
	it('reads a version-1 markers file', async () => {
		const { app, files } = makeApp();
		files.set(
			'rec.wav.markers.json',
			JSON.stringify({ version: 1, markers: [marker('a', 1)] }),
		);
		const store = new RecordingSidecarStore(app);
		expect(await store.getMarkers('rec.wav')).toEqual([marker('a', 1)]);
		expect(await store.getTranscript('rec.wav')).toEqual({
			speakers: [],
			noteOutputs: [],
			fileOutputs: [],
			history: [],
		});
	});

	it('migrates a version-1 file to version 2 on the first write, keeping markers intact', async () => {
		const { app, files } = makeApp();
		files.set(
			'rec.wav.markers.json',
			JSON.stringify({ version: 1, markers: [marker('a', 1)] }),
		);
		const store = new RecordingSidecarStore(app);
		await store.setSpeakers('rec.wav', [{ label: 'Speaker 1' }]);

		const written = rawSidecar(files);
		expect(written.version).toBe(2);
		expect(written.markers).toEqual([marker('a', 1)]);

		const reloaded = new RecordingSidecarStore(app);
		expect(await reloaded.getMarkers('rec.wav')).toEqual([marker('a', 1)]);
		expect((await reloaded.getTranscript('rec.wav')).speakers).toEqual([
			{ label: 'Speaker 1' },
		]);
	});

	it('keeps the transcript section when markers are rewritten, and vice versa', async () => {
		const { app } = makeApp();
		const store = new RecordingSidecarStore(app);
		await store.setSpeakers('rec.wav', [
			{ label: 'Speaker 1', name: 'Alex' },
		]);
		await store.setMarkers('rec.wav', [marker('a', 1)]);
		await store.setSpeakers('rec.wav', [
			{ label: 'Speaker 1', name: 'Alex' },
			{ label: 'Speaker 2' },
		]);

		const reloaded = new RecordingSidecarStore(app);
		expect(await reloaded.getMarkers('rec.wav')).toEqual([marker('a', 1)]);
		expect((await reloaded.getTranscript('rec.wav')).speakers).toEqual([
			{ label: 'Speaker 1', name: 'Alex' },
			{ label: 'Speaker 2' },
		]);
	});

	describe('setSpeakers', () => {
		it('replaces mentioned entries and keeps entries for vanished labels', async () => {
			const { app } = makeApp();
			const store = new RecordingSidecarStore(app);
			await store.setSpeakers('rec.wav', [
				{ label: 'Speaker 1', name: 'Alex' },
				{ label: 'Speaker 2', name: 'Bob' },
				{ label: 'Speaker 3' },
			]);
			// The next transcription saw only two speakers; Speaker 2 keeps
			// its stored name at the tail, and a cleared name is removed.
			await store.setSpeakers('rec.wav', [
				{ label: 'Speaker 1' },
				{ label: 'Speaker 3', name: 'Cleo' },
			]);
			expect((await store.getTranscript('rec.wav')).speakers).toEqual([
				{ label: 'Speaker 1' },
				{ label: 'Speaker 3', name: 'Cleo' },
				{ label: 'Speaker 2', name: 'Bob' },
			]);
		});
	});

	describe('output records', () => {
		it('upserts note and file outputs by path', async () => {
			const { app } = makeApp();
			const store = new RecordingSidecarStore(app);
			await store.setSpeakers('rec.wav', [{ label: 'Speaker 1' }]);
			await store.recordNoteOutput('rec.wav', noteOutput('a.md'));
			await store.recordNoteOutput('rec.wav', noteOutput('b.md'));
			await store.recordNoteOutput('rec.wav', noteOutput('a.md', true));
			await store.recordFileOutput('rec.wav', {
				path: 'rec.srt',
				format: 'srt',
				writtenAt: 't1',
			});
			await store.recordFileOutput('rec.wav', {
				path: 'rec.srt',
				format: 'srt',
				writtenAt: 't2',
			});

			const section = await store.getTranscript('rec.wav');
			expect(section.noteOutputs.map((o) => o.path)).toEqual([
				'a.md',
				'b.md',
			]);
			expect(section.noteOutputs[0]?.llmProcessed).toBe(true);
			expect(section.fileOutputs).toEqual([
				{ path: 'rec.srt', format: 'srt', writtenAt: 't2' },
			]);
		});
	});

	describe('pushHistory', () => {
		it('appends entries and caps the history at ten', async () => {
			const { app } = makeApp();
			const store = new RecordingSidecarStore(app);
			for (let i = 0; i < 12; i++) {
				await store.pushHistory('rec.wav', {
					'Speaker 1': `Name ${String(i)}`,
				});
			}
			const history = (await store.getTranscript('rec.wav')).history;
			expect(history).toHaveLength(10);
			expect(history[0]?.names).toEqual({ 'Speaker 1': 'Name 2' });
			expect(history[9]?.names).toEqual({ 'Speaker 1': 'Name 11' });
			expect(history[9]?.at).toEqual(expect.any(String));
		});
	});

	describe('file lifecycle', () => {
		it('keeps the file while either section still holds data', async () => {
			const { app, files } = makeApp();
			const store = new RecordingSidecarStore(app);
			await store.setMarkers('rec.wav', [marker('a', 1)]);
			await store.setSpeakers('rec.wav', [{ label: 'Speaker 1' }]);

			await store.setMarkers('rec.wav', []);
			expect(files.has('rec.wav.markers.json')).toBe(true);

			// Clearing the whole transcript section too leaves nothing worth
			// persisting, so only now does the file go away.
			await store.setTranscript('rec.wav', {
				speakers: [],
				noteOutputs: [],
				fileOutputs: [],
				history: [],
			});
			expect(files.has('rec.wav.markers.json')).toBe(false);
		});

		it('keeps the file for transcript data alone (no markers)', async () => {
			const { app, files } = makeApp();
			const store = new RecordingSidecarStore(app);
			await store.recordFileOutput('rec.wav', {
				path: 'rec.srt',
				format: 'srt',
				writtenAt: 't',
			});
			await store.setMarkers('rec.wav', []);
			expect(files.has('rec.wav.markers.json')).toBe(true);
		});

		it('moves the sidecar with the recording on rename', async () => {
			const { app, files } = makeApp();
			const store = new RecordingSidecarStore(app);
			await store.setSpeakers('rec.wav', [
				{ label: 'Speaker 1', name: 'Alex' },
			]);
			await store.handleRename('rec.wav', 'renamed.wav');
			expect(files.has('rec.wav.markers.json')).toBe(false);
			expect(files.has('renamed.wav.markers.json')).toBe(true);
			expect((await store.getTranscript('renamed.wav')).speakers).toEqual(
				[{ label: 'Speaker 1', name: 'Alex' }],
			);
		});

		it('removes the sidecar when the recording is deleted', async () => {
			const { app, files } = makeApp();
			const store = new RecordingSidecarStore(app);
			await store.setSpeakers('rec.wav', [{ label: 'Speaker 1' }]);
			await store.handleDelete('rec.wav');
			expect(files.has('rec.wav.markers.json')).toBe(false);
		});
	});

	describe('degradation and concurrency', () => {
		it('starts empty when the sidecar is corrupt', async () => {
			const { app, files } = makeApp();
			files.set('rec.wav.markers.json', 'not json');
			const warn = jest
				.spyOn(console, 'warn')
				.mockImplementation(() => undefined);
			const store = new RecordingSidecarStore(app);
			expect(await store.getMarkers('rec.wav')).toEqual([]);
			expect((await store.getTranscript('rec.wav')).speakers).toEqual([]);
			warn.mockRestore();
		});

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
			const warn = jest
				.spyOn(console, 'warn')
				.mockImplementation(() => undefined);
			const store = new RecordingSidecarStore(app);
			await expect(
				store.setSpeakers('rec.wav', [{ label: 'Speaker 1' }]),
			).resolves.toBeUndefined();
			warn.mockRestore();
		});

		it('serializes concurrent writes to both sections without losing either', async () => {
			const { app } = makeApp();
			const store = new RecordingSidecarStore(app);
			await Promise.all([
				store.setMarkers('rec.wav', [marker('a', 1)]),
				store.setSpeakers('rec.wav', [
					{ label: 'Speaker 1', name: 'Alex' },
				]),
				store.recordNoteOutput('rec.wav', noteOutput('a.md')),
				store.pushHistory('rec.wav', { 'Speaker 1': 'Alex' }),
			]);

			const reloaded = new RecordingSidecarStore(app);
			expect(await reloaded.getMarkers('rec.wav')).toEqual([
				marker('a', 1),
			]);
			const section = await reloaded.getTranscript('rec.wav');
			expect(section.speakers).toEqual([
				{ label: 'Speaker 1', name: 'Alex' },
			]);
			expect(section.noteOutputs).toHaveLength(1);
			expect(section.history).toHaveLength(1);
		});
	});
});
