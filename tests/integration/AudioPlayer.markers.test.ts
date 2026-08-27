/**
 * Everything the player does when its marker window is open.
 *
 * The marker window is where a user edits a recording: jumping to a chapter,
 * renaming one, deleting one, dropping a new one on the seek bar. All of it
 * reaches the player through closures it hands the marker view and the control
 * row, and those closures were the largest untested part of the file - a wrong
 * one silently disconnects an edit while every unit suite stays green.
 * @module tests/integration/AudioPlayer.markers.test
 */

import { AudioPlayer } from 'src/player/AudioPlayer';
import { getPlayerEmbedActions } from 'src/player/playerEmbedActions';
import { WaveformPeakCache } from 'src/player/WaveformData';
import type { ResolvedPlayerSettings } from 'src/player/playerSettings';
import type { PlayerMarker } from 'src/markers/markerModel';
import { at } from '../helpers/assertions';
import { tick } from '../helpers/async';
import { allEls, clickControl, control, el, maybeEl } from '../helpers/dom';
import { noticeMessages } from '../mocks/obsidian';
import { MARKER, PLAYER } from '../helpers/selectors';
import {
	app,
	decoder,
	makeContainer,
	makeEditableContainer,
	makeFakeAudio,
	makeFile,
	makeMarkerStore,
	makeRegistry,
	type FakeAudio,
} from '../helpers/audioPlayerHarness';

const WITH_MARKERS: ResolvedPlayerSettings = {
	showWaveform: false,
	enableMarkers: true,
};

const MARKERS: PlayerMarker[] = [
	{ id: 'a', time: 10, label: 'Intro', kind: 'chapter' },
	{ id: 'b', time: 30, label: 'Question', kind: 'bookmark' },
];

/** What a rendered player hands a test to drive and observe it. */
interface OpenPlayer {
	player: AudioPlayer;
	container: HTMLElement;
	audio: FakeAudio;
	store: ReturnType<typeof makeMarkerStore>;
}

/** A rendered player in reading view, where the whole row is the jump target. */
async function openReadingWithMarkers(
	markers: PlayerMarker[] = MARKERS,
): Promise<OpenPlayer> {
	return openWithMarkers(markers, makeContainer());
}

/**
 * A rendered player with the given markers already stored, in edit mode
 * unless the caller supplies a container of its own.
 * @param markers - What the store holds for this recording
 * @param host - The element the player renders into
 * @returns The player and what a test drives it through
 */
async function openWithMarkers(
	markers: PlayerMarker[] = MARKERS,
	host: HTMLElement = makeEditableContainer(),
): Promise<OpenPlayer> {
	const audio = makeFakeAudio();
	audio.duration = 60;
	const store = makeMarkerStore();
	store.data.set('rec.wav', [...markers]);
	const container = host;
	const player = new AudioPlayer(
		container,
		app,
		makeFile(1000, 'wav'),
		WITH_MARKERS,
		makeRegistry(audio),
		new WaveformPeakCache(),
		decoder,
		store,
		{ startSeconds: null, sourcePath: 'note.md', immediate: true },
	);
	// load(), not onload(): Component only runs its registered teardowns when
	// it believes it was loaded, so a test that unloads needs the real pair.
	player.load();
	await tick();
	return { player, container, audio, store };
}

afterEach(() => {
	document.body.innerHTML = '';
});

