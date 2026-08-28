/**
 * Regression guards for the AudioPlayer decomposition (audit finding 2.6):
 * the control row (PlayerControlsView), pointer/keyboard seeking
 * (SeekController), infinite-duration resolution (DurationProbe), and
 * marker CRUD (PlayerMarkerController) were extracted from the player.
 * These tests drive the REAL AudioPlayer through the real DOM - clicks,
 * keydowns, pointer events - and assert on the shared audio element and
 * the persisted markers, so a wiring regression in the coordinator cannot
 * hide behind mocked collaborators.
 */

import { at } from '../helpers/assertions';
import { clickControl, control, el } from '../helpers/dom';
import { menuInstances, noticeMessages } from '../mocks/obsidian';
import { PLAYER } from '../helpers/selectors';
import { AudioPlayer } from 'src/player/AudioPlayer';
import { WaveformPeakCache } from 'src/player/WaveformData';
import type { AudioPlayerRegistry } from 'src/player/AudioPlayerRegistry';
import type { RecordingSidecarStore } from 'src/sidecar/RecordingSidecarStore';
import type { ResolvedPlayerSettings } from 'src/player/playerSettings';
import { PLAYER_SKIP_SECONDS } from 'src/constants';
import { tick } from '../helpers/async';

import {
	app,
	decoder,
	makeContainer,
	makeEditableContainer,
	makeFakeAudio,
	makeFile,
	makeMarkerStore,
	makeRegistry,
} from '../helpers/audioPlayerHarness';

const PLAIN: ResolvedPlayerSettings = {
	showWaveform: false,
	enableMarkers: false,
	skipSeconds: 10,
};

function makePlayer(
	container: HTMLElement,
	registry: AudioPlayerRegistry,
	settings: ResolvedPlayerSettings = PLAIN,
	markerStore: RecordingSidecarStore = makeMarkerStore(),
	startSeconds: number | null = null,
): AudioPlayer {
	return new AudioPlayer(
		container,
		app,
		makeFile(1000, 'wav'),
		settings,
		registry,
		new WaveformPeakCache(),
		decoder,
		markerStore,
		{ startSeconds, sourcePath: 'note.md', immediate: true },
	);
}

/** The seek area, prepared for pointer interaction under jsdom. */
function seekArea(container: HTMLElement): HTMLElement {
	const seekEl = el(container, PLAYER.seek);
	seekEl.getBoundingClientRect = () =>
		({ left: 0, width: 100, top: 0, height: 10 }) as DOMRect;
	seekEl.setPointerCapture = jest.fn();
	seekEl.hasPointerCapture = jest.fn().mockReturnValue(true);
	seekEl.releasePointerCapture = jest.fn();
	return seekEl;
}

function pointerEvent(type: string, clientX: number): MouseEvent {
	// jsdom has no PointerEvent; a MouseEvent with the same type exercises
	// the same listeners (pointerId is undefined, capture calls are mocked)
	return new MouseEvent(type, { button: 0, clientX, bubbles: true });
}

afterEach(() => {
	document.body.innerHTML = '';
});

describe('control row drives the shared audio (PlayerControlsView wiring)', () => {
	it('skip buttons move the shared currentTime by the configured step', () => {
		const audio = makeFakeAudio();
		audio.currentTime = 30;
		const container = makeContainer();
		makePlayer(container, makeRegistry(audio)).onload();

		clickControl(container, `Forward ${String(PLAYER_SKIP_SECONDS)}s`);
		expect(audio.currentTime).toBe(30 + PLAYER_SKIP_SECONDS);

		clickControl(container, `Back ${String(PLAYER_SKIP_SECONDS)}s`);
		expect(audio.currentTime).toBe(30);
	});

	it('mute button toggles the shared muted flag and its active state', () => {
		const audio = makeFakeAudio();
		const container = makeContainer();
		makePlayer(container, makeRegistry(audio)).onload();
		const mute = control(container, 'Mute / unmute');

		mute.click();
		expect(audio.muted).toBe(true);
		expect(mute).toBeActiveControl();

		mute.click();
		expect(audio.muted).toBe(false);
		expect(mute).not.toBeActiveControl();
	});

	it('raising the volume slider unmutes the shared audio', () => {
		const audio = makeFakeAudio();
		audio.muted = true;
		const container = makeContainer();
		makePlayer(container, makeRegistry(audio)).onload();

		const volume = el<HTMLInputElement>(container, PLAYER.volume);
		volume.value = '0.5';
		volume.dispatchEvent(new Event('input'));

		expect(audio.volume).toBe(0.5);
		expect(audio.muted).toBe(false);
	});

	it('loop button toggles the shared loop flag', () => {
		const audio = makeFakeAudio();
		const container = makeContainer();
		makePlayer(container, makeRegistry(audio)).onload();
		const loop = control(container, 'Loop');

		loop.click();
		expect(audio.loop).toBe(true);
		expect(loop).toBeActiveControl();

		loop.click();
		expect(audio.loop).toBe(false);
	});

	it('play button toggles between playing and pausing the shared audio', () => {
		const audio = makeFakeAudio();
		const container = makeContainer();
		makePlayer(container, makeRegistry(audio)).onload();
		const play = control(container, 'Play / pause');

		play.click();
		expect(audio.play).toHaveBeenCalled();
		audio.emit('play');

		play.click();
		expect(audio.pause).toHaveBeenCalled();
	});
});

