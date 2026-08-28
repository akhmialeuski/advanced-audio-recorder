/**
 * Cross-surface playback sync guards. These drive the REAL AudioPlayer and the
 * REAL AudioPlayerRegistry against one shared audio element (the global Audio
 * factory is stubbed so both bind to the same controllable element), so a
 * regression that lets a timecode seek, a second view of the file, or the
 * status bar drift onto a different element - the "plays but the embed shows
 * 0:00" class of bug - fails here instead of only in Obsidian. The palette
 * commands are driven the same way, through the mock plugin's command
 * registry, so a hotkey and a click on the control row are proven to reach
 * the one element.
 * @jest-environment jsdom
 */

import { App, Modal } from 'obsidian';
import { menuInstances } from '../mocks/obsidian';
import { at } from '../helpers/assertions';
import { allEls, control, el } from '../helpers/dom';
import { MARKER, PLAYER } from '../helpers/selectors';
import { PLAYBACK_ACTIONS } from 'src/actions/playbackActions';
import { registerActionCommands } from 'src/actions/registerActionCommands';
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
import { partial } from '../helpers/doubles';
import { asMockPlugin, mockPluginHost } from '../helpers/obsidianMock';
import { createMockApp } from '../helpers/createApp';

const app = createMockApp({
	vault: {
		getResourcePath: () => 'app://media',
		readBinary: () => Promise.resolve(new ArrayBuffer(0)),
	},
	fileManager: { generateMarkdownLink: () => '[[rec.mp4]]' },
}).app;

const decoder: AudioDecoder = {
	decode: () => Promise.reject(new Error('no decode in tests')),
};

const PLAIN: ResolvedPlayerSettings = {
	showWaveform: false,
	enableMarkers: false,
	skipSeconds: 10,
};

const WITH_MARKERS: ResolvedPlayerSettings = {
	showWaveform: false,
	enableMarkers: true,
	skipSeconds: 10,
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

/**
 * Mounts a real AudioPlayer for the file into a fresh container.
 * @param registry - The registry the player binds its shared element through
 * @param store - Sidecar the player reads and writes; its own by default
 * @param startSeconds - The embed's #t= offset, absent by default
 * @returns The container the player rendered into
 */
function mountPlayer(
	registry: AudioPlayerRegistry,
	store: RecordingSidecarStore = makeMarkerStore(),
	startSeconds: number | null = null,
): HTMLElement {
	const container = makeContainer();
	new AudioPlayer(
		container,
		app,
		makeFile(),
		PLAIN,
		registry,
		new WaveformPeakCache(),
		decoder,
		store,
		{ startSeconds, sourcePath: 'note.md', immediate: true },
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

/**
 * Registers the real playback commands the way the plugin does at load: they
 * pull the live playback from the registry on every check. A subscriber
 * records what the status bar is pushed alongside, so a case can assert that
 * the two agree instead of assuming it.
 * @param registry - The registry publishing the active playback
 * @returns The plugin holding the commands and a reader for what was pushed
 */
function withPlaybackCommands(registry: AudioPlayerRegistry): {
	plugin: ReturnType<typeof asMockPlugin>;
	snapshot: () => PlaybackControlsState | null;
} {
	const plugin = mockPluginHost(app);
	let latest: PlaybackControlsState | null = null;
	registry.subscribePlayback((state) => {
		latest = state;
	});
	registerActionCommands(plugin, PLAYBACK_ACTIONS, () =>
		registry.currentPlaybackState(),
	);
	return { plugin: asMockPlugin(plugin), snapshot: () => latest };
}

/**
 * The arrangement every playback-command case opens with: a player mounted on
 * the shared element, the real commands over the same registry, and playback
 * parked at a known position.
 * @param shared - The installed shared audio element
 * @returns The player's container, the command host, and a reader for what
 *   the status bar was pushed
 */
async function playingEmbed(
	shared: ReturnType<typeof installSharedAudio>,
): Promise<{
	container: HTMLElement;
	plugin: ReturnType<typeof asMockPlugin>;
	snapshot: () => PlaybackControlsState | null;
}> {
	const registry = new AudioPlayerRegistry();
	const { plugin, snapshot } = withPlaybackCommands(registry);
	const container = mountPlayer(registry);
	await tick();
	startPlaybackAt(registry, shared.audio, 30);
	return { container, plugin, snapshot };
}

/** Starts the shared playback and parks it at a known position. */
function startPlaybackAt(
	registry: AudioPlayerRegistry,
	audio: { setReady(value: number): void; setDuration(value: number): void },
	seconds: number,
): void {
	audio.setReady(1);
	audio.setDuration(600);
	registry.seekSharedAudio(playbackKey('rec.mp4', null), seconds);
}

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
			// The marker is written against the recording the status bar is
			// controlling, not whatever file happens to be open.
			expect(store.updateMarkers).toHaveBeenCalledWith(
				'rec.mp4',
				expect.any(Function),
			);
		} finally {
			shared.restore();
		}
	});
});

