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
import { allEls } from '../helpers/dom';
import { MARKER } from '../helpers/selectors';
import { AudioPlayer } from 'src/player/AudioPlayer';
import {
	AudioPlayerRegistry,
	playbackKey,
} from 'src/player/AudioPlayerRegistry';
import { WaveformPeakCache, type AudioDecoder } from 'src/player/WaveformData';
import type { RecordingSidecarStore } from 'src/sidecar/RecordingSidecarStore';
import type { PlayerMarker } from 'src/markers/markerModel';
import type { ResolvedPlayerSettings } from 'src/player/playerSettings';
import type { PlaybackControlsState } from 'src/player/playbackControls';
import type { TFile } from 'obsidian';
import {
	installSharedAudio,
	makeMarkerStore,
	timeText,
	tick,
} from '../helpers/playbackHarness';
import { partialApp } from '../helpers/obsidianMock';
import { partial } from '../helpers/doubles';

const app = partialApp({
	vault: {
		getResourcePath: () => 'app://media',
		readBinary: () => Promise.resolve(new ArrayBuffer(0)),
	},
	fileManager: { generateMarkdownLink: () => '[[rec.mp4]]' },
});

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

function makeFile(): TFile {
	return partial<TFile>({
		path: 'rec.mp4',
		extension: 'mp4',
		stat: { mtime: 1, size: 1000 },
	});
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
	store: RecordingSidecarStore,
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

afterEach(() => {
	document.body.innerHTML = '';
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
			expect(store.updateMarkers).not.toHaveBeenCalled();
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
			expect(store.updateMarkers).toHaveBeenCalled();
		} finally {
			shared.restore();
		}
	});
});

/** Two generated chapters, as written to a recording's marker sidecar. */
const CHAPTERS: PlayerMarker[] = [
	{ id: 'auto-chapter-1', time: 0, label: 'Intro', kind: 'chapter' },
	{ id: 'auto-chapter-2', time: 120, label: 'Middle', kind: 'chapter' },
];

/** Reads the chapter labels the player rendered, in list order. */
function markerLabels(container: HTMLElement): string[] {
	return allEls(container, MARKER.label).map(
		(label) => label.getAttribute('value') ?? '',
	);
}

describe('generated chapters reach an already-open player', () => {
	it('shows chapters in an open Live Preview player after an external write', async () => {
		const shared = installSharedAudio();
		try {
			const registry = new AudioPlayerRegistry();
			const store = makeMarkerStore();
			// Live Preview container (inside a CodeMirror editor)
			const container = makeEditableContainer();
			mountMarkerPlayer(registry, store, container);
			await tick();
			shared.audio.setReady(1);
			shared.audio.setDuration(600);

			// Auto chapters write the sidecar, then the registrar reloads
			// every open player of the file through the shared marker-reload
			// path (source is null: the write came from outside any player)
			await store.updateMarkers('rec.mp4', () => CHAPTERS);
			registry.reloadMarkers('rec.mp4', null);
			await tick();

			// The open embed shows the chapters at once, without a re-mount
			expect(allEls(container, MARKER.row)).toHaveLength(2);
			expect(markerLabels(container)).toEqual(['Intro', 'Middle']);
		} finally {
			shared.restore();
		}
	});

	it('recovers chapters written while the Live Preview widget was detached', async () => {
		const shared = installSharedAudio();
		try {
			const registry = new AudioPlayerRegistry();
			const store = makeMarkerStore();
			const container = makeEditableContainer();
			mountMarkerPlayer(registry, store, container);
			await tick();
			shared.audio.setReady(1);
			shared.audio.setDuration(600);

			// Live Preview detaches the embed's widget while the async
			// generation runs, so the reload lands on a disconnected player
			const parent = container.parentElement as HTMLElement;
			container.remove();
			expect(container.isConnected).toBe(false);

			await store.updateMarkers('rec.mp4', () => CHAPTERS);
			registry.reloadMarkers('rec.mp4', null);
			await tick();

			// Obsidian reattaches the same widget DOM: the chapters written
			// while it was detached must be there, not a stale empty list
			parent.appendChild(container);
			expect(container.isConnected).toBe(true);
			expect(allEls(container, MARKER.row)).toHaveLength(2);
			expect(markerLabels(container)).toEqual(['Intro', 'Middle']);
		} finally {
			shared.restore();
		}
	});
});