describe('the controls that hand work back to the player', () => {
	it("the speed button opens the player's own rate menu", () => {
		const container = makeContainer();
		makePlayer(container, makeRegistry(makeFakeAudio())).onload();

		control(container, 'Playback speed').dispatchEvent(
			new MouseEvent('click'),
		);

		expect(menuInstances).toHaveLength(1);
	});

	it('the copy button writes the link the player built', async () => {
		const writeText = jest.fn(() => Promise.resolve(undefined));
		Object.defineProperty(navigator, 'clipboard', {
			configurable: true,
			value: { writeText },
		});
		const audio = makeFakeAudio();
		audio.currentTime = 65;
		const container = makeContainer();
		makePlayer(container, makeRegistry(audio)).onload();

		clickControl(container, 'Copy timestamp link');
		await tick();

		// The link text itself comes from Obsidian's link generator; what
		// the wiring has to get right is that the press reached the player
		// at the position the audio is actually at.
		expect(writeText).toHaveBeenCalledTimes(1);
		expect(noticeMessages()).toContain('Copied timestamp link at 1:05');
	});
});

// Obsidian renders its own <audio> into the same container when it decides
// the embed is a plain one. Two elements means two playheads, so the guard
// removes whichever is not the player's.
describe('a default embed appearing next to the enhanced one', () => {
	it('removes an audio element it did not create', async () => {
		const container = makeContainer();
		makePlayer(container, makeRegistry(makeFakeAudio())).onload();

		container.appendChild(document.createElement('audio'));
		await tick();

		expect(container.querySelectorAll('audio')).toHaveLength(0);
	});

	it('leaves elements that are not audio alone', async () => {
		const container = makeContainer();
		makePlayer(container, makeRegistry(makeFakeAudio())).onload();

		container.appendChild(document.createElement('span'));
		await tick();

		expect(container.querySelectorAll('span')).toHaveLength(1);
	});
});

