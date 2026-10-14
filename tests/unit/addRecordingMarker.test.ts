/**
 * Tests for adding one marker to a recording from outside any player: the
 * label it gets, where it lands, and that it joins the markers already there.
 * @module tests/unit/addRecordingMarker.test
 */

import { addRecordingMarker } from 'src/markers/addRecordingMarker';
import type { PlayerMarker } from 'src/markers/markerModel';
import { makeMarkerStore } from '../helpers/playbackHarness';

/** A store holding the given markers for the recording. */
async function storeWith(
	markers: PlayerMarker[],
): Promise<ReturnType<typeof makeMarkerStore>> {
	const store = makeMarkerStore();
	await store.updateMarkers('rec.webm', () => markers);
	return store;
}

const chapter: PlayerMarker = {
	id: 'c1',
	time: 10,
	label: 'Chapter 1',
	kind: 'chapter',
};

describe('adding a marker to a recording', () => {
	it('numbers its default label after the markers of its kind', async () => {
		const store = await storeWith([chapter]);

		const added = await addRecordingMarker(
			store,
			'rec.webm',
			42,
			'chapter',
			null,
		);

		expect(added).toEqual(
			expect.objectContaining({
				label: 'Chapter 2',
				time: 42,
				kind: 'chapter',
			}),
		);
	});

	it('keeps the label it was given', async () => {
		const store = await storeWith([]);

		const added = await addRecordingMarker(
			store,
			'rec.webm',
			5,
			'bookmark',
			'Question',
		);

		expect(added.label).toBe('Question');
	});

	it('writes it beside the markers already there, in time order', async () => {
		const store = await storeWith([chapter]);

		await addRecordingMarker(store, 'rec.webm', 3, 'bookmark', null);

		await expect(store.getMarkers('rec.webm')).resolves.toEqual([
			expect.objectContaining({ time: 3, kind: 'bookmark' }),
			chapter,
		]);
	});

	it('lands a time before the start at the start', async () => {
		const store = await storeWith([]);

		const added = await addRecordingMarker(
			store,
			'rec.webm',
			-4,
			'bookmark',
			null,
		);

		expect(added.time).toBe(0);
	});

	it('fails when the sidecar refuses the write', async () => {
		const store = makeMarkerStore();
		jest.mocked(store.updateMarkers).mockRejectedValue(
			new Error('corrupt'),
		);

		await expect(
			addRecordingMarker(store, 'rec.webm', 1, 'bookmark', null),
		).rejects.toThrow('corrupt');
	});
});