/** Chapters that leave the opening of the recording uncovered. */
const LATE_CHAPTERS: PlayerMarker[] = [
	{ id: 'late-chapter-1', time: 120, label: 'Body', kind: 'chapter' },
	{ id: 'late-chapter-2', time: 300, label: 'Close', kind: 'chapter' },
];

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

describe('playback commands drive the same playback as the controls', () => {
	it('offers no command while nothing is playing', () => {
		const registry = new AudioPlayerRegistry();
		const { plugin } = withPlaybackCommands(registry);

		const ids = plugin.registeredCommands.map((command) => command.id);

		// Every playback command is registered, and every one of them reports
		// itself unavailable, so none reaches the palette or fires a hotkey
		expect(ids).toHaveLength(12);
		expect(ids.filter((id) => plugin.invokeCommand(id))).toEqual([]);
	});

	it('pauses the shared element and the status-bar snapshot together', async () => {
		const shared = installSharedAudio();
		try {
			const { plugin, snapshot } = await playingEmbed(shared);

			expect(plugin.invokeCommand('toggle-playback')).toBe(true);

			expect(shared.audio.paused).toBe(true);
			expect(snapshot()?.paused).toBe(true);
		} finally {
			shared.restore();
		}
	});

	it('withdraws the commands once playback is stopped', async () => {
		const shared = installSharedAudio();
		try {
			const { plugin } = await playingEmbed(shared);

			expect(plugin.invokeCommand('stop-playback')).toBe(true);

			// Stop dismisses the controls, so the hotkeys go quiet with them
			expect(plugin.invokeCommand('toggle-playback')).toBe(false);
		} finally {
			shared.restore();
		}
	});

	it('steps the speed on the element, the embed, and the snapshot', async () => {
		const shared = installSharedAudio();
		try {
			const { container, plugin, snapshot } = await playingEmbed(shared);

			expect(plugin.invokeCommand('increase-playback-speed')).toBe(true);

			// One step lands on the preset the embed's own speed menu offers,
			// and all three surfaces report it
			expect(shared.audio.playbackRate).toBe(1.25);
			expect(el(container, PLAYER.speed).textContent).toBe('1.25x');
			expect(snapshot()?.playbackRate).toBe(1.25);

			expect(plugin.invokeCommand('decrease-playback-speed')).toBe(true);
			expect(shared.audio.playbackRate).toBe(1);
			expect(el(container, PLAYER.speed).textContent).toBe('1x');
		} finally {
			shared.restore();
		}
	});

	it('steps the speed on from where the embed menu left it', async () => {
		const shared = installSharedAudio();
		try {
			const { container, plugin, snapshot } = await playingEmbed(shared);
			shared.audio.pause();

			// The speed is raised from the embed's own menu, which writes the
			// element and tells no surface about it
			el(container, PLAYER.speed).click();
			at(menuInstances, menuInstances.length - 1)
				.items.find((item) => item.title === '2x')
				?.click();

			expect(shared.audio.playbackRate).toBe(2);
			// The status bar hears about it all the same, with no command run
			expect(snapshot()?.playbackRate).toBe(2);

			expect(plugin.invokeCommand('increase-playback-speed')).toBe(true);

			// One preset on from 2x, not from the speed playback started at
			expect(shared.audio.playbackRate).toBe(2.5);
			expect(el(container, PLAYER.speed).textContent).toBe('2.5x');
			expect(snapshot()?.playbackRate).toBe(2.5);
		} finally {
			shared.restore();
		}
	});

	it('jumps to a chapter in the embed and the snapshot', async () => {
		const shared = installSharedAudio();
		try {
			const registry = new AudioPlayerRegistry();
			const { plugin, snapshot } = withPlaybackCommands(registry);
			const store = makeMarkerStore();
			const container = makeEditableContainer();
			mountMarkerPlayer(registry, store, container);
			await tick();
			await store.updateMarkers('rec.mp4', () => CHAPTERS);
			registry.reloadMarkers('rec.mp4', null);
			await tick();
			startPlaybackAt(registry, shared.audio, 30);

			expect(plugin.invokeCommand('go-to-next-chapter')).toBe(true);

			// The chapter at 2:00 is reached on the one shared element, so the
			// embed display and the status-bar snapshot agree
			expect(timeText(container)).toBe('2:00 / 10:00');
			expect(snapshot()?.currentTime).toBe(120);

			expect(plugin.invokeCommand('go-to-previous-chapter')).toBe(true);
			expect(timeText(container)).toBe('0:00 / 10:00');
		} finally {
			shared.restore();
		}
	});

	it('hides the chapter commands for a player without markers', async () => {
		const shared = installSharedAudio();
		try {
			const { plugin } = await playingEmbed(shared);

			// Markers are off for this player, so it defines no chapters to
			// navigate, while the transport commands stay available
			expect(plugin.invokeCommand('go-to-next-chapter')).toBe(false);
			expect(plugin.invokeCommand('go-to-previous-chapter')).toBe(false);
			expect(plugin.invokeCommand('skip-playback-forward')).toBe(true);
		} finally {
			shared.restore();
		}
	});

	it('withholds the marker commands from a read-only player', async () => {
		const shared = installSharedAudio();
		try {
			const registry = new AudioPlayerRegistry();
			const { plugin } = withPlaybackCommands(registry);
			const store = makeMarkerStore();
			// Reading view container (not inside a CodeMirror editor)
			mountMarkerPlayer(registry, store, makeContainer());
			await tick();
			startPlaybackAt(registry, shared.audio, 30);

			expect(plugin.invokeCommand('add-playback-bookmark')).toBe(false);
			expect(plugin.invokeCommand('add-playback-chapter')).toBe(false);
			await tick();
			expect(store.updateMarkers).not.toHaveBeenCalled();

			// Chapter navigation only reads the markers, so it survives where
			// creating one does not
			expect(plugin.invokeCommand('go-to-next-chapter')).toBe(true);
		} finally {
			shared.restore();
		}
	});

	it('adds a marker at the playing position from an editable player', async () => {
		const shared = installSharedAudio();
		try {
			const registry = new AudioPlayerRegistry();
			const { plugin } = withPlaybackCommands(registry);
			const store = makeMarkerStore();
			// Live Preview container (inside a CodeMirror editor)
			const container = makeEditableContainer();
			mountMarkerPlayer(registry, store, container);
			await tick();
			startPlaybackAt(registry, shared.audio, 42);

			expect(plugin.invokeCommand('add-playback-bookmark')).toBe(true);
			await tick();

			// The marker lands on the recording the command was offered for,
			// at the position the embed is showing
			expect(store.updateMarkers).toHaveBeenCalledWith(
				'rec.mp4',
				expect.any(Function),
			);
			expect(container).toHaveMarkerAt(42);
		} finally {
			shared.restore();
		}
	});
});

