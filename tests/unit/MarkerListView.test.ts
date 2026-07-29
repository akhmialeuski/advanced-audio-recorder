/**
 * Unit tests for the marker/chapter view extracted from the player. They
 * cover the rendering of the list and ticks, the delegated jump/delete/rename
 * handling, the active-segment highlight, and that a tick refresh after a
 * rename does not rebuild the list (so a focused rename input is preserved).
 */

import { App, Modal } from 'obsidian';
import { at } from '../helpers/assertions';
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
		const rows = listContainer.querySelectorAll('.aar-player-marker-row');
		expect(rows).toHaveLength(2);
		const times = Array.from(
			listContainer.querySelectorAll('[data-marker-id]'),
		)
			.map((el) => (el as HTMLElement).dataset.markerId)
			.filter((id, i, arr) => arr.indexOf(id) === i);
		expect(times).toEqual(['a', 'b']);
	});

	it('renders editable rows with a rename input and a delete button', () => {
		const { listContainer } = setup(true);
		expect(
			listContainer.querySelectorAll('input.aar-player-marker-label'),
		).toHaveLength(2);
		expect(
			listContainer.querySelectorAll('.aar-player-marker-delete'),
		).toHaveLength(2);
	});

	it('renders read-only rows as clickable jump targets without inputs', () => {
		const { listContainer } = setup(false);
		expect(
			listContainer.querySelectorAll('input.aar-player-marker-label'),
		).toHaveLength(0);
		expect(
			listContainer.querySelectorAll('.aar-player-marker-row-clickable'),
		).toHaveLength(2);
	});

	it('renders a tick per marker on the overlay', () => {
		const { seekEl } = setup(true);
		expect(seekEl.querySelectorAll('.aar-player-tick')).toHaveLength(2);
	});
});

describe('MarkerListView interaction', () => {
	it('jumps to a marker time on a list jump click', () => {
		const { listContainer, callbacks } = setup(true);
		const jump = listContainer.querySelector(
			'[data-action="jump"][data-marker-id="b"]',
		) as HTMLElement;
		jump.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		expect(callbacks.onJump).toHaveBeenCalledWith(30);
	});

	it('deletes a marker on a delete click', () => {
		const { listContainer, callbacks } = setup(true);
		const del = listContainer.querySelector(
			'[data-action="delete"][data-marker-id="a"]',
		) as HTMLElement;
		del.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		expect(callbacks.onDelete).toHaveBeenCalledWith('a');
	});

	it('renames a marker immediately on a change event', () => {
		const { listContainer, callbacks } = setup(true);
		const input = listContainer.querySelector(
			'input[data-marker-id="b"]',
		) as HTMLInputElement;
		input.value = 'Renamed';
		input.dispatchEvent(new Event('change', { bubbles: true }));
		expect(callbacks.onRename).toHaveBeenCalledWith('b', 'Renamed');
	});

	it('jumps to a marker time on a tick pointerdown', () => {
		const { seekEl, callbacks } = setup(true);
		const tick = seekEl.querySelector(
			'.aar-player-tick[data-time="30"]',
		) as HTMLElement;
		tick.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
		expect(callbacks.onJump).toHaveBeenCalledWith(30);
	});

	it('jumps on a read-only row click', () => {
		const { listContainer, callbacks } = setup(false);
		const row = listContainer.querySelector(
			'.aar-player-marker-row-clickable[data-marker-id="a"]',
		) as HTMLElement;
		row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		expect(callbacks.onJump).toHaveBeenCalledWith(10);
	});
});

describe('MarkerListView active highlight and tick refresh', () => {
	it('highlights the row whose segment contains the current time', () => {
		const { view, listContainer } = setup(false);
		view.updateActive(15);
		const rows = listContainer.querySelectorAll('.aar-player-marker-row');
		// 15s falls in the first marker's segment (10s..30s)
		expect(at(rows, 0).classList.contains('is-active')).toBe(true);
		expect(at(rows, 1).classList.contains('is-active')).toBe(false);
	});

	it('refreshes ticks without rebuilding the list', () => {
		const { view, listContainer } = setup(true);
		const firstRow = listContainer.querySelector('.aar-player-marker-row');
		view.refreshTicks(60);
		// The same row node survives a tick refresh (a focused input is kept)
		expect(listContainer.querySelector('.aar-player-marker-row')).toBe(
			firstRow,
		);
	});
});
