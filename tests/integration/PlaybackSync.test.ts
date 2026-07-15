/**
 * Cross-surface playback sync guards. These drive the REAL AudioPlayer and the
 * REAL AudioPlayerRegistry against one shared audio element (the global Audio
 * factory is stubbed so both bind to the same controllable element), so a
 * regression that lets a timecode seek, a second view of the file, or the
 * status bar drift onto a different element - the "plays but the embed shows
 * 0:00" class of bug - fails here instead of only in Obsidian.
 * @jest-environment jsdom
 */

import { App, Modal } from 'obsidian';
import { AudioPlayer } from 'src/player/AudioPlayer';
import {
	AudioPlayerRegistry,
	playbackKey,
} from 'src/player/AudioPlayerRegistry';
import { WaveformPeakCache, type AudioDecoder } from 'src/player/WaveformData';
import type { MarkerStore } from 'src/markers/MarkerStore';
import type { PlayerMarker } from 'src/markers/markerModel';
import type { ResolvedPlayerSettings } from 'src/player/playerSettings';
import type { PlaybackControlsState } from 'src/player/playbackControls';
import type { TFile } from 'obsidian';

/** Controllable audio element whose setters emit the matching media events. */
interface ControllableAudio extends HTMLAudioElement {
	/** Sets the reported readyState so metadata can be made available late. */
	setReady(value: number): void;
	/** Sets the duration and emits durationchange, as a real load would. */
	setDuration(value: number): void;
}

/**
 * Installs one deterministic audio element as the global Audio factory, so the
 * registry's `new Audio()` and every player bind to the same element.
 * @returns The shared element with test-only mutators
 */
function installSharedAudio(): {
	audio: ControllableAudio;
	restore(): void;
} {
	const el = document.createElement('audio') as ControllableAudio;
	let paused = true;
	let currentTime = 0;
	let duration = NaN;
	let ready = 0;
	Object.defineProperties(el, {
		paused: { configurable: true, get: () => paused },
		currentTime: {
			configurable: true,
			get: () => currentTime,
			set: (value: number) => {
				currentTime = value;
				el.dispatchEvent(new Event('timeupdate'));
			},
		},
		duration: { configurable: true, get: () => duration },
		readyState: { configurable: true, get: () => ready },
	});
	jest.spyOn(el, 'play').mockImplementation(() => {
		paused = false;
		el.dispatchEvent(new Event('play'));
		return Promise.resolve();
	});
	jest.spyOn(el, 'pause').mockImplementation(() => {
		paused = true;
		el.dispatchEvent(new Event('pause'));
	});
	jest.spyOn(el, 'load').mockImplementation(() => undefined);
	el.setReady = (value: number) => {
		ready = value;
	};
	el.setDuration = (value: number) => {
		duration = value;
		el.dispatchEvent(new Event('durationchange'));
	};
	const factory = jest
		.spyOn(globalThis, 'Audio')
		.mockImplementation(() => el);
	return {
		audio: el,
		restore: () => {
			factory.mockRestore();
		},
	};
}

const app = {
	vault: {
		getResourcePath: () => 'app://media',
		readBinary: () => Promise.resolve(new ArrayBuffer(0)),
	},
	fileManager: { generateMarkdownLink: () => '[[rec.mp4]]' },
} as unknown as App;

const decoder: AudioDecoder = {
	decode: () => Promise.reject(new Error('no decode in tests')),
};

const PLAIN: ResolvedPlayerSettings = {
	showWaveform: false,
	enableMarkers: false,
};

const WITH_MARKERS: ResolvedPlayerSettings = {
	showWaveform: false,
	enableMarkers: true,
};

/** In-memory marker store the players can read without persistence. */
function makeMarkerStore(): MarkerStore {
	const data = new Map<string, PlayerMarker[]>();
	return {
		get: jest.fn((path: string) => Promise.resolve(data.get(path) ?? [])),
		set: jest.fn((path: string, markers: PlayerMarker[]) => {
			data.set(path, markers);
			return Promise.resolve();
		}),
	} as unknown as MarkerStore;
}

function makeFile(): TFile {
	return {
		path: 'rec.mp4',
		extension: 'mp4',
		stat: { mtime: 1, size: 1000 },
	} as unknown as TFile;
}

function makeContainer(): HTMLElement {
	const el = new Modal(new App()).contentEl.createDiv();
	document.body.appendChild(el);
	return el;
}

/** Mounts a real AudioPlayer for the file into a fresh container. */
function mountPlayer(registry: AudioPlayerRegistry): HTMLElement {
	const container = makeContainer();
	new AudioPlayer(
		container,
		app,
		makeFile(),
		PLAIN,
		registry,
		new WaveformPeakCache(),
		decoder,
		makeMarkerStore(),
		{ startSeconds: null, sourcePath: 'note.md', immediate: true },
	).onload();
	return container;
}

/** A container nested in a CodeMirror editor, so the player is editable. */
function makeEditableContainer(): HTMLElement {
	const editor = makeContainer();
	editor.addClass('cm-editor');
	return editor.createDiv();
}