describe('resuming where a recording was left off', () => {
	/**
	 * A store already holding a position for the recording, as an earlier
	 * listening session would have left it.
	 * @param position - The remembered offset in seconds
	 * @returns The store double, with the position in place
	 */
	function storeHolding(
		position: number,
	): ReturnType<typeof makeMarkerStore> {
		const store = makeMarkerStore();
		store.positions.set('rec.mp4', position);
		return store;
	}

	/** A shared element that already knows how long the recording is. */
	function loadedAudio(): ReturnType<typeof installSharedAudio> {
		const shared = installSharedAudio();
		shared.audio.setReady(1);
		shared.audio.setDuration(600);
		return shared;
	}

	it('starts the embed at the stored position, on the shared element', async () => {
		const shared = loadedAudio();
		try {
			const registry = new AudioPlayerRegistry();
			const { snapshot } = withPlaybackCommands(registry);
			const container = mountPlayer(registry, storeHolding(300));
			await tick();

			// The one shared element carries the resumed position, so the
			// embed display and the status-bar snapshot show it alike
			expect(timeText(container)).toBe('5:00 / 10:00');
			expect(shared.audio.paused).toBe(true);
			startPlaybackAt(registry, shared.audio, 300);
			expect(snapshot()?.currentTime).toBe(300);
		} finally {
			shared.restore();
		}
	});

	it('lets an explicit position in the embed outrank the stored one', async () => {
		const shared = loadedAudio();
		try {
			const registry = new AudioPlayerRegistry();
			const container = mountPlayer(registry, storeHolding(300), 42);
			await tick();

			// The #t= offset is what the link asked for, so the remembered
			// position does not touch the element
			expect(shared.audio.currentTime).toBe(0);
			expect(timeText(container)).toBe('0:42 / 10:00');
		} finally {
			shared.restore();
		}
	});

	it('leaves playback that is already under way where it stands', async () => {
		const shared = loadedAudio();
		try {
			const registry = new AudioPlayerRegistry();
			// The element is already part-way through when the embed mounts,
			// which is a listener the resume must not move
			shared.audio.currentTime = 100;
			const container = mountPlayer(registry, storeHolding(300));
			await tick();

			expect(timeText(container)).toBe('1:40 / 10:00');
		} finally {
			shared.restore();
		}
	});

	it('remembers the position when playback pauses', async () => {
		const shared = loadedAudio();
		try {
			const registry = new AudioPlayerRegistry();
			const store = makeMarkerStore();
			mountPlayer(registry, store);
			await tick();
			startPlaybackAt(registry, shared.audio, 300);

			shared.audio.dispatchEvent(new Event('pause'));
			await tick();

			expect(store.positions.get('rec.mp4')).toBe(300);
		} finally {
			shared.restore();
		}
	});

	it('forgets the position once the recording has been heard out', async () => {
		const shared = loadedAudio();
		try {
			const registry = new AudioPlayerRegistry();
			const store = storeHolding(300);
			mountPlayer(registry, store);
			await tick();

			shared.audio.dispatchEvent(new Event('ended'));
			await tick();

			expect(store.positions.has('rec.mp4')).toBe(false);
		} finally {
			shared.restore();
		}
	});
});

