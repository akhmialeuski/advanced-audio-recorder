/**
 * Unit tests for the marker/chapter view extracted from the player. They
 * cover the rendering of the list and ticks, the delegated jump/delete/rename
 * handling, the active-segment highlight, and that a tick refresh after a
 * rename does not rebuild the list (so a focused rename input is preserved).
 */

import { App, Modal } from 'obsidian';
import { at } from '../helpers/assertions';
import { allEls, el } from '../helpers/dom';
import { MARKER } from '../helpers/selectors';
import {
	MarkerListView,
	type MarkerListCallbacks,
	type MarkerListHost,
} from 'src/player/views/MarkerListView';
import type { PlayerMarker } from 'src/markers/markerModel';

const MARKERS: PlayerMarker[] = [
	{ id: 'a', time: 10, label: 'Intro', kind: 'chapter' },
	{ id: 'b', time: 30, label: 'Note', kind: 'bookmark' },
];

/** Builds an Obsidian-extended container element. */
function extendedEl(): HTMLElement {
	return new Modal(new App()).contentEl.createDiv();
}

/** A host that attaches listeners directly, mirroring registerDomEvent. */
function makeHost(): MarkerListHost {
	return {
		register: () => {
			// No teardown needed in tests
		},
		registerDomEvent: (el, type, callback) => {
			el.addEventListener(type, callback as EventListener);
		},
	};
}

function makeCallbacks(): jest.Mocked<MarkerListCallbacks> {
	return {
		onJump: jest.fn(),
		onDelete: jest.fn(),
		onRename: jest.fn(),
		onAddAt: jest.fn(),
		timeAtClientX: jest.fn((_clientX: number): number | null => 42),
	};
}

interface Setup {
	view: MarkerListView;
	listContainer: HTMLElement;
	seekEl: HTMLElement;
	callbacks: jest.Mocked<MarkerListCallbacks>;
}

/** Mounts a view with list and overlay, sets markers, and renders. */
function setup(editable: boolean): Setup {
	const callbacks = makeCallbacks();
	const view = new MarkerListView(makeHost(), callbacks);
	const listContainer = extendedEl();
	const seekEl = extendedEl();
	view.mountOverlay(seekEl);
	view.mountList(listContainer);
	view.setEditable(editable);
	view.setMarkers(MARKERS);
	view.render(60, 0);
	return { view, listContainer, seekEl, callbacks };
}

describe('MarkerListView rendering', () => {
	it('renders one row per marker, ordered by time', () => {
		const { listContainer } = setup(true);
		expect(allEls(listContainer, MARKER.row)).toHaveLength(2);
		const ids = allEls(listContainer, '[data-marker-id]')
			.map((node) => node.dataset['markerId'])
			.filter((id, index, all) => all.indexOf(id) === index);
		expect(ids).toEqual(['a', 'b']);
	});

	it('renders editable rows with a rename input and a delete button', () => {
		const { listContainer } = setup(true);
		expect(allEls(listContainer, MARKER.labelInput)).toHaveLength(2);
		expect(allEls(listContainer, MARKER.delete)).toHaveLength(2);
	});

	it('renders read-only rows as clickable jump targets without inputs', () => {
		const { listContainer } = setup(false);
		expect(allEls(listContainer, MARKER.labelInput)).toHaveLength(0);
		expect(allEls(listContainer, MARKER.clickableRow)).toHaveLength(2);
	});

	it('renders a tick per marker on the overlay', () => {
		const { seekEl } = setup(true);
		expect(seekEl).toHaveMarkerAt(10, 'Intro');
		expect(seekEl).toHaveMarkerAt(30, 'Note');
	});
});

describe('MarkerListView interaction', () => {
	it('jumps to a marker time on a list jump click', () => {
		const { listContainer, callbacks } = setup(true);
		el(
			listContainer,
			'[data-action="jump"][data-marker-id="b"]',
		).dispatchEvent(new MouseEvent('click', { bubbles: true }));
		expect(callbacks.onJump).toHaveBeenCalledWith(30);
	});

	it('deletes a marker on a delete click', () => {
		const { listContainer, callbacks } = setup(true);
		el(
			listContainer,
			'[data-action="delete"][data-marker-id="a"]',
		).dispatchEvent(new MouseEvent('click', { bubbles: true }));
		expect(callbacks.onDelete).toHaveBeenCalledWith('a');
	});

	it('renames a marker immediately on a change event', () => {
		const { listContainer, callbacks } = setup(true);
		const input = el<HTMLInputElement>(
			listContainer,
			'input[data-marker-id="b"]',
		);
		input.value = 'Renamed';
		input.dispatchEvent(new Event('change', { bubbles: true }));
		expect(callbacks.onRename).toHaveBeenCalledWith('b', 'Renamed');
	});

	it('jumps to a marker time on a tick pointerdown', () => {
		const { seekEl, callbacks } = setup(true);
		el(seekEl, MARKER.tickAt(30)).dispatchEvent(
			new MouseEvent('pointerdown', { bubbles: true }),
		);
		expect(callbacks.onJump).toHaveBeenCalledWith(30);
	});

	it('jumps on a read-only row click', () => {
		const { listContainer, callbacks } = setup(false);
		el(listContainer, MARKER.byId('a')).dispatchEvent(
			new MouseEvent('click', { bubbles: true }),
		);
		expect(callbacks.onJump).toHaveBeenCalledWith(10);
	});
});

describe('MarkerListView active highlight and tick refresh', () => {
	it('highlights the row whose segment contains the current time', () => {
		const { view, listContainer } = setup(false);
		view.updateActive(15);
		const rows = allEls(listContainer, MARKER.row);
		// 15s falls in the first marker's segment (10s..30s)
		expect(at(rows, 0).classList.contains('is-active')).toBe(true);
		expect(at(rows, 1).classList.contains('is-active')).toBe(false);
	});

	it('refreshes ticks without rebuilding the list', () => {
		const { view, listContainer } = setup(true);
		const firstRow = el(listContainer, MARKER.row);
		view.refreshTicks(60);
		// The same row node survives a tick refresh (a focused input is kept)
		expect(el(listContainer, MARKER.row)).toBe(firstRow);
	});
});
