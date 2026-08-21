/**
 * Unit tests for the session-scoped marker coordinator.
 *
 * Markers dropped during a recording live only in this buffer until the
 * session finalizes, so the interesting behaviour is all about timing: the
 * naming modal can still be open when the session stops, and the edit or
 * the cancel it produces then has to reach a marker that is already on
 * disk rather than a draft that no longer exists.
 * @module tests/unit/RecordingMarkerCoordinator.test
 */

import { RecordingMarkerCoordinator } from 'src/recording/RecordingMarkerCoordinator';
import { MARKER_KIND, type PlayerMarker } from 'src/markers/markerModel';
import type { RecordingSaveResult } from 'src/types';
import { at } from '../helpers/assertions';
import { makeStatefulMarkerStore } from '../helpers/recordingManagerTestKit';
import { noticeMessages } from '../mocks/obsidian';

/** One finished single-track recording, saved as one file. */
const ONE_FILE: RecordingSaveResult = {
	audioPaths: ['Audio/rec.webm'],
	notePath: null,
	trackFiles: [{ trackIndex: 0, files: ['Audio/rec.webm'] }],
};

/** Two tracks of the same session, each saved as its own file. */
const TWO_TRACKS: RecordingSaveResult = {
	audioPaths: ['Audio/rec-Track1.webm', 'Audio/rec-Track2.webm'],
	notePath: null,
	trackFiles: [
		{ trackIndex: 0, files: ['Audio/rec-Track1.webm'] },
		{ trackIndex: 1, files: ['Audio/rec-Track2.webm'] },
	],
};

/**
 * A coordinator over a sidecar store that remembers what was written.
 * @returns The coordinator, the store behind it, and its read helper
 */
function createSut(): {
	coordinator: RecordingMarkerCoordinator;
	read: (path: string) => PlayerMarker[];
	store: ReturnType<typeof makeStatefulMarkerStore>;
} {
	const store = makeStatefulMarkerStore();
	const coordinator = new RecordingMarkerCoordinator(store.store);
	coordinator.beginSession();
	return { coordinator, read: store.read, store };
}

describe('capturing markers during a session', () => {
	it('numbers each new marker after the ones already dropped', async () => {
		const { coordinator, read } = createSut();

		coordinator.captureDraft({ partOrdinal: 1, offsetSeconds: 5 });
		coordinator.captureDraft({ partOrdinal: 1, offsetSeconds: 9 });
		await coordinator.persistMarkers(ONE_FILE);

		expect(read('Audio/rec.webm').map((marker) => marker.label)).toEqual([
			'Marker 1',
			'Marker 2',
		]);
	});

	// The default a still-open modal offers must not count the very draft it
	// is naming, or every marker would be numbered one too high.
	it('offers a default that does not count the draft being named', () => {
		const { coordinator } = createSut();

		const handle = coordinator.captureDraft({
			partOrdinal: 1,
			offsetSeconds: 5,
		});

		expect(handle.defaultLabelFor(MARKER_KIND.bookmark)).toBe('Marker 1');
	});

	// The command that dropped the marker fixes its kind; the modal only
	// remembers the kind when nothing fixed it.
	it('preselects the kind the command asked for', () => {
		const { coordinator } = createSut();

		const handle = coordinator.captureDraft(
			{ partOrdinal: 1, offsetSeconds: 5 },
			MARKER_KIND.chapter,
		);

		expect(handle.initialKind).toBe(MARKER_KIND.chapter);
	});

	it('preselects the kind last chosen when the command fixes none', () => {
		const { coordinator } = createSut();

		coordinator
			.captureDraft({ partOrdinal: 1, offsetSeconds: 5 })
			.commit('', MARKER_KIND.chapter);

		expect(
			coordinator.captureDraft({ partOrdinal: 1, offsetSeconds: 9 })
				.initialKind,
		).toBe(MARKER_KIND.chapter);
	});

	it('falls back to the numbered default when the name is left blank', async () => {
		const { coordinator, read } = createSut();

		coordinator
			.captureDraft({ partOrdinal: 1, offsetSeconds: 5 })
			.commit('   ', MARKER_KIND.bookmark);
		await coordinator.persistMarkers(ONE_FILE);

		expect(at(read('Audio/rec.webm'), 0).label).toBe('Marker 1');
	});

	it('keeps the name the user typed, trimmed', async () => {
		const { coordinator, read } = createSut();

		coordinator
			.captureDraft({ partOrdinal: 1, offsetSeconds: 5 })
			.commit('  The good bit  ', MARKER_KIND.bookmark);
		await coordinator.persistMarkers(ONE_FILE);

		expect(at(read('Audio/rec.webm'), 0).label).toBe('The good bit');
	});

	it('drops a cancelled draft before anything is written', async () => {
		const { coordinator, read } = createSut();

		coordinator.captureDraft({ partOrdinal: 1, offsetSeconds: 5 }).cancel();
		await coordinator.persistMarkers(ONE_FILE);

		expect(read('Audio/rec.webm')).toEqual([]);
	});

	it('starts a new session with none of the last one buffered', async () => {
		const { coordinator, read } = createSut();

		coordinator.captureDraft({ partOrdinal: 1, offsetSeconds: 5 });
		coordinator.beginSession();
		await coordinator.persistMarkers(ONE_FILE);

		expect(read('Audio/rec.webm')).toEqual([]);
	});
});