/** Mounts a markers-enabled real AudioPlayer into the given container. */
function mountMarkerPlayer(
	registry: AudioPlayerRegistry,
	store: MarkerStore,
	container: HTMLElement,
): void {
	new AudioPlayer(
		container,
		app,
		makeFile(),
		WITH_MARKERS,
		registry,
		new WaveformPeakCache(),
		decoder,
		store,
		{ startSeconds: null, sourcePath: 'note.md', immediate: true },
	).onload();
}

/** Reads the elapsed / total text the player renders. */
function timeText(container: HTMLElement): string {
	return container.querySelector('.aar-player-time')?.textContent ?? '';
}

const tick = (): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
	document.body.innerHTML = '';
	jest.restoreAllMocks();
});

describe('timecode seek stays in sync with the embedded player', () => {
	it('reuses the embed element so a seek moves the visible time display', async () => {
		const shared = installSharedAudio();
		try {
			const registry = new AudioPlayerRegistry();
			const container = mountPlayer(registry);
			await tick();
			// Metadata arrives with a real duration
			shared.audio.setReady(1);
			shared.audio.setDuration(3600);

			// A timecode click with no connected player still reuses the file's
			// one shared element instead of spawning a second, silent one
			expect(
				registry.seekSharedAudio(playbackKey('rec.mp4', null), 1800),
			).toBe(true);

			// The embed reflects the seek: it was on the same element all along
			// (a one-hour total formats as h:mm:ss, matching the real player)
			expect(timeText(container)).toBe('0:30:00 / 1:00:00');
			expect(shared.audio.paused).toBe(false);
		} finally {
			shared.restore();
		}
	});

	it('keeps two views of one file on a single playback', async () => {
		const shared = installSharedAudio();
		try {
			const registry = new AudioPlayerRegistry();
			const reading = mountPlayer(registry);
			const editing = mountPlayer(registry);
			await tick();
			shared.audio.setReady(1);
			shared.audio.setDuration(600);

			registry.seekSharedAudio(playbackKey('rec.mp4', null), 120);

			// Both embeds share the one element, so both show the same position
			expect(timeText(reading)).toBe('2:00 / 10:00');
			expect(timeText(editing)).toBe('2:00 / 10:00');
		} finally {
			shared.restore();
		}
	});

	it('publishes the same playback to the status bar', async () => {
		const shared = installSharedAudio();
		try {
			const registry = new AudioPlayerRegistry();
			const snapshots: (PlaybackControlsState | null)[] = [];
			registry.subscribePlayback((state) => {
				snapshots.push(state);
			});
			mountPlayer(registry);
			await tick();
			shared.audio.setReady(1);
			shared.audio.setDuration(600);

			registry.seekSharedAudio(playbackKey('rec.mp4', null), 90);

			const latest = snapshots[snapshots.length - 1];
			expect(latest).toEqual(
				expect.objectContaining({
					currentTime: 90,
					duration: 600,
					paused: false,
				}),
			);
		} finally {
			shared.restore();
		}
	});
});

describe('status-bar markers follow the player edit mode', () => {
	it('withholds markers and persists nothing for a read-only player', async () => {
		const shared = installSharedAudio();
		try {
			const registry = new AudioPlayerRegistry();
			const snapshots: (PlaybackControlsState | null)[] = [];
			registry.subscribePlayback((state) => {
				snapshots.push(state);
			});
			// Reading view container (not inside a CodeMirror editor)
			const store = makeMarkerStore();
			mountMarkerPlayer(registry, store, makeContainer());
			await tick();
			shared.audio.setReady(1);
			shared.audio.setDuration(600);

			registry.seekSharedAudio(playbackKey('rec.mp4', null), 30);

			const state = snapshots[snapshots.length - 1];
			expect(state?.markersEnabled).toBe(false);
			// A stale add-marker command must not write a sidecar from a
			// read-only view
			state?.onAddMarker('bookmark');
			await tick();
			expect(store.set).not.toHaveBeenCalled();
		} finally {
			shared.restore();
		}
	});

	it('offers markers and persists them for an editable player', async () => {
		const shared = installSharedAudio();
		try {
			const registry = new AudioPlayerRegistry();
			const snapshots: (PlaybackControlsState | null)[] = [];
			registry.subscribePlayback((state) => {
				snapshots.push(state);
			});
			// Live Preview container (inside a CodeMirror editor)
			const store = makeMarkerStore();
			mountMarkerPlayer(registry, store, makeEditableContainer());
			await tick();
			shared.audio.setReady(1);
			shared.audio.setDuration(600);

			registry.seekSharedAudio(playbackKey('rec.mp4', null), 42);

			const state = snapshots[snapshots.length - 1];
			expect(state?.markersEnabled).toBe(true);
			state?.onAddMarker('chapter');
			await tick();
			expect(store.set).toHaveBeenCalled();
		} finally {
			shared.restore();
		}
	});
});
