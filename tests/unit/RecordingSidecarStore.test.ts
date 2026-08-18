/**
 * Tests for the shared per-recording sidecar store: reading version-1 files,
 * migrating to version 2 on write, keeping markers and transcript data from
 * clobbering each other, output upserts, the history cap and undo pop,
 * deleting the file only when fully empty, rename/delete mirroring (including
 * mutations racing them through the write chain), recorded-output renames,
 * snapshot isolation, atomic marker updates, corrupt-file protection, and
 * concurrent writes to both sections.
 */

import type { App } from 'obsidian';
import { at } from '../helpers/assertions';
import type { PlayerMarker } from 'src/markers/markerModel';
import { RecordingSidecarStore } from 'src/sidecar/RecordingSidecarStore';
import type { NoteOutput } from 'src/sidecar/recordingSidecarModel';
import { partialApp } from '../helpers/obsidianMock';

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
	const app = partialApp({
		vault: {
			adapter,
			getFiles: () => [...files.keys()].map((path) => ({ path })),
		},
	});
	return { app, files };
}

function marker(id: string, time: number): PlayerMarker {
	return { id, time, label: id, kind: 'bookmark' };
}

function noteOutput(path: string): NoteOutput {
	return {
		path,
		templates: {
			lineFormat: '{timestamp} {speaker} {text}',
			speakerFormat: '**{speaker}**',
			includeTimestamps: true,
			timestampLinks: true,
			mergeConsecutiveSpeaker: true,
		},
		heading: 'Transcript',
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
			participants: [],
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

		it('keeps the first-turn offsets of the entries it stores', async () => {
			const { app } = makeApp();
			const store = new RecordingSidecarStore(app);
			await store.setSpeakers('rec.wav', [
				{
					label: 'Speaker 1',
					name: 'Alex',
					firstStart: 3,
					firstEnd: 9,
				},
			]);
			expect((await store.getTranscript('rec.wav')).speakers).toEqual([
				{
					label: 'Speaker 1',
					name: 'Alex',
					firstStart: 3,
					firstEnd: 9,
				},
			]);
		});
	});

	describe('participant roster', () => {
		it('merges names into the recording and records their profile', async () => {
			const { app } = makeApp();
			const store = new RecordingSidecarStore(app);
			await store.setSpeakers('rec.wav', [{ label: 'Speaker 1' }], {
				names: ['Alex', 'Bob'],
				profileId: 'profile-1',
			});
			// A second run with another profile ADDS to the roster: the
			// recording accumulates everyone who has been named in it.
			await store.setSpeakers('rec.wav', [{ label: 'Speaker 1' }], {
				names: ['Bob', 'Cleo'],
				profileId: 'profile-2',
			});

			const section = await store.getTranscript('rec.wav');
			expect(section.participants).toEqual(['Alex', 'Bob', 'Cleo']);
			expect(section.participantProfileId).toBe('profile-2');
		});

		it('clears the profile hint when a run picks none, keeping the names', async () => {
			const { app } = makeApp();
			const store = new RecordingSidecarStore(app);
			await store.setSpeakers('rec.wav', [{ label: 'Speaker 1' }], {
				names: ['Alex'],
				profileId: 'profile-1',
			});
			await store.setSpeakers('rec.wav', [{ label: 'Speaker 1' }], {
				names: [],
				profileId: '',
			});

			const section = await store.getTranscript('rec.wav');
			expect(section.participants).toEqual(['Alex']);
			expect(section.participantProfileId).toBeUndefined();
		});

		it('leaves the roster untouched when no update is given', async () => {
			const { app } = makeApp();
			const store = new RecordingSidecarStore(app);
			await store.setSpeakers('rec.wav', [{ label: 'Speaker 1' }], {
				names: ['Alex'],
				profileId: 'profile-1',
			});
			// The undo path re-writes the roster without touching participants.
			await store.setSpeakers('rec.wav', [{ label: 'Speaker 1' }]);

			const section = await store.getTranscript('rec.wav');
			expect(section.participants).toEqual(['Alex']);
			expect(section.participantProfileId).toBe('profile-1');
		});

		it('commitRename adds the applied names in the same write', async () => {
			const { app } = makeApp();
			const store = new RecordingSidecarStore(app);
			await store.commitRename(
				'rec.wav',
				[{ label: 'Speaker 1', name: 'Alex' }],
				{ 'Speaker 1': 'Alex' },
				{ names: ['Alex'], profileId: '' },
			);

			const section = await store.getTranscript('rec.wav');
			expect(section.participants).toEqual(['Alex']);
			expect(section.history).toHaveLength(1);
			expect(section.speakers).toEqual([
				{ label: 'Speaker 1', name: 'Alex' },
			]);
		});

		it('keeps a participants-only sidecar on disk', async () => {
			// The names are the user's own data, so they alone are worth a file
			// even after every roster and output record is gone.
			const { app, files } = makeApp();
			const store = new RecordingSidecarStore(app);
			await store.setSpeakers('rec.wav', [], {
				names: ['Alex'],
				profileId: '',
			});
			expect(files.has('rec.wav.markers.json')).toBe(true);
			expect((await store.getTranscript('rec.wav')).participants).toEqual(
				['Alex'],
			);
		});
	});

	describe('output records', () => {
		it('upserts note and file outputs by path', async () => {
			const { app } = makeApp();
			const store = new RecordingSidecarStore(app);
			await store.setSpeakers('rec.wav', [{ label: 'Speaker 1' }]);
			await store.recordNoteOutput('rec.wav', noteOutput('a.md'));
			await store.recordNoteOutput('rec.wav', noteOutput('b.md'));
			await store.recordNoteOutput('rec.wav', noteOutput('a.md'));
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
			expect(section.fileOutputs).toEqual([
				{ path: 'rec.srt', format: 'srt', writtenAt: 't2' },
			]);
		});
	});

	describe('commitRename history', () => {
		it('appends entries and caps the history at ten', async () => {
			const { app } = makeApp();
			const store = new RecordingSidecarStore(app);
			for (let i = 0; i < 12; i++) {
				await store.commitRename('rec.wav', [], {
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

	describe('popHistory', () => {
		it('removes only the newest entry, so each undo steps one back', async () => {
			const { app } = makeApp();
			const store = new RecordingSidecarStore(app);
			await store.commitRename('rec.wav', [], { 'Speaker 1': 'Alex' });
			await store.commitRename('rec.wav', [], { 'Speaker 1': 'Bob' });

			await store.popHistory('rec.wav');
			let history = (await store.getTranscript('rec.wav')).history;
			expect(history.map((entry) => entry.names)).toEqual([
				{ 'Speaker 1': 'Alex' },
			]);

			await store.popHistory('rec.wav');
			history = (await store.getTranscript('rec.wav')).history;
			expect(history).toHaveLength(0);
		});

		it('is a write-free no-op on an empty history', async () => {
			const { app, files } = makeApp();
			const store = new RecordingSidecarStore(app);
			await store.popHistory('rec.wav');
			expect(files.size).toBe(0);
		});
	});

	describe('markers', () => {
		it('returns an empty list for recordings without a sidecar', async () => {
			const { app } = makeApp();
			const store = new RecordingSidecarStore(app);
			expect(await store.getMarkers('missing.wav')).toEqual([]);
		});

		it('persists next to the recording and reloads time-sorted', async () => {
			const { app, files } = makeApp();
			const store = new RecordingSidecarStore(app);
			await store.setMarkers('folder/rec.wav', [
				marker('a', 10),
				marker('b', 5),
			]);
			expect(files.has('folder/rec.wav.markers.json')).toBe(true);

			const reloaded = new RecordingSidecarStore(app);
			const markers = await reloaded.getMarkers('folder/rec.wav');
			expect(markers.map((m) => m.id)).toEqual(['b', 'a']);
		});

		it('caches the first read and ignores later on-disk changes', async () => {
			const { app, files } = makeApp();
			const store = new RecordingSidecarStore(app);
			await store.setMarkers('rec.wav', [marker('a', 1)]);
			// Mutate the file behind the cache; the read must stay cached.
			files.set(
				'rec.wav.markers.json',
				JSON.stringify({ version: 2, markers: [] }),
			);
			expect(
				(await store.getMarkers('rec.wav')).map((m) => m.id),
			).toEqual(['a']);
		});
	});

	describe('file lifecycle', () => {
		it('keeps the file while the transcript section still holds data', async () => {
			const { app, files } = makeApp();
			const store = new RecordingSidecarStore(app);
			await store.setMarkers('rec.wav', [marker('a', 1)]);
			await store.setSpeakers('rec.wav', [{ label: 'Speaker 1' }]);

			await store.setMarkers('rec.wav', []);
			expect(files.has('rec.wav.markers.json')).toBe(true);
		});

		it('removes the file when a markers-only sidecar is emptied', async () => {
			const { app, files } = makeApp();
			const store = new RecordingSidecarStore(app);
			await store.setMarkers('rec.wav', [marker('a', 1)]);
			await store.setMarkers('rec.wav', []);
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

		it('rename and delete are no-ops when no sidecar exists', async () => {
			const { app, files } = makeApp();
			const store = new RecordingSidecarStore(app);
			await store.handleRename('a.wav', 'b.wav');
			await store.handleDelete('a.wav');
			expect(files.size).toBe(0);
		});
	});

	describe('rename/delete racing queued mutations', () => {
		it('carries a mutation queued before the rename into the new path', async () => {
			const { app, files } = makeApp();
			const store = new RecordingSidecarStore(app);
			await store.setSpeakers('rec.wav', [{ label: 'Speaker 1' }]);

			// The mutation is queued first, the rename right behind it - the
			// interleaving of a rename event landing while a write is pending.
			const mutation = store.commitRename('rec.wav', [], {
				'Speaker 1': 'Alex',
			});
			const rename = store.handleRename('rec.wav', 'renamed.wav');
			await Promise.all([mutation, rename]);

			expect(files.has('rec.wav.markers.json')).toBe(false);
			expect(files.has('renamed.wav.markers.json')).toBe(true);
			// The new path serves the post-mutation document, not a stale copy.
			const section = await store.getTranscript('renamed.wav');
			expect(section.history.map((entry) => entry.names)).toEqual([
				{ 'Speaker 1': 'Alex' },
			]);
			// No zombie document lingers under the old path.
			expect((await store.getTranscript('rec.wav')).history).toHaveLength(
				0,
			);
		});

		it('does not resurrect a document from a mutation queued before the delete', async () => {
			const { app, files } = makeApp();
			const store = new RecordingSidecarStore(app);
			await store.setSpeakers('rec.wav', [{ label: 'Speaker 1' }]);

			const mutation = store.commitRename('rec.wav', [], {
				'Speaker 1': 'Alex',
			});
			const removal = store.handleDelete('rec.wav');
			await Promise.all([mutation, removal]);

			expect(files.has('rec.wav.markers.json')).toBe(false);
			// A recording re-created at this path starts from a clean slate.
			expect((await store.getTranscript('rec.wav')).history).toHaveLength(
				0,
			);
		});
	});

	describe('handleOutputRename', () => {
		it('updates the recorded paths in a cached sidecar', async () => {
			const { app } = makeApp();
			const store = new RecordingSidecarStore(app);
			await store.recordNoteOutput('rec.wav', noteOutput('meeting.md'));
			await store.recordFileOutput('rec.wav', {
				path: 'rec.srt',
				format: 'srt',
				writtenAt: 't',
			});

			await store.handleOutputRename('meeting.md', 'archive/meeting.md');
			await store.handleOutputRename('rec.srt', 'rec-renamed.srt');

			const section = await store.getTranscript('rec.wav');
			expect(section.noteOutputs.map((o) => o.path)).toEqual([
				'archive/meeting.md',
			]);
			expect(section.fileOutputs.map((o) => o.path)).toEqual([
				'rec-renamed.srt',
			]);
		});

		it('updates an on-disk sidecar that was never loaded into the cache', async () => {
			const { app, files } = makeApp();
			const seed = new RecordingSidecarStore(app);
			await seed.recordNoteOutput('rec.wav', noteOutput('meeting.md'));

			// A fresh store (plugin restart) has nothing cached; the rename
			// must still find the sidecar on disk and update it.
			const store = new RecordingSidecarStore(app);
			await store.handleOutputRename('meeting.md', 'moved.md');

			expect(files.get('rec.wav.markers.json')).toContain('"moved.md"');
			const section = await store.getTranscript('rec.wav');
			expect(section.noteOutputs.map((o) => o.path)).toEqual([
				'moved.md',
			]);
		});

		it('drops the stale entry when the new path is already recorded', async () => {
			const { app } = makeApp();
			const store = new RecordingSidecarStore(app);
			await store.recordNoteOutput('rec.wav', noteOutput('a.md'));
			await store.recordNoteOutput('rec.wav', noteOutput('b.md'));

			await store.handleOutputRename('a.md', 'b.md');

			const section = await store.getTranscript('rec.wav');
			expect(section.noteOutputs.map((o) => o.path)).toEqual(['b.md']);
		});

		it('ignores sidecar files and unrelated paths', async () => {
			const { app, files } = makeApp();
			const store = new RecordingSidecarStore(app);
			await store.recordNoteOutput('rec.wav', noteOutput('meeting.md'));
			const before = files.get('rec.wav.markers.json');

			// Sidecar renames follow their recording through handleRename.
			await store.handleOutputRename(
				'rec.wav.markers.json',
				'x.markers.json',
			);
			// A rename of a path no sidecar records must not rewrite anything.
			await store.handleOutputRename('unrelated.md', 'elsewhere.md');

			expect(files.get('rec.wav.markers.json')).toBe(before);
		});
	});

	describe('snapshot isolation', () => {
		it('hands out marker snapshots the caller cannot mutate the cache through', async () => {
			const { app } = makeApp();
			const store = new RecordingSidecarStore(app);
			await store.setMarkers('rec.wav', [marker('a', 1)]);

			const leaked = await store.getMarkers('rec.wav');
			leaked.push(marker('evil', 99));
			at(leaked, 0).label = 'tampered';

			const clean = await store.getMarkers('rec.wav');
			expect(clean).toEqual([marker('a', 1)]);
		});

		it('hands out transcript snapshots the caller cannot mutate the cache through', async () => {
			const { app } = makeApp();
			const store = new RecordingSidecarStore(app);
			await store.setSpeakers('rec.wav', [
				{ label: 'Speaker 1', name: 'Alex' },
			]);

			const leaked = await store.getTranscript('rec.wav');
			at(leaked.speakers, 0).name = 'tampered';
			leaked.speakers.push({ label: 'Injected' });

			const clean = await store.getTranscript('rec.wav');
			expect(clean.speakers).toEqual([
				{ label: 'Speaker 1', name: 'Alex' },
			]);
		});

		it('copies its inputs, so later caller-side mutation changes nothing', async () => {
			const { app } = makeApp();
			const store = new RecordingSidecarStore(app);
			const output = noteOutput('a.md');
			await store.recordNoteOutput('rec.wav', output);
			output.path = 'tampered.md';
			output.templates.speakerFormat = 'tampered';

			const section = await store.getTranscript('rec.wav');
			expect(section.noteOutputs[0]?.path).toBe('a.md');
			expect(section.noteOutputs[0]?.templates.speakerFormat).toBe(
				'**{speaker}**',
			);
		});
	});

	describe('updateMarkers', () => {
		it('merges concurrent updates instead of losing one', async () => {
			const { app } = makeApp();
			const store = new RecordingSidecarStore(app);
			// The classic lost-update interleaving: both writers start from the
			// same state; with get-merge-set one append would vanish.
			await Promise.all([
				store.updateMarkers('rec.wav', (existing) => [
					...existing,
					marker('a', 1),
				]),
				store.updateMarkers('rec.wav', (existing) => [
					...existing,
					marker('b', 2),
				]),
			]);
			const markers = await store.getMarkers('rec.wav');
			expect(markers.map((m) => m.id).sort()).toEqual(['a', 'b']);
		});

		it('returns the merged snapshot the update produced', async () => {
			const { app } = makeApp();
			const store = new RecordingSidecarStore(app);
			await store.setMarkers('rec.wav', [marker('a', 1)]);
			const result = await store.updateMarkers('rec.wav', (existing) => [
				...existing,
				marker('b', 2),
			]);
			expect(result.map((m) => m.id)).toEqual(['a', 'b']);
		});
	});

	describe('corrupt sidecar protection', () => {
		it('flags the path corrupt and refuses to overwrite the file', async () => {
			const { app, files } = makeApp();
			files.set('rec.wav.markers.json', 'not json');
			const warn = jest
				.spyOn(console, 'warn')
				.mockImplementation(() => undefined);
			const store = new RecordingSidecarStore(app);

			expect(await store.getMarkers('rec.wav')).toEqual([]);
			expect(store.isSidecarCorrupt('rec.wav')).toBe(true);
			expect(store.isSidecarCorrupt('other.wav')).toBe(false);

			// The write is refused loudly: the caller gets a rejection (so it
			// can never present unsaved state as saved) and the possibly
			// intact file survives.
			await expect(
				store.setSpeakers('rec.wav', [{ label: 'Speaker 1' }]),
			).rejects.toThrow('could not be read');
			await expect(
				store.updateMarkers('rec.wav', (existing) => [
					...existing,
					marker('a', 1),
				]),
			).rejects.toThrow('could not be read');
			expect(files.get('rec.wav.markers.json')).toBe('not json');
			warn.mockRestore();
		});

		it('recovers once the file is readable again', async () => {
			const { app, files } = makeApp();
			files.set('rec.wav.markers.json', 'not json');
			const warn = jest
				.spyOn(console, 'warn')
				.mockImplementation(() => undefined);
			const store = new RecordingSidecarStore(app);
			await store.getMarkers('rec.wav');
			expect(store.isSidecarCorrupt('rec.wav')).toBe(true);

			// The user restored the file; nothing was cached for the corrupt
			// path, so the next read sees the fix and lifts the write block.
			files.set(
				'rec.wav.markers.json',
				JSON.stringify({ version: 2, markers: [marker('a', 1)] }),
			);
			expect(await store.getMarkers('rec.wav')).toEqual([marker('a', 1)]);
			expect(store.isSidecarCorrupt('rec.wav')).toBe(false);

			await store.setSpeakers('rec.wav', [{ label: 'Speaker 1' }]);
			expect(files.get('rec.wav.markers.json')).toContain('Speaker 1');
			warn.mockRestore();
		});
	});

	describe('commitRename atomicity', () => {
		it('persists the roster and the history entry in one write', async () => {
			const { app, files } = makeApp();
			const writeSpy = jest.spyOn(app.vault.adapter, 'write');
			const store = new RecordingSidecarStore(app);

			await store.commitRename(
				'rec.wav',
				[{ label: 'Speaker 1', name: 'Alex' }],
				{ 'Speaker 1': 'Alex' },
			);

			// One mutation, one file write: a failure can never persist the
			// roster without its history entry or vice versa.
			expect(writeSpy).toHaveBeenCalledTimes(1);
			const written = rawSidecar(files);
			const transcript = written.transcript as {
				speakers: unknown;
				history: { names: unknown }[];
			};
			expect(transcript.speakers).toEqual([
				{ label: 'Speaker 1', name: 'Alex' },
			]);
			expect(transcript.history.map((entry) => entry.names)).toEqual([
				{ 'Speaker 1': 'Alex' },
			]);
			writeSpy.mockRestore();
		});
	});

	describe('corrupt-flag/cache invariant', () => {
		it('adopts a concurrently cached document instead of flagging corrupt', async () => {
			// Interleave two real loads: the first read resolves fine, the
			// second read (started before the first cached) throws. The
			// failing load must return the winner's document, not flag.
			const { app } = makeApp();
			const reads: Array<() => void> = [];
			let calls = 0;
			app.vault.adapter.exists = () => Promise.resolve(true);
			app.vault.adapter.read = jest.fn(
				() =>
					new Promise<string>((resolve, reject) => {
						const index = calls++;
						reads.push(() => {
							if (index === 1) {
								reject(new Error('transient I/O'));
							} else {
								resolve(
									JSON.stringify({
										version: 2,
										markers: [marker('a', 1)],
									}),
								);
							}
						});
					}),
			) as typeof app.vault.adapter.read;
			const store = new RecordingSidecarStore(app);

			const loadA = store.getMarkers('rec.wav');
			const loadB = store.getMarkers('rec.wav');
			// Drain microtasks until both loads sit inside their read().
			for (let i = 0; i < 100 && reads.length < 2; i++) {
				await Promise.resolve();
			}
			expect(reads).toHaveLength(2);
			// A resolves first and caches; B then fails its read.
			reads[0]?.();
			await loadA;
			reads[1]?.();
			const fromB = await loadB;

			expect(fromB.map((m) => m.id)).toEqual(['a']);
			expect(store.isSidecarCorrupt('rec.wav')).toBe(false);
			// Writes keep working - nothing froze.
			await store.setMarkers('rec.wav', [marker('b', 2)]);
			expect(
				(await store.getMarkers('rec.wav')).map((m) => m.id),
			).toEqual(['b']);
		});

		it('does not strand the corrupt flag on a renamed path holding a cached document', async () => {
			// The recording is cached valid, its file corrupts on disk, a
			// mutation is queued, then the rename lands. The queued
			// mutation's load of the old path fails and flags it; the rename
			// task's second cache move must not carry that flag onto the new
			// path, which holds the valid cached document.
			const { app, files } = makeApp();
			const store = new RecordingSidecarStore(app);
			await store.setSpeakers('rec.wav', [{ label: 'Speaker 1' }]);

			// Corrupt the file on disk behind the cache.
			files.set('rec.wav.markers.json', 'not json');
			const warn = jest
				.spyOn(console, 'warn')
				.mockImplementation(() => undefined);

			// moveCacheEntry (sync, inside handleRename) relocates the cache
			// before the queued mutation runs; the mutation then re-reads the
			// old path from disk and fails.
			const rename = store.handleRename('rec.wav', 'renamed.wav');
			const mutation = store
				.setSpeakers('rec.wav', [{ label: 'Speaker 2' }])
				.catch(() => undefined);
			await Promise.all([rename, mutation]);

			expect(store.isSidecarCorrupt('renamed.wav')).toBe(false);
			// The renamed recording accepts writes; nothing is frozen.
			await store.setSpeakers('renamed.wav', [
				{ label: 'Speaker 1', name: 'Alex' },
			]);
			expect(
				(await store.getTranscript('renamed.wav')).speakers[0]?.name,
			).toBe('Alex');
			warn.mockRestore();
		});

		it('clears a corrupt flag re-added by a mutation racing a delete', async () => {
			const { app, files } = makeApp();
			const store = new RecordingSidecarStore(app);
			await store.setSpeakers('rec.wav', [{ label: 'Speaker 1' }]);
			files.set('rec.wav.markers.json', 'not json');
			const warn = jest
				.spyOn(console, 'warn')
				.mockImplementation(() => undefined);

			const removal = store.handleDelete('rec.wav');
			const mutation = store
				.setSpeakers('rec.wav', [{ label: 'Speaker 2' }])
				.catch(() => undefined);
			await Promise.all([removal, mutation]);

			// The queued task purges the flag the racing mutation re-added,
			// so a recording re-created at this path starts clean.
			expect(store.isSidecarCorrupt('rec.wav')).toBe(false);
			warn.mockRestore();
		});
	});

	describe('provenance emptiness', () => {
		it('deletes a sidecar whose only remaining data is provenance', async () => {
			const { app, files } = makeApp();
			const store = new RecordingSidecarStore(app);
			await store.setMarkers('rec.wav', [marker('a', 1)]);
			await store.recordProvenance('rec.wav', {
				language: 'en',
				createdAt: 't',
			});
			expect(files.has('rec.wav.markers.json')).toBe(true);

			// Deleting the last marker leaves only provenance, which
			// describes nothing once every substantive list is empty - the
			// file must go instead of lingering forever after a
			// transcription.
			await store.setMarkers('rec.wav', []);
			expect(files.has('rec.wav.markers.json')).toBe(false);
		});
	});

	describe('output-rename scan bounds', () => {
		it('never touches the disk for a rename that cannot be a recorded output', async () => {
			const { app, files } = makeApp();
			const seed = new RecordingSidecarStore(app);
			await seed.recordNoteOutput('rec.wav', noteOutput('meeting.md'));

			const store = new RecordingSidecarStore(app);
			const readSpy = jest.spyOn(app.vault.adapter, 'read');
			await store.handleOutputRename('photo.png', 'photo2.png');
			await store.handleOutputRename('doc.pdf', 'doc2.pdf');

			expect(readSpy).not.toHaveBeenCalled();
			expect(files.get('rec.wav.markers.json')).toContain('meeting.md');
			readSpy.mockRestore();
		});

		it('reads each on-disk sidecar at most once across repeated renames', async () => {
			const { app } = makeApp();
			const seed = new RecordingSidecarStore(app);
			await seed.recordNoteOutput('rec.wav', noteOutput('a.md'));
			await seed.recordNoteOutput('other.wav', noteOutput('b.md'));

			const store = new RecordingSidecarStore(app);
			const readSpy = jest.spyOn(app.vault.adapter, 'read');
			await store.handleOutputRename('a.md', 'a2.md');
			const readsAfterFirst = readSpy.mock.calls.length;
			expect(readsAfterFirst).toBeGreaterThan(0);

			// The first scan cached every sidecar it parsed; later renames
			// resolve from the cache without re-reading the vault.
			await store.handleOutputRename('b.md', 'b2.md');
			await store.handleOutputRename('a2.md', 'a3.md');
			expect(readSpy.mock.calls).toHaveLength(readsAfterFirst);
			readSpy.mockRestore();
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
			const app = partialApp({
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
			});
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
				store.commitRename('rec.wav', [], { 'Speaker 1': 'Alex' }),
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
