/**
 * Tests for the shared marker factory: default label numbering and id
 * generation reused by both the player and recording-time marker capture.
 * @module tests/unit/markerFactory.test
 */

import {
	defaultMarkerLabel,
	generateMarkerId,
} from 'src/markers/markerFactory';
import { MARKER_KIND, type MarkerKind } from 'src/markers/markerModel';

const kinds = (list: MarkerKind[]): { kind: MarkerKind }[] =>
	list.map((kind) => ({ kind }));

describe('defaultMarkerLabel', () => {
	it('numbers from 1 on an empty list', () => {
		expect(defaultMarkerLabel([], MARKER_KIND.bookmark)).toBe('Marker 1');
		expect(defaultMarkerLabel([], MARKER_KIND.chapter)).toBe('Chapter 1');
	});

	it('counts only markers of the same kind', () => {
		const markers = kinds([
			MARKER_KIND.bookmark,
			MARKER_KIND.chapter,
			MARKER_KIND.bookmark,
		]);
		expect(defaultMarkerLabel(markers, MARKER_KIND.bookmark)).toBe(
			'Marker 3',
		);
		expect(defaultMarkerLabel(markers, MARKER_KIND.chapter)).toBe(
			'Chapter 2',
		);
	});

	it('numbers bookmarks and chapters independently', () => {
		const markers = kinds([MARKER_KIND.chapter, MARKER_KIND.chapter]);
		expect(defaultMarkerLabel(markers, MARKER_KIND.bookmark)).toBe(
			'Marker 1',
		);
		expect(defaultMarkerLabel(markers, MARKER_KIND.chapter)).toBe(
			'Chapter 3',
		);
	});
});

describe('generateMarkerId', () => {
	it('returns a non-empty string', () => {
		const id = generateMarkerId();
		expect(typeof id).toBe('string');
		expect(id.length).toBeGreaterThan(0);
	});

	it('returns distinct ids on successive calls', () => {
		const ids = new Set([
			generateMarkerId(),
			generateMarkerId(),
			generateMarkerId(),
		]);
		expect(ids.size).toBe(3);
	});

	/** Replaces the window's crypto for one test; the spy restores it. */
	function withCrypto(value: unknown): void {
		jest.spyOn(
			activeWindow as Window & { crypto: Crypto },
			'crypto',
			'get',
		).mockReturnValue(value as Crypto);
	}

	it('uses the platform UUID when there is one', () => {
		withCrypto({
			randomUUID: () => 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
		});

		expect(generateMarkerId()).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
	});

	it.each([
		{ name: 'no crypto at all', crypto: undefined },
		{ name: 'a crypto without randomUUID', crypto: {} },
	])('still gives a distinct id with $name', ({ crypto }) => {
		// randomUUID needs a secure context, which an Obsidian pop-out window
		// on some platforms is not. A marker with no id is unaddressable.
		withCrypto(crypto);

		const ids = new Set([generateMarkerId(), generateMarkerId()]);

		expect(ids.size).toBe(2);
		for (const id of ids) {
			expect(id.length).toBeGreaterThan(0);
		}
	});
});