describe('pointer and keyboard seeking (SeekController wiring)', () => {
	it('a primary-button click seeks the shared audio to the pointer position', () => {
		const audio = makeFakeAudio();
		const registry = makeRegistry(audio);
		const container = makeContainer();
		makePlayer(container, registry).onload();
		const seekEl = seekArea(container);

		seekEl.dispatchEvent(pointerEvent('pointerdown', 40));

		// 40% of a 100s track
		expect(audio.currentTime).toBe(40);
		expect(registry.markAudioEngaged).toHaveBeenCalled();
	});

	it('dragging updates the position across pointermove events', () => {
		const audio = makeFakeAudio();
		const container = makeContainer();
		makePlayer(container, makeRegistry(audio)).onload();
		const seekEl = seekArea(container);

		seekEl.dispatchEvent(pointerEvent('pointerdown', 10));
		expect(audio.currentTime).toBe(10);
		seekEl.dispatchEvent(pointerEvent('pointermove', 70));
		expect(audio.currentTime).toBe(70);
		seekEl.dispatchEvent(pointerEvent('pointerup', 70));
		// After release, a stray move no longer seeks
		seekEl.dispatchEvent(pointerEvent('pointermove', 20));
		expect(audio.currentTime).toBe(70);
	});

	it('a right-click does not seek (context menu stays usable)', () => {
		const audio = makeFakeAudio();
		audio.currentTime = 5;
		const container = makeContainer();
		makePlayer(container, makeRegistry(audio)).onload();
		const seekEl = seekArea(container);

		seekEl.dispatchEvent(
			new MouseEvent('pointerdown', { button: 2, clientX: 40 }),
		);

		expect(audio.currentTime).toBe(5);
	});

	it('arrow keys nudge playback and Home/End jump to the bounds', () => {
		const audio = makeFakeAudio();
		audio.currentTime = 50;
		const container = makeContainer();
		makePlayer(container, makeRegistry(audio)).onload();
		const seekEl = seekArea(container);

		seekEl.dispatchEvent(
			new KeyboardEvent('keydown', { key: 'ArrowRight' }),
		);
		expect(audio.currentTime).toBeGreaterThan(50);

		seekEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home' }));
		expect(audio.currentTime).toBe(0);

		seekEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'End' }));
		expect(audio.currentTime).toBe(100);
	});

	it('keyboard skip engages a pending #t= start first', () => {
		const audio = makeFakeAudio();
		audio.duration = 100;
		const container = makeContainer();
		makePlayer(
			container,
			makeRegistry(audio),
			PLAIN,
			makeMarkerStore(),
			30,
		).onload();
		const seekEl = seekArea(container);

		// The shared element is untouched while the #t=30 hint is display-only
		expect(audio.currentTime).toBe(0);
		seekEl.dispatchEvent(
			new KeyboardEvent('keydown', { key: 'ArrowRight' }),
		);

		// The skip engaged the start (30) and then moved relative to it
		expect(audio.currentTime).toBeGreaterThan(30);
	});
});

describe('infinite-duration resolution (DurationProbe wiring)', () => {
	it('probes a far position on an unusable duration and restores the start on resolution', () => {
		const audio = makeFakeAudio();
		audio.duration = Infinity;
		const container = makeContainer();
		makePlayer(container, makeRegistry(audio)).onload();

		audio.emit('loadedmetadata');
		// The probe seeks far ahead to force the browser to compute a length
		expect(audio.currentTime).toBeGreaterThan(1e100);

		audio.duration = 60;
		audio.emit('durationchange');

		// Resolution restores the start and unlocks the timeline display
		expect(audio.currentTime).toBe(0);
		expect(container).toShowTime('0:00 / 1:00');
	});

	it('also probes a finite-but-zero duration (unstamped container)', () => {
		const audio = makeFakeAudio();
		audio.duration = 0;
		const container = makeContainer();
		makePlayer(container, makeRegistry(audio)).onload();

		audio.emit('loadedmetadata');
		expect(audio.currentTime).toBeGreaterThan(1e100);

		// A durationchange still reporting 0 must NOT end the probe
		audio.emit('durationchange');
		expect(audio.currentTime).toBeGreaterThan(1e100);

		audio.duration = 42;
		audio.emit('durationchange');
		expect(audio.currentTime).toBe(0);
	});

	it('gives up after the watchdog timeout so playback is not stranded', () => {
		jest.useFakeTimers();
		try {
			const audio = makeFakeAudio();
			audio.duration = Infinity;
			const container = makeContainer();
			makePlayer(container, makeRegistry(audio)).onload();

			audio.emit('loadedmetadata');
			expect(audio.currentTime).toBeGreaterThan(1e100);

			jest.advanceTimersByTime(6000);

			expect(audio.currentTime).toBe(0);
		} finally {
			jest.useRealTimers();
		}
	});
});