describe('the marker list', () => {
	it('shows a row per stored marker', async () => {
		const { container } = await openWithMarkers();

		expect(allEls(container, MARKER.row)).toHaveLength(2);
	});

	it('jumps to a marker without starting playback', async () => {
		// A jump from the list is navigation; a paused player must stay
		// paused, or reading through a transcript starts the audio.
		const { container, audio } = await openWithMarkers();

		el(container, '[data-action="jump"][data-marker-id="b"]').dispatchEvent(
			new MouseEvent('click', { bubbles: true }),
		);

		expect(audio.currentTime).toBe(30);
		expect(audio.play).not.toHaveBeenCalled();
	});

	it('deletes a marker from the store', async () => {
		const { container, store } = await openWithMarkers();

		el(
			container,
			'[data-action="delete"][data-marker-id="a"]',
		).dispatchEvent(new MouseEvent('click', { bubbles: true }));
		await tick();

		expect((store.data.get('rec.wav') ?? []).map((m) => m.id)).toEqual([
			'b',
		]);
	});

	it('renames a marker in the store', async () => {
		const { container, store } = await openWithMarkers();
		const input = el<HTMLInputElement>(
			container,
			'input[data-marker-id="b"]',
		);

		input.value = 'Follow-up';
		input.dispatchEvent(new Event('change', { bubbles: true }));
		await tick();

		expect(at(store.data.get('rec.wav') ?? [], 1).label).toBe('Follow-up');
	});

	it('drops a new bookmark where the seek bar was double-clicked', async () => {
		const { container, store } = await openWithMarkers();
		const seek = el(container, PLAYER.seek);
		seek.getBoundingClientRect = (): DOMRect =>
			({ left: 0, width: 100, top: 0, height: 10 }) as DOMRect;

		seek.dispatchEvent(
			new MouseEvent('dblclick', { clientX: 50, bubbles: true }),
		);
		await tick();

		expect(store.data.get('rec.wav')).toHaveLength(3);
	});

	it('puts a tick on the seek bar for every marker', async () => {
		const { container } = await openWithMarkers();

		expect(container).toHaveMarkerAt(10, 'Intro');
		expect(container).toHaveMarkerAt(30, 'Question');
	});

	it('shows the new tick as soon as a marker is added', async () => {
		// The list and the overlay are refreshed by two different callbacks;
		// only one of them firing leaves the seek bar a marker behind.
		const { container, player } = await openWithMarkers();

		player.reloadMarkers();
		await tick();

		expect(allEls(container, PLAYER.tick)).toHaveLength(2);
	});

	it('reads no markers after the player is gone', async () => {
		// A sidecar write can land just after a note is closed; re-reading it
		// into a detached player would rebuild DOM nobody will ever see.
		const { player, store } = await openWithMarkers();
		player.unload();
		jest.mocked(store.getMarkers).mockClear();

		player.reloadMarkers();
		await tick();

		expect(store.getMarkers).not.toHaveBeenCalled();
	});

	it('reads no markers while the marker window is off', async () => {
		const { player, store } = await openWithMarkers();
		player.applySettings({ showWaveform: false, enableMarkers: false });
		jest.mocked(store.getMarkers).mockClear();

		player.reloadMarkers();
		await tick();

		expect(store.getMarkers).not.toHaveBeenCalled();
	});
});

// Reading view is where a recording is listened to rather than edited, and
// where the whole row is the jump target. It used to be a block element with a
// data attribute on it: tab skipped it and Enter did nothing, so the chapters
// of a recording could only be reached with a pointer. Driven here against the
// real audio element, because what has to move is the playback position and
// not a callback.
describe('reaching a chapter from the keyboard in reading view', () => {
	it('offers the marker row as a focusable control', async () => {
		const { container } = await openReadingWithMarkers();

		const row = el(container, MARKER.byId('b'));
		row.focus();

		expect(document.activeElement).toBe(row);
	});

	it('moves the playback position when a focused row is activated', async () => {
		const { container, audio } = await openReadingWithMarkers();
		const row = el(container, MARKER.byId('b'));

		row.focus();
		// What Enter and Space do to a focused button, which is the whole
		// reason the row is one.
		row.click();

		expect(audio.currentTime).toBe(30);
		expect(audio.play).not.toHaveBeenCalled();
	});
});

describe('the chapter controls', () => {
	it.each([
		{ name: 'Next chapter', from: 0, expected: 10 },
		{ name: 'Previous chapter', from: 35, expected: 10 },
	])('$name moves to $expected seconds', async ({ name, from, expected }) => {
		const { container, audio } = await openWithMarkers();
		audio.currentTime = from;

		clickControl(container, name);

		expect(audio.currentTime).toBe(expected);
	});

	it('mutes and unmutes from the control row', async () => {
		const { container, audio } = await openWithMarkers();

		clickControl(container, 'Mute / unmute');

		expect(audio.muted).toBe(true);
	});

	it('shows a pause icon once the audio starts, whoever started it', async () => {
		// The same file can be playing from another pane; the button follows
		// the element, not this player's own click.
		const { container, audio } = await openWithMarkers();

		audio.paused = false;
		audio.emit('play');

		expect(
			control(container, 'Play / pause').getAttribute('data-icon'),
		).toBe('pause');
	});

	it.each(['pause', 'ended'])(
		'shows a play icon again on %s',
		async (event) => {
			const { container, audio } = await openWithMarkers();
			audio.paused = false;
			audio.emit('play');

			audio.paused = true;
			audio.emit(event);

			expect(
				control(container, 'Play / pause').getAttribute('data-icon'),
			).toBe('play');
		},
	);

	it('follows the position as the audio plays', async () => {
		const { container, audio } = await openWithMarkers();

		audio.currentTime = 25;
		audio.emit('timeupdate');

		expect(container).toShowTime('0:25 / 1:00');
	});
});

