/**
 * Tests for the pure marker / chapter data model.
 */

import {
	activeMarkerIndex,
	addMarker,
	chapters,
	markerRows,
	nextChapterTime,
	parseMarkers,
	previousChapterTime,
	removeMarker,
	serializeMarkers,
	sortMarkers,
	updateMarker,
	type PlayerMarker,
} from 'src/markers/markerModel';

function marker(
	id: string,
	time: number,
	kind: PlayerMarker['kind'] = 'bookmark',
	label = id,
): PlayerMarker {
	return { id, time, label, kind };
}

describe('sortMarkers / addMarker', () => {
	it('keeps markers sorted by time', () => {
		const list = addMarker(addMarker([], marker('b', 30)), marker('a', 10));
		expect(list.map((m) => m.id)).toEqual(['a', 'b']);
	});

	it('does not mutate the input array', () => {
		const input = [marker('a', 10)];
		const result = addMarker(input, marker('b', 5));
		expect(input).toHaveLength(1);
		expect(result).toHaveLength(2);
	});
});

describe('removeMarker / updateMarker', () => {
	it('removes by id', () => {
		const list = [marker('a', 1), marker('b', 2)];
		expect(removeMarker(list, 'a').map((m) => m.id)).toEqual(['b']);
	});

	it('updates a label without reordering equal-kind markers', () => {
		const list = [marker('a', 1), marker('b', 2)];
		const updated = updateMarker(list, 'a', { label: 'renamed' });
		expect(updated.find((m) => m.id === 'a')?.label).toBe('renamed');
	});

	it('re-sorts when the time changes', () => {
		const list = [marker('a', 1), marker('b', 2)];
		const updated = updateMarker(list, 'a', { time: 5 });
		expect(updated.map((m) => m.id)).toEqual(['b', 'a']);
	});
});

describe('chapters', () => {
	it('returns only the chapters, time-sorted', () => {
		const list = [
			marker('c2', 40, 'chapter'),
			marker('b2', 30, 'bookmark'),
			marker('c1', 10, 'chapter'),
			marker('b1', 5, 'bookmark'),
		];
		expect(chapters(list).map((m) => m.id)).toEqual(['c1', 'c2']);
	});
});

describe('chapter navigation', () => {
	const sorted = sortMarkers([
		marker('c1', 0, 'chapter'),
		marker('c2', 60, 'chapter'),
		marker('c3', 120, 'chapter'),
	]);

	it('finds the next chapter time', () => {
		expect(nextChapterTime(sorted, 0)).toBe(60);
		expect(nextChapterTime(sorted, 70)).toBe(120);
		expect(nextChapterTime(sorted, 120)).toBeNull();
	});

	it('finds the previous chapter time with a lead-in window', () => {
		// Just after c2 (60), within the lead-in: jumps back to c1
		expect(previousChapterTime(sorted, 61)).toBe(0);
		// Well into c3 (120), past the lead-in: restarts the current
		// chapter at 120
		expect(previousChapterTime(sorted, 130)).toBe(120);
		// Within the lead-in of c3: jumps to the previous chapter c2
		expect(previousChapterTime(sorted, 121)).toBe(60);
		// Before any boundary past the lead-in: null
		expect(previousChapterTime(sorted, 1)).toBeNull();
	});
});

describe('serializeMarkers / parseMarkers', () => {
	it('round-trips valid markers', () => {
		const list = [marker('a', 1, 'bookmark'), marker('c', 2, 'chapter')];
		expect(parseMarkers(serializeMarkers(list))).toEqual(sortMarkers(list));
	});

	it('drops malformed entries and non-arrays', () => {
		expect(parseMarkers('nope')).toEqual([]);
		expect(parseMarkers([{ time: 'x' }, null, 5])).toEqual([]);
		expect(parseMarkers([{ id: 'a', time: 10, kind: 'invalid' }])).toEqual(
			[],
		);
	});

	it('clamps negative times and defaults a missing label', () => {
		const parsed = parseMarkers([{ id: 'a', time: -5, kind: 'bookmark' }]);
		expect(parsed).toEqual([
			{ id: 'a', time: 0, label: '', kind: 'bookmark' },
		]);
	});
});

