/** @jest-environment jsdom */
/**
 * Regression guards for the enhanced player's two long-standing defects:
 *
 *  - A view-mode switch or an unrelated settings save reset the player's
 *    chosen playback speed and loop, because renderUi reapplied the defaults
 *    to the shared audio on every render. The fix applies defaults only when
 *    the shared audio is first created.
 *  - Any settings save rebuilt every open player (and so reset its playback),
 *    because applySettings always re-rendered. The fix no-ops when the
 *    resolved layout is unchanged.
 *
 * They also cover the waveform size guard (large files fall back to the plain
 * bar) and the seekTo autoplay contract (timecode links play; in-player jumps
 * preserve the play/pause state).
 */

import { App, Modal } from 'obsidian';
import { AudioPlayer } from 'src/player/AudioPlayer';
import { WaveformPeakCache, type AudioDecoder } from 'src/player/WaveformData';
import type { AudioPlayerRegistry } from 'src/player/AudioPlayerRegistry';
import type { MarkerStore } from 'src/player/markers/MarkerStore';
import type { ResolvedPlayerSettings } from 'src/settings/Settings';
import type { TFile } from 'obsidian';

type Listener = () => void;

/** A controllable stand-in for the shared HTMLAudioElement. */
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
	};
	return audio;
}

/** A registry that hands out one shared audio: first acquire is "new". */
function makeRegistry(audio: FakeAudio): AudioPlayerRegistry {
	let created = false;
	const registry = {
		acquireAudio: jest.fn(() => {
			const isNew = !created;
			created = true;
			return { audio: audio as unknown as HTMLAudioElement, isNew };
		}),
		releaseAudio: jest.fn(),
		register: jest.fn(),
		unregister: jest.fn(),
		reloadMarkers: jest.fn(),
		seek: jest.fn(),
		applySettings: jest.fn(),
		clear: jest.fn(),
	};
	return registry as AudioPlayerRegistry;
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

// Decoding is irrelevant to these structural assertions; rejecting keeps the
// progressive peak path (and its timers) out of the tests.
const decoder: AudioDecoder = {
	decode: () => Promise.reject(new Error('no decode in tests')),
};

const markerStore = {
	get: () => Promise.resolve([]),
	set: () => Promise.resolve(),
} as unknown as MarkerStore;

function makeFile(size = 1000, extension = 'webm'): TFile {
	return {
		path: `rec.${extension}`,
		extension,
		stat: { mtime: 1, size },
	} as unknown as TFile;
}

/** A connected, Obsidian-extended container element. */
function makeContainer(): HTMLElement {
	const el = new Modal(new App()).contentEl.createDiv();
	document.body.appendChild(el);
	return el;
}

function makePlayer(
	container: HTMLElement,
	registry: AudioPlayerRegistry,
	settings: ResolvedPlayerSettings,
	file: TFile = makeFile(),
): AudioPlayer {
	return new AudioPlayer(
		container,
		app,
		file,
		settings,
		registry,
		new WaveformPeakCache(),
		decoder,
		markerStore,
		{ startSeconds: null, sourcePath: 'note.md', immediate: true },
	);
}

const PLAIN: ResolvedPlayerSettings = {
	showWaveform: false,
	enableMarkers: false,
};

afterEach(() => {
	document.body.innerHTML = '';
	jest.clearAllMocks();
});

describe('shared playback state survives a re-render (F1)', () => {
	it('does not reset playbackRate/loop when a second player binds the shared audio', () => {
		const audio = makeFakeAudio();
		const registry = makeRegistry(audio);

		const first = makePlayer(makeContainer(), registry, PLAIN);
		first.onload();
		expect(audio.playbackRate).toBe(1);
		expect(audio.loop).toBe(false);

		// The user changes speed and enables loop on the shared audio
		audio.playbackRate = 2;
		audio.loop = true;

		// A view-mode switch mounts a second player on the SAME shared audio
		const second = makePlayer(makeContainer(), registry, PLAIN);
		second.onload();

		expect(audio.playbackRate).toBe(2);
		expect(audio.loop).toBe(true);
	});

	it('does not reset playbackRate on an in-place settings re-render', () => {
		const audio = makeFakeAudio();
		const player = makePlayer(makeContainer(), makeRegistry(audio), PLAIN);
		player.onload();

		audio.playbackRate = 1.5;
		// A real layout change forces a re-render
		player.applySettings({ showWaveform: false, enableMarkers: true });

		expect(audio.playbackRate).toBe(1.5);
	});

	it('reflects the live loop state on the loop button after a mode switch', () => {
		const audio = makeFakeAudio();
		const registry = makeRegistry(audio);
		makePlayer(makeContainer(), registry, PLAIN).onload();
		audio.loop = true;

		const container = makeContainer();
		makePlayer(container, registry, PLAIN).onload();
		const loopButton = container.querySelector('[aria-label="Loop"]');
		expect(loopButton?.classList.contains('is-active')).toBe(true);
	});

	it('reflects the live playback rate on the speed button after a re-render', () => {
		const audio = makeFakeAudio();
		const player = makePlayer(makeContainer(), makeRegistry(audio), PLAIN);
		player.onload();
		audio.playbackRate = 1.75;
		player.applySettings({ showWaveform: false, enableMarkers: true });

		const speed = document.querySelector('.aar-player-speed');
		expect(speed?.textContent).toBe('1.75x');
	});
});

describe('settings re-render only when the layout changes (F4)', () => {
	it('does not rebuild the player when the resolved settings are unchanged', () => {
		const player = makePlayer(
			makeContainer(),
			makeRegistry(makeFakeAudio()),
			PLAIN,
		);
		player.onload();
		const controlsBefore = document.querySelector('.aar-player-controls');

		// A save that did not change a player window must not rebuild anything
		player.applySettings({ ...PLAIN });

		expect(document.querySelector('.aar-player-controls')).toBe(
			controlsBefore,
		);
	});

	it('rebuilds the player when a window toggle actually changes', () => {
		const player = makePlayer(
			makeContainer(),
			makeRegistry(makeFakeAudio()),
			PLAIN,
		);
		player.onload();
		const controlsBefore = document.querySelector('.aar-player-controls');

		player.applySettings({ showWaveform: false, enableMarkers: true });

		expect(document.querySelector('.aar-player-controls')).not.toBe(
			controlsBefore,
		);
	});
});

describe('seekTo autoplay contract (F13)', () => {
	it('starts playback by default (timecode links)', () => {
		const audio = makeFakeAudio();
		const player = makePlayer(makeContainer(), makeRegistry(audio), PLAIN);
		player.onload();
		audio.play.mockClear();

		player.seekTo(50);

		expect(audio.currentTime).toBe(50);
		expect(audio.play).toHaveBeenCalled();
	});

	it('preserves the paused state when autoplay is false (in-player jumps)', () => {
		const audio = makeFakeAudio();
		const player = makePlayer(makeContainer(), makeRegistry(audio), PLAIN);
		player.onload();
		audio.paused = true;
		audio.play.mockClear();

		player.seekTo(20, false);

		expect(audio.currentTime).toBe(20);
		expect(audio.play).not.toHaveBeenCalled();
	});
});

describe('waveform rendering decision (F2/F3)', () => {
	it('renders the plain seek bar when the waveform is off', () => {
		const container = makeContainer();
		makePlayer(container, makeRegistry(makeFakeAudio()), PLAIN).onload();
		expect(container.querySelector('.aar-player-seek-bar')).not.toBeNull();
		expect(container.querySelector('.aar-player-seek-waveform')).toBeNull();
		expect(
			container.querySelector('.aar-player-progress-fill'),
		).not.toBeNull();
	});

	it('renders the waveform layer for a small file when enabled', async () => {
		const warn = jest.spyOn(console, 'warn').mockImplementation(() => {
			// Silence the expected decode-rejection warning
		});
		try {
			const container = makeContainer();
			makePlayer(container, makeRegistry(makeFakeAudio()), {
				showWaveform: true,
				enableMarkers: false,
			}).onload();
			expect(
				container.querySelector('.aar-player-seek-waveform'),
			).not.toBeNull();
			expect(
				container.querySelector('.aar-player-waveform'),
			).not.toBeNull();
			expect(container.querySelectorAll('canvas')).toHaveLength(2);
			// Let the fire-and-forget waveform load settle (decode rejects)
			// while the warning is still silenced
			await new Promise((resolve) => setTimeout(resolve, 0));
		} finally {
			warn.mockRestore();
		}
	});

	it('still renders the waveform for a long/large file (no size cap)', async () => {
		const warn = jest.spyOn(console, 'warn').mockImplementation(() => {
			// Silence the expected decode-rejection warning
		});
		try {
			const container = makeContainer();
			// A multi-hundred-MB (hour-long) recording must still get the
			// waveform — it is computed progressively, not skipped by a cap
			makePlayer(
				container,
				makeRegistry(makeFakeAudio()),
				{ showWaveform: true, enableMarkers: false },
				makeFile(500 * 1024 * 1024, 'wav'),
			).onload();
			expect(
				container.querySelector('.aar-player-seek-waveform'),
			).not.toBeNull();
			expect(
				container.querySelector('.aar-player-waveform'),
			).not.toBeNull();
			expect(container.querySelector('.aar-player-seek-bar')).toBeNull();
			// Let the fire-and-forget waveform load settle (decode rejects)
			await new Promise((resolve) => setTimeout(resolve, 0));
		} finally {
			warn.mockRestore();
		}
	});
});
