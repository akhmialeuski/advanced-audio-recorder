/**
 * Tests for the player's marker controller: optimistic edits persisted
 * through the store's atomic update, external merges re-rendering the view,
 * and - the corrupt-sidecar case - a refused write being surfaced and rolled
 * back instead of masquerading as an empty marker list or a successful add.
 */

import { Notice } from 'obsidian';
import { PlayerMarkerController } from 'src/player/PlayerMarkerController';
import type { PlayerMarkerHost } from 'src/player/PlayerMarkerController';
import type { RecordingSidecarStore } from 'src/sidecar/RecordingSidecarStore';
import { MARKER_KIND, type PlayerMarker } from 'src/markers/markerModel';

jest.mock('obsidian', () => ({
	Notice: jest.fn(),
}));

const noticeMock = Notice as unknown as jest.Mock;

/** A host double recording render calls; never unloaded unless flipped. */
function makeHost(): PlayerMarkerHost & {
	renderMarkers: jest.Mock;
	refreshTicks: jest.Mock;
	notifyOthers: jest.Mock;
	unloaded: boolean;
} {
	const host = {
		unloaded: false,
		isUnloaded: (): boolean => host.unloaded,
		renderMarkers: jest.fn(),
		refreshTicks: jest.fn(),
		notifyOthers: jest.fn(),
	};
	return host;
}

/** An in-memory store double honoring the real updateMarkers contract. */
function makeStore(initial: PlayerMarker[] = []): {
	store: RecordingSidecarStore;
	read: () => PlayerMarker[];
} {
	let data = [...initial];
	const store = {
		getMarkers: jest.fn(() => Promise.resolve([...data])),
		updateMarkers: jest.fn(
			(
				_path: string,
				change: (
					existing: readonly PlayerMarker[],
				) => readonly PlayerMarker[],
			) => {
				data = [...change(data)];
				return Promise.resolve([...data]);
			},
		),
	} as unknown as RecordingSidecarStore;
	return { store, read: () => data };
}

/** A store double whose every write is refused (corrupt sidecar). */
function makeCorruptStore(): RecordingSidecarStore {
	return {
		getMarkers: jest.fn(() => Promise.resolve([])),
		updateMarkers: jest.fn(() =>
			Promise.reject(
				new Error(
					'The sidecar file rec.wav.markers.json exists but could not be read',
				),
			),
		),
	} as unknown as RecordingSidecarStore;
}

beforeEach(() => {
	noticeMock.mockClear();
});

describe('PlayerMarkerController', () => {
	it('persists an added marker and announces it only after the write', async () => {
		const { store, read } = makeStore();
		const host = makeHost();
		const controller = new PlayerMarkerController(store, 'rec.wav', host);

		await controller.addAt(12, MARKER_KIND.bookmark);

		expect(read()).toHaveLength(1);
		expect(read()[0]).toMatchObject({ time: 12, kind: 'bookmark' });
		expect(noticeMock).toHaveBeenCalledWith(
			expect.stringContaining('added at'),
		);
		expect(host.notifyOthers).toHaveBeenCalled();
	});

	it('re-renders when the store merged a concurrent external marker', async () => {
		// Another writer (auto chapters) landed a marker between this
		// player's read and write; the merged result must reach the view.
		const external: PlayerMarker = {
			id: 'auto-chapter-1',
			time: 60,
			label: 'Intro',
			kind: 'chapter',
		};
		const { store } = makeStore([external]);
		const host = makeHost();
		const controller = new PlayerMarkerController(store, 'rec.wav', host);

		await controller.addAt(12, MARKER_KIND.bookmark);

		expect(controller.all.map((m) => m.id)).toContain('auto-chapter-1');
		expect(host.renderMarkers).toHaveBeenCalled();
	});

	it('rolls back and reports a refused write instead of showing a phantom marker', async () => {
		const store = makeCorruptStore();
		const host = makeHost();
		const controller = new PlayerMarkerController(store, 'rec.wav', host);
		const warn = jest
			.spyOn(console, 'warn')
			.mockImplementation(() => undefined);

		await controller.addAt(12, MARKER_KIND.bookmark);

		// The optimistic marker was rolled back to the store's authoritative
		// state: it was never saved, so it must not stay on screen.
		expect(controller.all).toHaveLength(0);
		// The failure is said out loud, and no success notice lies about it.
		expect(noticeMock).toHaveBeenCalledWith(
			expect.stringContaining('Markers could not be saved'),
		);
		expect(noticeMock).not.toHaveBeenCalledWith(
			expect.stringContaining('added at'),
		);
		warn.mockRestore();
	});

	it('does not wipe the list when a removal write is refused', async () => {
		// The regression this guards: a refused write must never surface as
		// "the store now holds zero markers".
		const kept: PlayerMarker = {
			id: 'keep',
			time: 5,
			label: 'Keep',
			kind: 'bookmark',
		};
		const store = {
			getMarkers: jest.fn(() => Promise.resolve([kept])),
			updateMarkers: jest.fn(() =>
				Promise.reject(new Error('could not be read')),
			),
		} as unknown as RecordingSidecarStore;
		const host = makeHost();
		const controller = new PlayerMarkerController(store, 'rec.wav', host);
		const warn = jest
			.spyOn(console, 'warn')
			.mockImplementation(() => undefined);
		await controller.load();

		await controller.remove('keep');

		// The removal was refused, so the marker is restored from the store.
		expect(controller.all.map((m) => m.id)).toEqual(['keep']);
		warn.mockRestore();
	});
});