describe('repeating one chapter', () => {
	/**
	 * A markers-enabled player over the two-chapter recording, with the real
	 * commands registered against the same registry.
	 * @param shared - The installed shared audio element
	 * @returns The container, the command host, and the snapshot reader
	 */
	async function loopableEmbed(
		shared: ReturnType<typeof installSharedAudio>,
	): Promise<{
		container: HTMLElement;
		plugin: ReturnType<typeof asMockPlugin>;
		snapshot: () => PlaybackControlsState | null;
	}> {
		const registry = new AudioPlayerRegistry();
		const { plugin, snapshot } = withPlaybackCommands(registry);
		const store = makeMarkerStore();
		const container = makeEditableContainer();
		mountMarkerPlayer(registry, store, container);
		await tick();
		await store.updateMarkers('rec.mp4', () => CHAPTERS);
		registry.reloadMarkers('rec.mp4', null);
		await tick();
		startPlaybackAt(registry, shared.audio, 30);
		return { container, plugin, snapshot };
	}

	/** Reads the pressed state the embed's repeat button reports. */
	function loopPressed(container: HTMLElement): string | null {
		return control(container, 'Repeat current chapter').getAttribute(
			'aria-pressed',
		);
	}

	it('shows the loop engaged on the embed and in the snapshot alike', async () => {
		const shared = installSharedAudio();
		try {
			const { container, plugin, snapshot } = await loopableEmbed(shared);

			expect(plugin.invokeCommand('toggle-chapter-loop')).toBe(true);

			expect(loopPressed(container)).toBe('true');
			expect(snapshot()?.chapterLoopEnabled).toBe(true);
		} finally {
			shared.restore();
		}
	});

	it('returns to the chapter start when playback reaches its end', async () => {
		const shared = installSharedAudio();
		try {
			const { container, plugin, snapshot } = await loopableEmbed(shared);
			plugin.invokeCommand('toggle-chapter-loop');

			// Playback runs on past the boundary of the chapter at 0:00,
			// which the next chapter at 2:00 closes
			shared.audio.currentTime = 120;

			expect(timeText(container)).toBe('0:00 / 10:00');
			expect(snapshot()?.currentTime).toBe(0);
		} finally {
			shared.restore();
		}
	});

	it('moves the repeated stretch with a jump to another chapter', async () => {
		const shared = installSharedAudio();
		try {
			const { container, plugin } = await loopableEmbed(shared);
			plugin.invokeCommand('toggle-chapter-loop');

			// The listener moves on to the chapter at 2:00, so that is what
			// repeats; the last chapter ends with the recording, and playing
			// past 2:00 is inside it rather than out of it
			plugin.invokeCommand('go-to-next-chapter');
			shared.audio.currentTime = 300;

			expect(timeText(container)).toBe('5:00 / 10:00');
		} finally {
			shared.restore();
		}
	});

	it('runs the recording out normally once the loop is switched off', async () => {
		const shared = installSharedAudio();
		try {
			const { container, plugin, snapshot } = await loopableEmbed(shared);
			plugin.invokeCommand('toggle-chapter-loop');
			plugin.invokeCommand('toggle-chapter-loop');

			shared.audio.currentTime = 120;

			expect(loopPressed(container)).toBe('false');
			expect(snapshot()?.chapterLoopEnabled).toBe(false);
			expect(timeText(container)).toBe('2:00 / 10:00');
		} finally {
			shared.restore();
		}
	});

	it('repeats the last chapter, which the recording itself ends', async () => {
		const shared = installSharedAudio();
		try {
			const { container, plugin } = await loopableEmbed(shared);
			// Into the chapter at 2:00, the last one: nothing closes it but
			// the end of the recording, so no boundary is ever crossed
			shared.audio.currentTime = 300;
			plugin.invokeCommand('toggle-chapter-loop');

			shared.audio.dispatchEvent(new Event('ended'));

			expect(timeText(container)).toBe('2:00 / 10:00');
		} finally {
			shared.restore();
		}
	});

	it('leaves the recording to end where the loop sits on no chapter', async () => {
		const shared = installSharedAudio();
		try {
			const { container, plugin } = await loopableEmbed(shared);
			plugin.invokeCommand('toggle-chapter-loop');
			plugin.invokeCommand('toggle-chapter-loop');

			shared.audio.dispatchEvent(new Event('ended'));

			expect(timeText(container)).toBe('0:30 / 10:00');
		} finally {
			shared.restore();
		}
	});

	it('engages the loop from the embed own button', async () => {
		const shared = installSharedAudio();
		try {
			const { container, snapshot } = await loopableEmbed(shared);

			control(container, 'Repeat current chapter').click();

			expect(loopPressed(container)).toBe('true');
			expect(snapshot()?.chapterLoopEnabled).toBe(true);
		} finally {
			shared.restore();
		}
	});

	it('takes up the first chapter playback reaches after the loop is set', async () => {
		const shared = installSharedAudio();
		try {
			const registry = new AudioPlayerRegistry();
			const { plugin } = withPlaybackCommands(registry);
			const store = makeMarkerStore();
			const container = makeEditableContainer();
			mountMarkerPlayer(registry, store, container);
			await tick();
			// A recording whose first chapter starts well in, so the loop can
			// be engaged where no chapter covers the position yet
			await store.updateMarkers('rec.mp4', () => LATE_CHAPTERS);
			registry.reloadMarkers('rec.mp4', null);
			await tick();
			startPlaybackAt(registry, shared.audio, 30);
			plugin.invokeCommand('toggle-chapter-loop');

			shared.audio.currentTime = 150;
			shared.audio.currentTime = 300;

			expect(timeText(container)).toBe('2:00 / 10:00');
		} finally {
			shared.restore();
		}
	});

	it('offers no loop to a player that has no chapters', async () => {
		const shared = installSharedAudio();
		try {
			const { plugin } = await playingEmbed(shared);

			expect(plugin.invokeCommand('toggle-chapter-loop')).toBe(false);
		} finally {
			shared.restore();
		}
	});
});
