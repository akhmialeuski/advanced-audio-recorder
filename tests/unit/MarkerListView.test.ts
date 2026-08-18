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

/**
 * A host that attaches listeners directly, mirroring registerDomEvent, and
 * collects the teardown callbacks Obsidian would run on unload.
 * @param teardowns - Collector the host pushes its cleanups into
 * @returns The host
 */
function makeHost(teardowns: (() => void)[] = []): MarkerListHost {
	return {
		register: (cleanup) => {
			teardowns.push(cleanup);
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
	/** The cleanups the host collected, run on unload by Obsidian. */
	teardowns: (() => void)[];
}

/**
 * Mounts a view with list and overlay, sets markers, and renders.
 * @param editable - Whether the player is in edit mode
 * @param options - Track length and markers to render, when not the defaults
 * @returns The view with the elements it rendered into and its callbacks
 */
function setup(
	editable: boolean,
	options: {
		duration?: number | null;
		markers?: PlayerMarker[];
	} = {},
): Setup {
	const callbacks = makeCallbacks();
	const teardowns: (() => void)[] = [];
	const view = new MarkerListView(makeHost(teardowns), callbacks);
	const listContainer = extendedEl();
	const seekEl = extendedEl();
	view.mountOverlay(seekEl);
	view.mountList(listContainer);
	view.setEditable(editable);
	view.setMarkers(options.markers ?? MARKERS);
	view.render(options.duration === undefined ? 60 : options.duration, 0);
	return { view, listContainer, seekEl, callbacks, teardowns };
}

/** Dispatches a pointerdown the overlay's delegated handler will see. */
function pointerDown(target: HTMLElement, button = 0): void {
	const event = new MouseEvent('pointerdown', { bubbles: true });
	Object.defineProperty(event, 'button', { value: button });
	target.dispatchEvent(event);
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

describe('MarkerListView tick jumps', () => {
	it('ignores a right-click on the overlay', () => {
		// The context menu belongs to the player; seeking on it would move
		// playback under the menu the user is about to read.
		const { seekEl, callbacks } = setup(true);

		pointerDown(el(seekEl, MARKER.tickAt(30)), 2);

		expect(callbacks.onJump).not.toHaveBeenCalled();
	});

	it('ignores a press on the overlay that missed every tick', () => {
		const { seekEl, callbacks } = setup(true);

		pointerDown(el(seekEl, MARKER.overlay));

		expect(callbacks.onJump).not.toHaveBeenCalled();
	});

	it('ignores a tick whose position is not a number', () => {
		// Nothing writes a bad data-time today, but seeking to NaN would
		// leave the audio element in a state nothing recovers from.
		const { seekEl, callbacks } = setup(true);
		const tick = el(seekEl, MARKER.tickAt(30));
		tick.dataset['time'] = 'later';

		pointerDown(tick);

		expect(callbacks.onJump).not.toHaveBeenCalled();
	});
});

describe('MarkerListView double-click to add', () => {
	/** Double-clicks the seek area at a position. */
	function doubleClick(seekEl: HTMLElement): void {
		seekEl.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
	}

	it('drops a bookmark where the track was double-clicked', () => {
		const { seekEl, callbacks } = setup(true);

		doubleClick(seekEl);

		expect(callbacks.onAddAt).toHaveBeenCalledWith(42, 'bookmark');
	});

	it('adds nothing in a read-only player', () => {
		// Reading view has no way to undo an accidental marker.
		const { seekEl, callbacks } = setup(false);

		doubleClick(seekEl);

		expect(callbacks.onAddAt).not.toHaveBeenCalled();
	});

	it('adds nothing while the position cannot be worked out', () => {
		const { seekEl, callbacks } = setup(true);
		callbacks.timeAtClientX.mockReturnValue(null);

		doubleClick(seekEl);

		expect(callbacks.onAddAt).not.toHaveBeenCalled();
	});
});

describe('MarkerListView list clicks that are not actions', () => {
	it.each([
		{ name: 'the list background', selector: MARKER.list },
		{ name: 'a row that carries no action', selector: MARKER.row },
	])('ignores a click on $name', ({ selector }) => {
		const { listContainer, callbacks } = setup(true);

		el(listContainer, selector).dispatchEvent(
			new MouseEvent('click', { bubbles: true }),
		);

		expect(callbacks.onJump).not.toHaveBeenCalled();
		expect(callbacks.onDelete).not.toHaveBeenCalled();
	});

	it('ignores a click on the rename field, which is not an action', () => {
		const { listContainer, callbacks } = setup(true);

		el(listContainer, MARKER.labelInput).dispatchEvent(
			new MouseEvent('click', { bubbles: true }),
		);

		expect(callbacks.onJump).not.toHaveBeenCalled();
		expect(callbacks.onDelete).not.toHaveBeenCalled();
	});

	it('ignores a jump for a marker that is no longer there', () => {
		// A delete elsewhere can land between the render and the click.
		const { view, listContainer, callbacks } = setup(true);
		const jump = el(
			listContainer,
			'[data-action="jump"][data-marker-id="b"]',
		);
		view.setMarkers([at(MARKERS, 0)]);

		jump.dispatchEvent(new MouseEvent('click', { bubbles: true }));

		expect(callbacks.onJump).not.toHaveBeenCalled();
	});
});

describe('MarkerListView renaming while typing', () => {
	beforeEach(() => {
		jest.useFakeTimers();
	});

	afterEach(() => {
		jest.useRealTimers();
	});

	/** Types into a row's rename input without committing it. */
	function type(listContainer: HTMLElement, id: string, value: string): void {
		const input = el<HTMLInputElement>(
			listContainer,
			`input[data-marker-id="${id}"]`,
		);
		input.value = value;
		input.dispatchEvent(new Event('input', { bubbles: true }));
	}

	it('saves a rename shortly after the typing stops', () => {
		// Neither change nor blur fires when the player is torn down while a
		// rename input still has focus, so the edit is saved on its own.
		const { listContainer, callbacks } = setup(true);

		type(listContainer, 'b', 'Renamed');
		jest.advanceTimersByTime(400);

		expect(callbacks.onRename).toHaveBeenCalledWith('b', 'Renamed');
	});

	it('saves nothing while the user is still typing', () => {
		const { listContainer, callbacks } = setup(true);

		type(listContainer, 'b', 'Ren');
		jest.advanceTimersByTime(200);

		expect(callbacks.onRename).not.toHaveBeenCalled();
	});

	it('saves only the last thing typed', () => {
		const { listContainer, callbacks } = setup(true);

		type(listContainer, 'b', 'Ren');
		jest.advanceTimersByTime(200);
		type(listContainer, 'b', 'Renamed');
		jest.advanceTimersByTime(400);

		expect(callbacks.onRename).toHaveBeenCalledTimes(1);
		expect(callbacks.onRename).toHaveBeenCalledWith('b', 'Renamed');
	});

	it('does not save twice when the field is committed as well', () => {
		const { listContainer, callbacks } = setup(true);
		const input = el<HTMLInputElement>(
			listContainer,
			'input[data-marker-id="b"]',
		);

		type(listContainer, 'b', 'Renamed');
		input.dispatchEvent(new Event('change', { bubbles: true }));
		jest.advanceTimersByTime(400);

		expect(callbacks.onRename).toHaveBeenCalledTimes(1);
	});

	it.each([
		{ name: 'input', event: 'input' },
		{ name: 'change', event: 'change' },
	])(
		'ignores a $name event from something that is not a rename',
		({ event }) => {
			const { listContainer, callbacks } = setup(true);

			el(listContainer, MARKER.delete).dispatchEvent(
				new Event(event, { bubbles: true }),
			);
			jest.advanceTimersByTime(400);

			expect(callbacks.onRename).not.toHaveBeenCalled();
		},
	);
});

describe('MarkerListView with no known length', () => {
	it.each([
		{ name: 'the length is not yet known', duration: null },
		{ name: 'the length reads as zero', duration: 0 },
	])('draws no ticks while $name', ({ duration }) => {
		// Every tick would land at the same place, or at infinity.
		const { seekEl } = setup(true, { duration });

		expect(allEls(seekEl, MARKER.row)).toHaveLength(0);
		expect(seekEl).not.toHaveMarkerAt(10);
	});

	it('leaves the segment length blank in a read-only row', () => {
		// Without a track length there is no last segment to measure, and a
		// wrong duration next to a chapter reads as a real one.
		const { listContainer } = setup(false, { duration: null });

		expect(at(allEls(listContainer, MARKER.segment), 1).textContent).toBe(
			'',
		);
	});

	it('still lists the markers, lined up against the latest one', () => {
		// The list is useful before the length loads; the timestamps are
		// padded against the last marker so the column stays straight.
		const { listContainer } = setup(true, { duration: null });

		expect(allEls(listContainer, MARKER.row)).toHaveLength(2);
	});

	it('keeps a tick inside the track when a marker sits past its end', () => {
		// A marker from a longer take, or a length that shortened after a
		// trim: the tick clamps to the end rather than overflowing the bar.
		const { seekEl } = setup(true, {
			duration: 20,
			markers: [{ id: 'a', time: 60, label: 'Late', kind: 'bookmark' }],
		});

		expect(
			el(seekEl, MARKER.tickAt(60)).style.getPropertyValue(
				'--aar-tick-left',
			),
		).toBe('100%');
	});
});

describe('MarkerListView before it is mounted', () => {
	it('renders nothing rather than throwing', () => {
		// The player builds the view before it knows whether the marker
		// window is on, so render can arrive with nothing to render into.
		const view = new MarkerListView(makeHost(), makeCallbacks());
		view.setMarkers(MARKERS);

		expect(() => {
			view.render(60, 5);
		}).not.toThrow();
	});

	it('moves no highlight when there are no rows', () => {
		const view = new MarkerListView(makeHost(), makeCallbacks());

		expect(() => {
			view.updateActive(5);
		}).not.toThrow();
	});
});

describe('MarkerListView teardown', () => {
	beforeEach(() => {
		jest.useFakeTimers();
	});

	afterEach(() => {
		jest.useRealTimers();
	});

	it('drops a rename that had not been saved yet', () => {
		// The debounce would otherwise fire against a player that is gone,
		// writing to a file the user has closed.
		const { listContainer, callbacks, teardowns } = setup(true);
		const input = el<HTMLInputElement>(
			listContainer,
			'input[data-marker-id="b"]',
		);
		input.value = 'Half-typed';
		input.dispatchEvent(new Event('input', { bubbles: true }));

		for (const teardown of teardowns) {
			teardown();
		}
		jest.advanceTimersByTime(400);

		expect(callbacks.onRename).not.toHaveBeenCalled();
	});
});
