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
		onEditTime: jest.fn(),
		onUseCurrentTime: jest.fn(),
		onEditNote: jest.fn(),
		onSetColor: jest.fn(),
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

// Reading view is where the whole row is the jump target, and it used to be a
// block element carrying a data attribute: tab skipped it, Enter and Space did
// nothing, and a screen reader read it as text, so the chapters of a recording
// could only be reached with a pointer. Making the row the button it behaves
// like is what fixes all three, and what these tests hold it to.
describe('MarkerListView keyboard access in reading view', () => {
	it('builds a read-only row as a button', () => {
		const { listContainer } = setup(false);

		expect(el(listContainer, MARKER.byId('a')).tagName).toBe('BUTTON');
	});

	it('keeps an editable row a plain block, which holds controls of its own', () => {
		const { listContainer } = setup(true);

		expect(el(listContainer, MARKER.row).tagName).toBe('DIV');
	});

	it('puts a read-only row in the tab order', () => {
		const { listContainer } = setup(false);

		// A button is focusable without a tabindex, which is the point of
		// using one: the order is the document's rather than a number here.
		expect(el(listContainer, MARKER.byId('a')).tabIndex).toBe(0);
	});

	it('does not submit a form when a row is pressed', () => {
		const { listContainer } = setup(false);

		expect(el(listContainer, MARKER.byId('a')).getAttribute('type')).toBe(
			'button',
		);
	});

	// A button turns Enter and Space into a click, which the delegated handler
	// already answers; the row is focused first because that is how a user
	// reaches it.
	it('jumps when a focused row is activated from the keyboard', () => {
		const { listContainer, callbacks } = setup(false);
		const row = el(listContainer, MARKER.byId('b'));

		row.focus();
		row.click();

		expect(callbacks.onJump).toHaveBeenCalledWith(30);
	});

	// The row being a button makes its aria-label the accessible name, which
	// replaces the text inside it rather than adding to it. A constant one
	// therefore hides the very thing the reader is tabbing through the list to
	// find, and every chapter of a recording announces identically.
	it('names a read-only row by the marker it jumps to', () => {
		const { listContainer } = setup(false);

		const name = el(listContainer, MARKER.byId('a')).getAttribute(
			'aria-label',
		);

		expect(name).toContain('Intro');
		expect(name).toContain('0:10');
	});

	// A marker keeps its timecode as the only thing that tells it apart when
	// it was never given a name, so the label falls back to that rather than
	// leaving an empty gap in the sentence.
	it('names an unlabelled read-only row by its time alone', () => {
		const { listContainer } = setup(false, {
			markers: [{ id: 'a', time: 10, label: '', kind: 'chapter' }],
		});

		expect(
			el(listContainer, MARKER.byId('a')).getAttribute('aria-label'),
		).toBe('Jump to chapter at 0:10');
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

	// In reading view the row is a real button, so a reader announces its name
	// and nothing else about it. The accent edge marking the segment being
	// played was visible and unannounced, which left a listener working
	// through the chapters with no way to tell where the track had reached.
	it('marks the playing row as the current one for a reader', () => {
		const { view, listContainer } = setup(false);

		view.updateActive(15);

		const rows = allEls(listContainer, MARKER.row);
		expect(at(rows, 0).getAttribute('aria-current')).toBe('true');
		expect(at(rows, 1).hasAttribute('aria-current')).toBe(false);
	});

	// aria-current spells "not the current one" by absence, so a row the
	// position has left has to give the attribute up rather than carry it
	// saying false, which some readers announce anyway.
	it('takes the mark off a row the position has moved past', () => {
		const { view, listContainer } = setup(false);

		view.updateActive(15);
		view.updateActive(45);

		const rows = allEls(listContainer, MARKER.row);
		expect(at(rows, 0).hasAttribute('aria-current')).toBe(false);
		expect(at(rows, 1).getAttribute('aria-current')).toBe('true');
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

	/**
	 * Types into one of a row's fields without committing it.
	 * @param listContainer - The rendered marker list
	 * @param selector - The element the field is, `input` or `textarea`
	 * @param id - Which marker's row to type in
	 * @param value - What to type
	 */
	function typeInto(
		listContainer: HTMLElement,
		selector: string,
		id: string,
		value: string,
	): void {
		const field = el<HTMLInputElement | HTMLTextAreaElement>(
			listContainer,
			`${selector}[data-marker-id="${id}"]`,
		);
		field.value = value;
		field.dispatchEvent(new Event('input', { bubbles: true }));
	}

	/** Types into a row's rename input without committing it. */
	function type(listContainer: HTMLElement, id: string, value: string): void {
		typeInto(listContainer, 'input', id, value);
	}

	// The name and the note shared one timer, so a keystroke in either
	// cancelled the other's pending write rather than merely delaying it.
	// Clicking straight from a name into a note fires no change event on the
	// name, so the rename was not saved late: it was lost.
	it('keeps a pending rename when another field is typed in', () => {
		const { listContainer, callbacks } = setup(true);

		type(listContainer, 'b', 'Renamed');
		jest.advanceTimersByTime(200);
		typeInto(listContainer, 'textarea', 'a', 'Worth coming back to');
		jest.advanceTimersByTime(400);

		expect(callbacks.onRename).toHaveBeenCalledWith('b', 'Renamed');
		expect(callbacks.onEditNote).toHaveBeenCalledWith(
			'a',
			'Worth coming back to',
		);
	});

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

describe('editing a marker time from the list', () => {
	it('reports a typed timecode as seconds', () => {
		const { listContainer, callbacks } = setup(true);
		const field = at(
			allEls<HTMLInputElement>(listContainer, MARKER.timeEdit),
			0,
		);

		field.value = '1:05';
		field.dispatchEvent(new Event('change', { bubbles: true }));

		expect(callbacks.onEditTime).toHaveBeenCalledWith('a', 65);
	});

	it.each([
		{ name: 'plain seconds', typed: '90', seconds: 90 },
		{ name: 'minutes and seconds', typed: '2:30', seconds: 150 },
		{ name: 'hours, minutes and seconds', typed: '1:00:01', seconds: 3601 },
	])('understands $name', ({ typed, seconds }) => {
		const { listContainer, callbacks } = setup(true);
		const field = at(
			allEls<HTMLInputElement>(listContainer, MARKER.timeEdit),
			0,
		);

		field.value = typed;
		field.dispatchEvent(new Event('change', { bubbles: true }));

		expect(callbacks.onEditTime).toHaveBeenCalledWith('a', seconds);
	});

	it('puts the rendered time back when the typed one means nothing', () => {
		const { listContainer, callbacks } = setup(true);
		const field = at(
			allEls<HTMLInputElement>(listContainer, MARKER.timeEdit),
			0,
		);

		field.value = 'half past';
		field.dispatchEvent(new Event('change', { bubbles: true }));

		expect(callbacks.onEditTime).not.toHaveBeenCalled();
		expect(field.value).toBe('0:10');
	});

	it('offers moving the marker to the current position', () => {
		const { listContainer, callbacks } = setup(true);

		at(allEls(listContainer, MARKER.here), 0).click();

		expect(callbacks.onUseCurrentTime).toHaveBeenCalledWith('a');
	});
});

describe('a marker note and colour in the list', () => {
	it('reports a committed note', () => {
		const { listContainer, callbacks } = setup(true);
		const field = at(
			allEls<HTMLTextAreaElement>(listContainer, MARKER.note),
			0,
		);

		field.value = 'the bit about pricing';
		field.dispatchEvent(new Event('change', { bubbles: true }));

		expect(callbacks.onEditNote).toHaveBeenCalledWith(
			'a',
			'the bit about pricing',
		);
	});

	it('shows the note a marker already carries', () => {
		const { listContainer } = setup(true, {
			markers: [
				{
					id: 'a',
					time: 10,
					label: 'Intro',
					kind: 'chapter',
					note: 'why',
				},
			],
		});

		expect(
			at(allEls<HTMLTextAreaElement>(listContainer, MARKER.note), 0)
				.value,
		).toBe('why');
	});

	it('reports a chosen colour', () => {
		const { listContainer, callbacks } = setup(true);
		const picker = at(
			allEls<HTMLSelectElement>(listContainer, MARKER.color),
			0,
		);

		picker.value = 'blue';
		picker.dispatchEvent(new Event('change', { bubbles: true }));

		expect(callbacks.onSetColor).toHaveBeenCalledWith('a', 'blue');
	});

	it('reports the empty choice as no colour at all', () => {
		const { listContainer, callbacks } = setup(true, {
			markers: [
				{
					id: 'a',
					time: 10,
					label: 'Intro',
					kind: 'chapter',
					color: 'red',
				},
			],
		});
		const picker = at(
			allEls<HTMLSelectElement>(listContainer, MARKER.color),
			0,
		);

		picker.value = '';
		picker.dispatchEvent(new Event('change', { bubbles: true }));

		expect(callbacks.onSetColor).toHaveBeenCalledWith('a', null);
	});

	// A list of six colour names tells the user nothing about what the theme's
	// red actually looks like on the seek bar.
	it('draws every colour of the palette in the menu that offers it', () => {
		const { listContainer } = setup(true);
		const picker = at(
			allEls<HTMLSelectElement>(listContainer, MARKER.color),
			0,
		);

		const offered = Array.from(picker.options).filter(
			(option) => option.value !== '',
		);
		expect(offered).toHaveLength(6);
		for (const option of offered) {
			expect(option.className).toBe(
				MARKER.colorSwatch(option.value).slice(1),
			);
			// The circle is a character because an option takes no markup
			expect(option.textContent?.startsWith('\u25cf ')).toBe(true);
		}
	});

	it('shows the chosen colour on the closed control as well', () => {
		const { listContainer } = setup(true, {
			markers: [
				{
					id: 'a',
					time: 10,
					label: 'Intro',
					kind: 'chapter',
					color: 'purple',
				},
			],
		});

		expect(
			allEls(listContainer, MARKER.colorSwatch('purple')),
			// The control itself, plus the one option that names the colour
		).toHaveLength(2);
	});

	it('marks a coloured row so the stylesheet can draw its edge', () => {
		const { listContainer } = setup(true, {
			markers: [
				{
					id: 'a',
					time: 10,
					label: 'Intro',
					kind: 'chapter',
					color: 'green',
				},
			],
		});

		expect(allEls(listContainer, MARKER.coloredRow)).toHaveLength(1);
	});

	it('leaves an uncoloured row unmarked, so it looks as it always did', () => {
		const { listContainer } = setup(true);

		expect(allEls(listContainer, MARKER.coloredRow)).toHaveLength(0);
	});

	it('shows the note as text in reading view, where it cannot be edited', () => {
		const { listContainer } = setup(false, {
			markers: [
				{
					id: 'a',
					time: 10,
					label: 'Intro',
					kind: 'chapter',
					note: 'why',
				},
			],
		});

		expect(allEls(listContainer, MARKER.note)).toHaveLength(0);
		expect(el(listContainer, MARKER.staticNote).textContent).toBe('why');
	});

	// Under the timecode the note read as a caption on the time rather than on
	// the marker. It starts at the icon instead, held there by a hidden copy of
	// the timecode so the column is exactly as wide as the one above it.
	it('aligns the reading-view note with the marker icon above it', () => {
		const { listContainer } = setup(false, {
			markers: [
				{
					id: 'a',
					time: 3725,
					label: 'Intro',
					kind: 'chapter',
					note: 'why',
				},
			],
		});

		const indent = el(listContainer, MARKER.noteIndent);
		expect(indent.textContent).toBe(
			el(listContainer, MARKER.time).textContent,
		);
		expect(indent.getAttribute('aria-hidden')).toBe('true');
		expect(el(listContainer, MARKER.noteLine).contains(indent)).toBe(true);
	});

	it('says the note in the row name, which is the whole button', () => {
		const { listContainer } = setup(false, {
			markers: [
				{
					id: 'a',
					time: 10,
					label: 'Intro',
					kind: 'chapter',
					note: 'why',
				},
			],
		});

		expect(el(listContainer, MARKER.row).getAttribute('aria-label')).toBe(
			'Jump to chapter: Intro at 0:10. why',
		);
	});
});

describe('a note typed into the list', () => {
	beforeEach(() => {
		jest.useFakeTimers();
	});

	afterEach(() => {
		jest.useRealTimers();
	});

	it('saves the note shortly after typing stops, as a rename does', () => {
		const { listContainer, callbacks } = setup(true);
		const note = at(
			allEls<HTMLTextAreaElement>(listContainer, MARKER.note),
			0,
		);

		note.value = 'why this matters';
		note.dispatchEvent(new Event('input', { bubbles: true }));
		jest.advanceTimersByTime(400);

		expect(callbacks.onEditNote).toHaveBeenCalledWith(
			'a',
			'why this matters',
		);
	});

	it('saves nothing while the user is still typing it', () => {
		const { listContainer, callbacks } = setup(true);
		const note = at(
			allEls<HTMLTextAreaElement>(listContainer, MARKER.note),
			0,
		);

		note.value = 'why';
		note.dispatchEvent(new Event('input', { bubbles: true }));
		jest.advanceTimersByTime(200);

		expect(callbacks.onEditNote).not.toHaveBeenCalled();
	});
});

describe('an event from something the list does not own', () => {
	it.each([
		{ name: 'a typed value', type: 'input' },
		{ name: 'a committed value', type: 'change' },
	])('ignores $name with no marker behind it', ({ type }) => {
		const { listContainer, callbacks } = setup(true);
		const stray = el(listContainer, MARKER.list).createEl('input');

		stray.value = 'nobody';
		stray.dispatchEvent(new Event(type, { bubbles: true }));

		expect(callbacks.onRename).not.toHaveBeenCalled();
		expect(callbacks.onEditNote).not.toHaveBeenCalled();
		expect(callbacks.onEditTime).not.toHaveBeenCalled();
		expect(callbacks.onSetColor).not.toHaveBeenCalled();
	});

	it('ignores a committed value whose action it does not answer', () => {
		const { listContainer, callbacks } = setup(true);
		const stray = el(listContainer, MARKER.list).createEl('input');
		stray.dataset['markerId'] = 'a';
		stray.dataset['action'] = 'jump';

		stray.dispatchEvent(new Event('change', { bubbles: true }));

		expect(callbacks.onRename).not.toHaveBeenCalled();
		expect(callbacks.onEditTime).not.toHaveBeenCalled();
	});

	it('keeps what a time field showed when it was rendered without one', () => {
		const { listContainer, callbacks } = setup(true);
		// A field with no rendered timecode to fall back on keeps whatever the
		// user left in it, rather than being blanked by the refusal.
		const stray = el(listContainer, MARKER.list).createEl('input');
		stray.dataset['markerId'] = 'a';
		stray.dataset['action'] = 'edit-time';
		stray.value = 'half past';

		stray.dispatchEvent(new Event('change', { bubbles: true }));

		expect(callbacks.onEditTime).not.toHaveBeenCalled();
		expect(stray.value).toBe('half past');
	});

	it('ignores a typed value whose action it does not answer', () => {
		const { listContainer, callbacks } = setup(true);
		const stray = el(listContainer, MARKER.list).createEl('input');
		stray.dataset['markerId'] = 'a';
		stray.dataset['action'] = 'jump';

		stray.dispatchEvent(new Event('input', { bubbles: true }));

		expect(callbacks.onRename).not.toHaveBeenCalled();
		expect(callbacks.onEditNote).not.toHaveBeenCalled();
	});
});