describe('writing the session markers out at stop', () => {
	it('writes nothing at all when no marker was dropped', async () => {
		const { coordinator, store } = createSut();

		await coordinator.persistMarkers(ONE_FILE);

		expect(store.writes).toEqual([]);
	});

	// The tracks of one session share a timeline, so a marker belongs to
	// every track's file, not just the first.
	it('writes each marker into every track of the session', async () => {
		const { coordinator, read } = createSut();

		coordinator
			.captureDraft({ partOrdinal: 1, offsetSeconds: 12 })
			.commit('Decision', MARKER_KIND.chapter);
		await coordinator.persistMarkers(TWO_TRACKS);

		for (const path of TWO_TRACKS.audioPaths) {
			expect(at(read(path), 0)).toEqual(
				expect.objectContaining({ time: 12, label: 'Decision' }),
			);
		}
	});

	it('falls back to the saved paths when the result names no tracks', async () => {
		const { coordinator, read } = createSut();

		coordinator
			.captureDraft({ partOrdinal: 1, offsetSeconds: 3 })
			.commit('Note', MARKER_KIND.bookmark);
		await coordinator.persistMarkers({
			audioPaths: ['Audio/rec.webm'],
			notePath: null,
		});

		expect(at(read('Audio/rec.webm'), 0).label).toBe('Note');
	});

	// The markers of a session exist nowhere else, so a failed write is
	// told to the user rather than only logged.
	it('says out loud how many files lost their markers', async () => {
		const store = makeStatefulMarkerStore();
		const error = jest.spyOn(console, 'error').mockImplementation();
		jest.mocked(store.store.updateMarkers).mockRejectedValue(
			new Error('the vault is read-only'),
		);
		const coordinator = new RecordingMarkerCoordinator(store.store);
		coordinator.beginSession();

		coordinator
			.captureDraft({ partOrdinal: 1, offsetSeconds: 3 })
			.commit('Note', MARKER_KIND.bookmark);
		await coordinator.persistMarkers(TWO_TRACKS);

		expect(noticeMessages()).toContain(
			'Markers of this recording could not be saved for 2 file(s); ' +
				'see the developer console for details.',
		);
		expect(error).toHaveBeenCalledTimes(2);
	});
});