describe('the actions the note context menu offers', () => {
	/** The embed actions the player published on its container. */
	function actionsOn(container: HTMLElement): {
		markersEnabled: boolean;
		timestampLinksEnabled: boolean;
		timeAtClientX: (clientX: number) => number | null;
		addMarkerAtTime: (time: number, kind: string) => void;
		copyTimestampAtTime: (time: number) => void;
		togglePlayback: () => void;
	} {
		return getPlayerEmbedActions(container) as never;
	}

	it('offers marker creation in an editable note', async () => {
		const { container } = await openWithMarkers();

		expect(actionsOn(container).markersEnabled).toBe(true);
		expect(actionsOn(container).timestampLinksEnabled).toBe(true);
	});

	it('adds a marker at the position the menu was opened over', async () => {
		const { container, store } = await openWithMarkers();

		actionsOn(container).addMarkerAtTime(42, 'chapter');
		await tick();

		expect(
			(store.data.get('rec.wav') ?? []).some(
				(marker) => marker.time === 42,
			),
		).toBe(true);
	});

	it('reads a position off the seek bar for the menu', async () => {
		const { container } = await openWithMarkers();
		const seek = el(container, PLAYER.seek);
		seek.getBoundingClientRect = (): DOMRect =>
			({ left: 0, width: 100, top: 0, height: 10 }) as DOMRect;

		expect(actionsOn(container).timeAtClientX(50)).toBe(30);
	});

	it('starts and stops playback from the menu', async () => {
		const { container, audio } = await openWithMarkers();

		actionsOn(container).togglePlayback();

		expect(audio.play).toHaveBeenCalled();
	});

	it('copies a link to the position the menu was opened over', async () => {
		const write = jest.fn().mockResolvedValue(undefined);
		Object.defineProperty(navigator, 'clipboard', {
			value: { writeText: write },
			configurable: true,
		});
		const { container } = await openWithMarkers();

		actionsOn(container).copyTimestampAtTime(42);
		await tick();

		// The link text comes from Obsidian; what this asserts is that the
		// position the menu was opened over is the one reported back.
		expect(write).toHaveBeenCalledWith(expect.any(String));
		expect(noticeMessages()).toContain('Copied timestamp link at 0:42');
	});
});

describe('a length the container never carried', () => {
	it('probes for the real one instead of leaving the timeline at zero', async () => {
		// A webm written by MediaRecorder carries no duration until it is
		// fully read; the element reports Infinity and every timestamp in the
		// player would be wrong.
		const { container, audio } = await openWithMarkers();
		audio.duration = Number.POSITIVE_INFINITY;

		audio.emit('loadedmetadata');

		expect(audio.currentTime).toBeGreaterThan(1e100);
		expect(maybeEl(container, PLAYER.time)).not.toBeNull();
	});
});

describe('jumping between chapters at the edges', () => {
	it('stays put when there is no chapter after the position', async () => {
		// Past the last chapter there is nowhere to go; jumping to the end
		// would look like the button skipped the rest of the recording.
		const { container, audio } = await openWithMarkers();
		audio.currentTime = 55;

		clickControl(container, 'Next chapter');

		expect(audio.currentTime).toBe(55);
	});

	it('goes back to the start when there is no chapter before the position', async () => {
		const { container, audio } = await openWithMarkers();
		audio.currentTime = 5;

		clickControl(container, 'Previous chapter');

		expect(audio.currentTime).toBe(0);
	});

	it('unmutes when the volume is raised off zero', async () => {
		// Dragging the slider up is how a muted player is expected to come
		// back; leaving it muted makes the slider look broken.
		const { container, audio } = await openWithMarkers();
		audio.muted = true;
		const volume = el<HTMLInputElement>(container, PLAYER.volume);

		volume.value = '0.6';
		volume.dispatchEvent(new Event('input'));

		expect(audio.volume).toBe(0.6);
		expect(audio.muted).toBe(false);
	});
});
