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

import { App, Modal } from 'obsidian';
import { AudioPlayer } from 'src/player/AudioPlayer';
import { WaveformPeakCache, type AudioDecoder } from 'src/player/WaveformData';
import type { AudioPlayerRegistry } from 'src/player/AudioPlayerRegistry';
import type { RecordingSidecarStore } from 'src/sidecar/RecordingSidecarStore';
import type { ResolvedPlayerSettings } from 'src/player/playerSettings';
import type { PlayerMarker } from 'src/markers/markerModel';
import { PLAYER_SKIP_SECONDS } from 'src/constants';
import type { TFile } from 'obsidian';

type Listener = () => void;

interface FakeAudio {
	paused: boolean;
	loop: boolean;
	playbackRate: number;
	volume: number;
	muted: boolean;
	currentTime: number;
	duration: number;
	readyState: number;
	play: jest.Mock;
	pause: jest.Mock;
	addEventListener: (type: string, cb: Listener) => void;
	removeEventListener: (type: string, cb: Listener) => void;
	emit: (type: string) => void;
}

function makeFakeAudio(): FakeAudio {
	const handlers = new Map<string, Set<Listener>>();
	const audio: FakeAudio = {
		paused: true,
		loop: false,
		playbackRate: 1,
		volume: 1,
		muted: false,
		currentTime: 0,
		duration: 100,
		readyState: 1,
		play: jest.fn(() => {
			audio.paused = false;
			return Promise.resolve();
		}),
		pause: jest.fn(() => {
			audio.paused = true;
		}),
		addEventListener: (type, cb) => {
			const set = handlers.get(type) ?? new Set<Listener>();
			set.add(cb);
			handlers.set(type, set);
		},
		removeEventListener: (type, cb) => {
			handlers.get(type)?.delete(cb);
		},
		emit: (type) => {
			handlers.get(type)?.forEach((cb) => {
				cb();
			});
		},
	};
	return audio;
}

function makeRegistry(...audios: FakeAudio[]): AudioPlayerRegistry {
	const entries = new Map<string, { audio: FakeAudio; engaged: boolean }>();
	let nextAudio = 0;
	return {
		acquireAudio: jest.fn((key: string) => {
			const existing = entries.get(key);
			if (existing) {
				return {
					audio: existing.audio as unknown as HTMLAudioElement,
					isNew: false,
				};
			}
			const audio = audios[nextAudio] ?? makeFakeAudio();
			nextAudio += 1;
			entries.set(key, { audio, engaged: false });
			return { audio: audio as unknown as HTMLAudioElement, isNew: true };
		}),
		releaseAudio: jest.fn(),
		register: jest.fn(),
		unregister: jest.fn(),
		reloadMarkers: jest.fn(),
		seek: jest.fn(),
		applySettings: jest.fn(),
		clear: jest.fn(),
		registerPlaybackController: jest.fn(() => jest.fn()),
		subscribePlayback: jest.fn(() => jest.fn()),
		markAudioEngaged: jest.fn((key: string) => {
			const entry = entries.get(key);
			if (entry) {
				entry.engaged = true;
			}
		}),
		isAudioEngaged: jest.fn(
			(key: string) => entries.get(key)?.engaged ?? false,
		),
	};
}

const app = {
	vault: {
		getResourcePath: () => 'app://media',
		readBinary: () => Promise.resolve(new ArrayBuffer(0)),
	},
	fileManager: {
		generateMarkdownLink: () => '[[rec.webm]]',
	},
} as unknown as App;

const decoder: AudioDecoder = {
	decode: () => Promise.reject(new Error('no decode in tests')),
};

/** An in-memory marker store the tests can inspect. */
function makeMarkerStore(): RecordingSidecarStore & {
	data: Map<string, PlayerMarker[]>;
} {
	const data = new Map<string, PlayerMarker[]>();
	return {
		data,
		getMarkers: jest.fn((path: string) =>
			Promise.resolve([...(data.get(path) ?? [])]),
		),
		updateMarkers: jest.fn(
			(
				path: string,
				change: (
					existing: readonly PlayerMarker[],
				) => readonly PlayerMarker[],
			) => {
				const merged = [...change(data.get(path) ?? [])];
				data.set(path, merged);
				return Promise.resolve(merged);
			},
		),
	} as unknown as RecordingSidecarStore & {
		data: Map<string, PlayerMarker[]>;
	};
}

function makeFile(size = 1000, extension = 'webm'): TFile {
	return {
		path: `rec.${extension}`,
		extension,
		stat: { mtime: 1, size },
	} as unknown as TFile;
}

function makeContainer(): HTMLElement {
	const el = new Modal(new App()).contentEl.createDiv();
	document.body.appendChild(el);
	return el;
}