// The naming modal is not modal to the recording: the user can stop the
// session with it still open. The draft has already been written by then,
// so the commit and the cancel have to reach the file rather than a buffer
// that no longer holds it.
describe('a naming modal still open when the session ended', () => {
	/**
	 * A marker already written to disk, whose sidecar then starts refusing
	 * every write - the state both late-edit failures are reported from.
	 * @returns The handle the modal still holds, and the console spy
	 */
	async function persistedThenReadOnly(): Promise<{
		handle: ReturnType<RecordingMarkerCoordinator['captureDraft']>;
		error: jest.SpyInstance;
	}> {
		const store = makeStatefulMarkerStore();
		const error = jest.spyOn(console, 'error').mockImplementation();
		const coordinator = new RecordingMarkerCoordinator(store.store);
		coordinator.beginSession();
		const handle = coordinator.captureDraft({
			partOrdinal: 1,
			offsetSeconds: 5,
		});
		await coordinator.persistMarkers(ONE_FILE);
		jest.mocked(store.store.updateMarkers).mockRejectedValue(
			new Error('the vault is read-only'),
		);
		return { handle, error };
	}

	it('pushes the typed name onto the marker already on disk', async () => {
		const { coordinator, read } = createSut();
		const handle = coordinator.captureDraft({
			partOrdinal: 1,
			offsetSeconds: 5,
		});

		await coordinator.persistMarkers(ONE_FILE);
		handle.commit('Named after the fact', MARKER_KIND.chapter);
		await Promise.resolve();

		expect(at(read('Audio/rec.webm'), 0)).toEqual(
			expect.objectContaining({
				label: 'Named after the fact',
				kind: MARKER_KIND.chapter,
			}),
		);
	});

	it('reaches every track the marker was written to', async () => {
		const { coordinator, read } = createSut();
		const handle = coordinator.captureDraft({
			partOrdinal: 1,
			offsetSeconds: 5,
		});

		await coordinator.persistMarkers(TWO_TRACKS);
		handle.commit('Late name', MARKER_KIND.bookmark);
		await Promise.resolve();

		for (const path of TWO_TRACKS.audioPaths) {
			expect(at(read(path), 0).label).toBe('Late name');
		}
	});

	it('removes the marker from disk when the modal is cancelled', async () => {
		const { coordinator, read } = createSut();
		const handle = coordinator.captureDraft({
			partOrdinal: 1,
			offsetSeconds: 5,
		});

		await coordinator.persistMarkers(ONE_FILE);
		handle.cancel();
		await Promise.resolve();

		expect(read('Audio/rec.webm')).toEqual([]);
	});

	it('leaves the other markers of the session alone when one is cancelled', async () => {
		const { coordinator, read } = createSut();
		coordinator
			.captureDraft({ partOrdinal: 1, offsetSeconds: 2 })
			.commit('Kept', MARKER_KIND.bookmark);
		const handle = coordinator.captureDraft({
			partOrdinal: 1,
			offsetSeconds: 5,
		});

		await coordinator.persistMarkers(ONE_FILE);
		handle.cancel();
		await Promise.resolve();

		expect(read('Audio/rec.webm')).toHaveLength(1);
		expect(at(read('Audio/rec.webm'), 0).label).toBe('Kept');
	});

	it('leaves the file alone for a draft that was never written', async () => {
		const { coordinator, store } = createSut();
		const handle = coordinator.captureDraft({
			partOrdinal: 1,
			offsetSeconds: 5,
		});

		handle.commit('Named while recording', MARKER_KIND.bookmark);
		await Promise.resolve();

		expect(store.writes).toEqual([]);
	});

	it('reports a sidecar that refused the edit', async () => {
		const { handle, error } = await persistedThenReadOnly();

		handle.commit('Late name', MARKER_KIND.bookmark);
		await Promise.resolve();

		expect(error).toHaveBeenCalledWith(
			expect.stringContaining('Failed to update persisted marker'),
			expect.any(Error),
		);
	});

	it('reports a sidecar that refused the removal', async () => {
		const { handle, error } = await persistedThenReadOnly();

		handle.cancel();
		await Promise.resolve();

		expect(error).toHaveBeenCalledWith(
			expect.stringContaining('Failed to remove persisted marker'),
			expect.any(Error),
		);
	});
});