describe('marker CRUD stays player-driven and persisted (PlayerMarkerController wiring)', () => {
	const WITH_MARKERS: ResolvedPlayerSettings = {
		showWaveform: false,
		enableMarkers: true,
		skipSeconds: 10,
	};

	it('adding a marker from the controls persists it and renders the list', async () => {
		const audio = makeFakeAudio();
		audio.currentTime = 12;
		const store = makeMarkerStore();
		const registry = makeRegistry(audio);
		const container = makeContainer();
		const player = makePlayer(container, registry, WITH_MARKERS, store);
		player.onload();
		await tick();

		clickControl(container, 'Add marker at current position');
		await tick();

		const saved = store.data.get('rec.wav') ?? [];
		expect(saved).toHaveLength(1);
		expect(at(saved, 0).time).toBe(12);
		expect(at(saved, 0).kind).toBe('bookmark');
		// Other live players of the file are refreshed after the persist
		expect(registry.reloadMarkers).toHaveBeenCalledWith('rec.wav', player);
	});

	it('status-bar marker actions reuse the player marker controller', async () => {
		const audio = makeFakeAudio();
		audio.currentTime = 24;
		const store = makeMarkerStore();
		const registry = makeRegistry(audio);
		// Editable (Live Preview) context: marker creation is allowed
		const container = makeEditableContainer();
		makePlayer(container, registry, WITH_MARKERS, store).onload();
		await tick();
		const registration = jest.mocked(registry.registerPlaybackController)
			.mock.calls[0];
		const controller = registration?.[1];

		expect(registration?.[0]).toContain('rec.wav');
		expect(controller?.canAddMarkers()).toBe(true);
		controller?.skip(10);
		expect(audio.currentTime).toBe(34);
		controller?.toggleMute();
		expect(audio.muted).toBe(true);
		controller?.setVolume(0.5);
		expect(audio.volume).toBe(0.5);
		expect(audio.muted).toBe(false);
		controller?.addMarker('chapter');
		await tick();

		const saved = store.data.get('rec.wav') ?? [];
		expect(saved).toHaveLength(1);
		expect(saved[0]).toEqual(
			expect.objectContaining({ time: 34, kind: 'chapter' }),
		);
		controller?.togglePlay();
		expect(audio.play).toHaveBeenCalled();
		controller?.stop();
		expect(audio.pause).toHaveBeenCalled();
		expect(audio.currentTime).toBe(0);
	});

	it('a read-only player reports no marker eligibility to the status bar', async () => {
		const audio = makeFakeAudio();
		audio.currentTime = 24;
		const store = makeMarkerStore();
		const registry = makeRegistry(audio);
		// Reading view: not inside a CodeMirror editor, so it is read-only
		const container = makeContainer();
		makePlayer(container, registry, WITH_MARKERS, store).onload();
		await tick();
		const controller = jest.mocked(registry.registerPlaybackController).mock
			.calls[0]?.[1];

		// Markers are enabled in settings, but the read-only mode still gates
		// the status-bar controls off, exactly as the embedded row and the
		// context menu do. The registry uses this to withhold the add-marker
		// controls, so a read-only view never writes a sidecar (see the real
		// registry proof in tests/integration/PlaybackSync.test.ts).
		expect(controller?.canAddMarkers()).toBe(false);
	});

	it('reloadMarkers re-reads the store so views stay in sync', async () => {
		const audio = makeFakeAudio();
		const store = makeMarkerStore();
		const container = makeContainer();
		const player = makePlayer(
			container,
			makeRegistry(audio),
			WITH_MARKERS,
			store,
		);
		player.onload();
		await tick();

		store.data.set('rec.wav', [
			{ id: 'm1', time: 5, label: 'Marker 1', kind: 'bookmark' },
		]);
		player.reloadMarkers();
		await tick();

		expect(container.textContent).toContain('Marker 1');
	});

	it('chapter navigation buttons jump between persisted chapters', async () => {
		const audio = makeFakeAudio();
		audio.currentTime = 50;
		const store = makeMarkerStore();
		store.data.set('rec.wav', [
			{ id: 'c1', time: 10, label: 'Intro', kind: 'chapter' },
			{ id: 'c2', time: 80, label: 'Outro', kind: 'chapter' },
		]);
		const container = makeContainer();
		makePlayer(
			container,
			makeRegistry(audio),
			WITH_MARKERS,
			store,
		).onload();
		await tick();

		clickControl(container, 'Next chapter');
		expect(audio.currentTime).toBe(80);

		clickControl(container, 'Previous chapter');
		// Shortly after a boundary, previous returns to that boundary's start
		expect(audio.currentTime).toBe(10);
	});

	it('does not render marker controls or load markers when the window is off', async () => {
		const audio = makeFakeAudio();
		const store = makeMarkerStore();
		const container = makeContainer();
		makePlayer(container, makeRegistry(audio), PLAIN, store).onload();
		await tick();

		expect(container).not.toHaveControl('Add marker at current position');
		expect(store.getMarkers).not.toHaveBeenCalled();
	});
});