describe('markerModel - edge and negative cases', () => {
	it('sortMarkers is stable for equal times', () => {
		const list = [marker('a', 5), marker('b', 5), marker('c', 5)];
		expect(sortMarkers(list).map((m) => m.id)).toEqual(['a', 'b', 'c']);
	});

	it('addMarker keeps a single merged list sorted across kinds', () => {
		let list: PlayerMarker[] = [];
		list = addMarker(list, marker('c', 20, 'chapter'));
		list = addMarker(list, marker('b', 5, 'bookmark'));
		list = addMarker(list, marker('a', 1, 'chapter'));
		expect(list.map((m) => m.id)).toEqual(['a', 'b', 'c']);
	});

	it('removeMarker on a missing id returns the list unchanged', () => {
		const list = [marker('a', 1)];
		expect(removeMarker(list, 'missing')).toEqual(list);
	});

	it('updateMarker on a missing id is a no-op', () => {
		const list = [marker('a', 1)];
		expect(updateMarker(list, 'missing', { label: 'x' })).toEqual(list);
	});

	it('nextChapterTime returns null at or past the last chapter', () => {
		const sorted = sortMarkers([marker('c1', 10, 'chapter')]);
		expect(nextChapterTime(sorted, 10)).toBeNull();
		expect(nextChapterTime([], 0)).toBeNull();
	});

	it('previousChapterTime returns null before the first chapter', () => {
		const sorted = sortMarkers([marker('c1', 30, 'chapter')]);
		expect(previousChapterTime(sorted, 5)).toBeNull();
		expect(previousChapterTime([], 5)).toBeNull();
	});

	it('parseMarkers drops entries with a non-finite or missing time', () => {
		expect(
			parseMarkers([
				{ id: 'a', time: Number.NaN, kind: 'bookmark' },
				{ id: 'b', time: Number.POSITIVE_INFINITY, kind: 'chapter' },
				{ id: 'c', kind: 'bookmark' },
			]),
		).toEqual([]);
	});

	it('parseMarkers drops entries with a missing or non-string id', () => {
		expect(
			parseMarkers([
				{ time: 1, kind: 'bookmark' },
				{ id: 5, time: 1, kind: 'bookmark' },
			]),
		).toEqual([]);
	});

	it('parseMarkers coerces a non-string label to an empty string', () => {
		const parsed = parseMarkers([
			{ id: 'a', time: 1, kind: 'chapter', label: 42 },
		]);
		expect(parsed[0]?.label).toBe('');
	});

	it('parseMarkers keeps both kinds and rejects unknown kinds', () => {
		const parsed = parseMarkers([
			{ id: 'a', time: 1, kind: 'bookmark' },
			{ id: 'b', time: 2, kind: 'chapter' },
			{ id: 'c', time: 3, kind: 'segment' },
		]);
		expect(parsed.map((m) => m.id)).toEqual(['a', 'b']);
	});

	it('serializeMarkers strips unknown fields', () => {
		const list = [
			{ id: 'a', time: 1, label: 'A', kind: 'bookmark', extra: true },
		] as unknown as PlayerMarker[];
		expect(serializeMarkers(list)[0]).toEqual({
			id: 'a',
			time: 1,
			label: 'A',
			kind: 'bookmark',
		});
	});
});

describe('markerRows - single source for both render modes', () => {
	it('returns one list ordered by time regardless of kind', () => {
		const list = [
			marker('c', 30, 'chapter'),
			marker('b', 10, 'bookmark'),
			marker('a', 5, 'chapter'),
		];
		expect(markerRows(list, true).map((r) => r.id)).toEqual([
			'a',
			'b',
			'c',
		]);
		expect(markerRows(list, false).map((r) => r.id)).toEqual([
			'a',
			'b',
			'c',
		]);
	});

	it('shows the same markers in both modes, differing only by actions', () => {
		const list = [marker('a', 1, 'bookmark'), marker('b', 2, 'chapter')];
		const editable = markerRows(list, true);
		const readonly = markerRows(list, false);
		expect(editable.map((r) => r.id)).toEqual(readonly.map((r) => r.id));
		expect(editable[0]?.actions).toEqual(['jump', 'rename', 'delete']);
		expect(readonly[0]?.actions).toEqual(['jump']);
	});

	it('returns an empty list for no markers', () => {
		expect(markerRows([], true)).toEqual([]);
		expect(markerRows([], false)).toEqual([]);
	});

	it('carries each marker time, label, and kind', () => {
		const rows = markerRows([marker('a', 7, 'chapter', 'Intro')], false);
		expect(rows[0]).toEqual({
			id: 'a',
			time: 7,
			label: 'Intro',
			kind: 'chapter',
			actions: ['jump'],
			segmentSeconds: null,
		});
	});

	it('computes each segment length as the gap to the next marker', () => {
		const rows = markerRows(
			[marker('a', 0), marker('b', 5), marker('c', 12)],
			false,
		);
		expect(rows.map((r) => r.segmentSeconds)).toEqual([5, 7, null]);
	});

	it('uses the track duration for the last segment when provided', () => {
		const rows = markerRows([marker('a', 0), marker('b', 5)], false, 20);
		expect(rows.map((r) => r.segmentSeconds)).toEqual([5, 15]);
	});

	it('leaves the last segment null when the duration is before the marker', () => {
		const rows = markerRows([marker('a', 30)], false, 10);
		expect(rows[0]?.segmentSeconds).toBeNull();
	});
});

describe('activeMarkerIndex', () => {
	const sorted = sortMarkers([
		marker('a', 0),
		marker('b', 5),
		marker('c', 12),
	]);

	it('returns the last marker at or before the time', () => {
		expect(activeMarkerIndex(sorted, 0)).toBe(0);
		expect(activeMarkerIndex(sorted, 4)).toBe(0);
		expect(activeMarkerIndex(sorted, 5)).toBe(1);
		expect(activeMarkerIndex(sorted, 100)).toBe(2);
	});

	it('returns -1 before the first marker or for an empty list', () => {
		const later = sortMarkers([marker('a', 3)]);
		expect(activeMarkerIndex(later, 1)).toBe(-1);
		expect(activeMarkerIndex([], 5)).toBe(-1);
	});
});
