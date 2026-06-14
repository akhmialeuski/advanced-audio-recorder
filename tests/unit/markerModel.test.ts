/**
 * Tests for the pure marker / chapter data model.
 */

import {
	addMarker,
	bookmarks,
	chapterIndexAt,
	chapters,
	nextChapterTime,
	parseMarkers,
	previousChapterTime,
	removeMarker,
	serializeMarkers,
	sortMarkers,
	updateMarker,
	type PlayerMarker,
} from 'src/player/markers/markerModel';

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

describe('bookmarks / chapters', () => {
	it('partitions by kind, each time-sorted', () => {
		const list = [
			marker('c2', 40, 'chapter'),
			marker('b2', 30, 'bookmark'),
			marker('c1', 10, 'chapter'),
			marker('b1', 5, 'bookmark'),
		];
		expect(bookmarks(list).map((m) => m.id)).toEqual(['b1', 'b2']);
		expect(chapters(list).map((m) => m.id)).toEqual(['c1', 'c2']);
	});
});

describe('chapter navigation', () => {
	const sorted = sortMarkers([
		marker('c1', 0, 'chapter'),
		marker('c2', 60, 'chapter'),
		marker('c3', 120, 'chapter'),
	]);

	it('finds the current chapter index', () => {
		expect(chapterIndexAt(sorted, 0)).toBe(0);
		expect(chapterIndexAt(sorted, 70)).toBe(1);
		expect(chapterIndexAt(sorted, 130)).toBe(2);
		expect(chapterIndexAt([], 5)).toBe(-1);
	});

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
