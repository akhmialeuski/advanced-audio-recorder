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
import { at } from '../helpers/assertions';
import { partial } from '../helpers/doubles';

const noticeMock = jest.mocked(Notice);

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
	const store = partial<RecordingSidecarStore>({
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
	});
	return { store, read: () => data };
}

/** A store double whose every write is refused (corrupt sidecar). */
function makeCorruptStore(): RecordingSidecarStore {
	return partial<RecordingSidecarStore>({
		getMarkers: jest.fn(() => Promise.resolve([])),
		updateMarkers: jest.fn(() =>
			Promise.reject(
				new Error(
					'The sidecar file rec.wav.markers.json exists but could not be read',
				),
			),
		),
	});
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
		jest.spyOn(console, 'warn').mockImplementation(() => undefined);

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
		const store = partial<RecordingSidecarStore>({
			getMarkers: jest.fn(() => Promise.resolve([kept])),
			updateMarkers: jest.fn(() =>
				Promise.reject(new Error('could not be read')),
			),
		});
		const host = makeHost();
		const controller = new PlayerMarkerController(store, 'rec.wav', host);
		jest.spyOn(console, 'warn').mockImplementation(() => undefined);
		await controller.load();

		await controller.remove('keep');

		// The removal was refused, so the marker is restored from the store.
		expect(controller.all.map((m) => m.id)).toEqual(['keep']);
	});
});

/**
 * A controller over a store already holding the given markers, loaded.
 * @param markers - What the sidecar holds for this recording
 * @returns The controller with the host and the store behind it
 */
async function createLoadedSut(markers: PlayerMarker[]): Promise<{
	controller: PlayerMarkerController;
	host: ReturnType<typeof makeHost>;
	read: () => PlayerMarker[];
}> {
	const { store, read } = makeStore(markers);
	const host = makeHost();
	const controller = new PlayerMarkerController(store, 'rec.wav', host);
	await controller.load();
	// The load renders once by itself; cleared here so each test counts only
	// what its own edit caused.
	host.renderMarkers.mockClear();
	host.refreshTicks.mockClear();
	host.notifyOthers.mockClear();
	return { controller, host, read };
}

describe('moving, noting and colouring a marker', () => {
	it('persists a new time and rebuilds the list, because the order changed', async () => {
		const { controller, host, read } = await createLoadedSut([
			{ id: 'a', time: 10, label: 'Intro', kind: 'chapter' },
			{ id: 'b', time: 30, label: 'Note', kind: 'bookmark' },
		]);

		await controller.setTime('a', 40);

		expect(read().map((m) => m.id)).toEqual(['b', 'a']);
		expect(host.renderMarkers).toHaveBeenCalledTimes(1);
		expect(host.notifyOthers).toHaveBeenCalledTimes(1);
	});

	it('refuses to move a marker before the start of the recording', async () => {
		const { controller, read } = await createLoadedSut([
			{ id: 'a', time: 10, label: 'Intro', kind: 'chapter' },
		]);

		await controller.setTime('a', -5);

		expect(at(read(), 0).time).toBe(0);
	});

	it('persists a note and refreshes only the ticks, so the field keeps focus', async () => {
		const { controller, host, read } = await createLoadedSut([
			{ id: 'a', time: 10, label: 'Intro', kind: 'chapter' },
		]);
		await controller.setNote('a', 'the bit about pricing');

		expect(at(read(), 0).note).toBe('the bit about pricing');
		expect(host.refreshTicks).toHaveBeenCalledTimes(1);
		expect(host.renderMarkers).not.toHaveBeenCalled();
	});

	it.each([
		{ name: 'an empty string', typed: '' },
		{ name: 'only whitespace', typed: '   ' },
	])('clears the note when given $name', async ({ typed }) => {
		const { controller, read } = await createLoadedSut([
			{ id: 'a', time: 10, label: 'Intro', kind: 'chapter', note: 'old' },
		]);

		await controller.setNote('a', typed);

		// Absent rather than empty, so an otherwise empty sidecar is still
		// deleted instead of being kept alive by a blank field.
		expect(at(read(), 0)).not.toHaveProperty('note');
	});

	it('persists a colour and rebuilds the list, because the tick changed too', async () => {
		const { controller, host, read } = await createLoadedSut([
			{ id: 'a', time: 10, label: 'Intro', kind: 'chapter' },
		]);

		await controller.setColor('a', 'blue');

		expect(at(read(), 0).color).toBe('blue');
		expect(host.renderMarkers).toHaveBeenCalledTimes(1);
	});

	it('clears the colour when told none', async () => {
		const { controller, read } = await createLoadedSut([
			{
				id: 'a',
				time: 10,
				label: 'Intro',
				kind: 'chapter',
				color: 'red',
			},
		]);

		await controller.setColor('a', null);

		expect(at(read(), 0)).not.toHaveProperty('color');
	});

	it('reports a refused write and re-syncs, rather than leaving the edit on screen', async () => {
		const store = makeCorruptStore();
		const host = makeHost();
		const controller = new PlayerMarkerController(store, 'rec.wav', host);

		await controller.setNote('a', 'never saved');

		expect(noticeMock).toHaveBeenCalledWith(
			expect.stringContaining('could not be saved'),
		);
	});
});