/**
 * A container nested in a CodeMirror editor, so the player resolves to the
 * editable (Live Preview) mode where marker creation is allowed.
 */
function makeEditableContainer(): HTMLElement {
	const editor = makeContainer();
	editor.addClass('cm-editor');
	return editor.createDiv();
}

const PLAIN: ResolvedPlayerSettings = {
	showWaveform: false,
	enableMarkers: false,
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
	const seekEl = container.querySelector<HTMLElement>('.aar-player-seek');
	if (!seekEl) {
		throw new Error('seek area not rendered');
	}
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

const tick = (): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
	document.body.innerHTML = '';
	jest.clearAllMocks();
});

describe('control row drives the shared audio (PlayerControlsView wiring)', () => {
	it('skip buttons move the shared currentTime by the configured step', () => {
		const audio = makeFakeAudio();
		audio.currentTime = 30;
		const container = makeContainer();
		makePlayer(container, makeRegistry(audio)).onload();

		container
			.querySelector<HTMLElement>(
				`[aria-label="Forward ${String(PLAYER_SKIP_SECONDS)}s"]`,
			)
			?.click();
		expect(audio.currentTime).toBe(30 + PLAYER_SKIP_SECONDS);

		container
			.querySelector<HTMLElement>(
				`[aria-label="Back ${String(PLAYER_SKIP_SECONDS)}s"]`,
			)
			?.click();
		expect(audio.currentTime).toBe(30);
	});

	it('mute button toggles the shared muted flag and its active state', () => {
		const audio = makeFakeAudio();
		const container = makeContainer();
		makePlayer(container, makeRegistry(audio)).onload();
		const mute = container.querySelector<HTMLElement>(
			'[aria-label="Mute / unmute"]',
		);

		mute?.click();
		expect(audio.muted).toBe(true);
		expect(mute?.classList.contains('is-active')).toBe(true);

		mute?.click();
		expect(audio.muted).toBe(false);
		expect(mute?.classList.contains('is-active')).toBe(false);
	});

	it('raising the volume slider unmutes the shared audio', () => {
		const audio = makeFakeAudio();
		audio.muted = true;
		const container = makeContainer();
		makePlayer(container, makeRegistry(audio)).onload();

		const volume =
			container.querySelector<HTMLInputElement>('.aar-player-volume');
		if (!volume) {
			throw new Error('volume slider not rendered');
		}
		volume.value = '0.5';
		volume.dispatchEvent(new Event('input'));

		expect(audio.volume).toBe(0.5);
		expect(audio.muted).toBe(false);
	});

	it('loop button toggles the shared loop flag', () => {
		const audio = makeFakeAudio();
		const container = makeContainer();
		makePlayer(container, makeRegistry(audio)).onload();
		const loop = container.querySelector<HTMLElement>(
			'[aria-label="Loop"]',
		);

		loop?.click();
		expect(audio.loop).toBe(true);
		expect(loop?.classList.contains('is-active')).toBe(true);

		loop?.click();
		expect(audio.loop).toBe(false);
	});

	it('play button toggles between playing and pausing the shared audio', () => {
		const audio = makeFakeAudio();
		const container = makeContainer();
		makePlayer(container, makeRegistry(audio)).onload();
		const play = container.querySelector<HTMLElement>(
			'[aria-label="Play / pause"]',
		);

		play?.click();
		expect(audio.play).toHaveBeenCalled();
		audio.emit('play');

		play?.click();
		expect(audio.pause).toHaveBeenCalled();
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
		expect(container.querySelector('.aar-player-time')?.textContent).toBe(
			'0:00 / 1:00',
		);
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

		container
			.querySelector<HTMLElement>(
				'[aria-label="Add marker at current position"]',
			)
			?.click();
		await tick();

		const saved = store.data.get('rec.wav') ?? [];
		expect(saved).toHaveLength(1);
		expect(saved[0].time).toBe(12);
		expect(saved[0].kind).toBe('bookmark');
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

		container
			.querySelector<HTMLElement>('[aria-label="Next chapter"]')
			?.click();
		expect(audio.currentTime).toBe(80);

		container
			.querySelector<HTMLElement>('[aria-label="Previous chapter"]')
			?.click();
		// Shortly after a boundary, previous returns to that boundary's start
		expect(audio.currentTime).toBe(10);
	});

	it('does not render marker controls or load markers when the window is off', async () => {
		const audio = makeFakeAudio();
		const store = makeMarkerStore();
		const container = makeContainer();
		makePlayer(container, makeRegistry(audio), PLAIN, store).onload();
		await tick();

		expect(
			container.querySelector(
				'[aria-label="Add marker at current position"]',
			),
		).toBeNull();
		expect(store.getMarkers).not.toHaveBeenCalled();
	});
});
