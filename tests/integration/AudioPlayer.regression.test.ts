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
	/** Test hook: invoke the registered listeners for an event type. */
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

/** A registry that hands out one shared audio: first acquire is "new". */
function makeRegistry(audio: FakeAudio): AudioPlayerRegistry {
	let created = false;
	// Faithfully track the shared engaged flag so #t= hint tests exercise the
	// real cross-embed behavior (engaging via one embed clears the hint on all)
	let engaged = false;
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
		markAudioEngaged: jest.fn(() => {
			engaged = true;
		}),
		isAudioEngaged: jest.fn(() => engaged),
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
	startSeconds: number | null = null,
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
		{ startSeconds, sourcePath: 'note.md', immediate: true },
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

describe('timecode start offset (#t=) positions and shows the embed', () => {
	it('shows the #t= offset as the start position without moving the shared audio', () => {
		const audio = makeFakeAudio();
		audio.duration = 5;
		audio.readyState = 1;
		const container = makeContainer();

		makePlayer(
			container,
			makeRegistry(audio),
			PLAIN,
			makeFile(1000, 'wav'),
			3,
		).onload();

		// The embed shows its #t=3 start (paused at 3 of 5 seconds)...
		expect(container.querySelector('.aar-player-time')?.textContent).toBe(
			'0:03 / 0:05',
		);
		expect(audio.paused).toBe(true);
		// ...but it must NOT move the shared element, so a second embed of the
		// same file is never dragged to 0:03 (the start is per-embed, display
		// only, until this embed's playback actually begins)
		expect(audio.currentTime).toBe(0);
	});

	it('keeps a plain embed at 0:00 while a same-file #t= embed shows its offset', () => {
		// Two distinct embeds of ONE file share a single audio element (so one
		// playback is controllable across view modes). The #t= start must stay
		// per-embed: the plain embed must not inherit the other embed's 0:03.
		const audio = makeFakeAudio();
		audio.duration = 5;
		audio.readyState = 1;
		const registry = makeRegistry(audio);

		const withOffset = makeContainer();
		makePlayer(
			withOffset,
			registry,
			PLAIN,
			makeFile(1000, 'wav'),
			3,
		).onload();
		const plain = makeContainer();
		makePlayer(
			plain,
			registry,
			PLAIN,
			makeFile(1000, 'wav'),
			null,
		).onload();

		expect(withOffset.querySelector('.aar-player-time')?.textContent).toBe(
			'0:03 / 0:05',
		);
		expect(plain.querySelector('.aar-player-time')?.textContent).toBe(
			'0:00 / 0:05',
		);
		expect(audio.currentTime).toBe(0);
	});

	it('starts playback from the #t= offset when the user presses play', () => {
		const audio = makeFakeAudio();
		audio.duration = 5;
		audio.readyState = 1;
		const container = makeContainer();
		makePlayer(
			container,
			makeRegistry(audio),
			PLAIN,
			makeFile(1000, 'wav'),
			3,
		).onload();
		// Display-only until the user engages this embed
		expect(audio.currentTime).toBe(0);

		container
			.querySelector<HTMLElement>('[aria-label="Play / pause"]')
			?.click();

		// Pressing play engages the embed at its #t= start
		expect(audio.currentTime).toBe(3);
		expect(audio.play).toHaveBeenCalled();
	});

	it('shows the live shared position, not its #t= start, once playback is engaged', () => {
		const audio = makeFakeAudio();
		audio.duration = 5;
		audio.readyState = 1;
		// Another embed (or the user) has already moved playback
		audio.currentTime = 4;
		const container = makeContainer();

		makePlayer(
			container,
			makeRegistry(audio),
			PLAIN,
			makeFile(1000, 'wav'),
			3,
		).onload();

		// The #t= start is a hint only while the shared audio is untouched; once
		// it is engaged, the embed reflects the real shared position
		expect(container.querySelector('.aar-player-time')?.textContent).toBe(
			'0:04 / 0:05',
		);
		expect(audio.currentTime).toBe(4);
	});

	it('clamps a #t= offset beyond the duration to the end', () => {
		const audio = makeFakeAudio();
		audio.duration = 5;
		audio.readyState = 1;
		const container = makeContainer();

		makePlayer(
			container,
			makeRegistry(audio),
			PLAIN,
			makeFile(1000, 'wav'),
			999,
		).onload();

		expect(container.querySelector('.aar-player-time')?.textContent).toBe(
			'0:05 / 0:05',
		);
	});

	it('does not resurface a stale #t= start after playback returns to 0', () => {
		const audio = makeFakeAudio();
		audio.duration = 5;
		audio.readyState = 1;
		const container = makeContainer();
		makePlayer(
			container,
			makeRegistry(audio),
			PLAIN,
			makeFile(1000, 'wav'),
			3,
		).onload();
		// Initially the embed shows its #t=3 start
		expect(container.querySelector('.aar-player-time')?.textContent).toBe(
			'0:03 / 0:05',
		);

		// Playback engages the shared timeline, then the user returns to the
		// very start and pauses
		audio.emit('play');
		audio.currentTime = 0;
		audio.paused = true;
		audio.emit('timeupdate');

		// The #t=3 hint is consumed: it must NOT reappear at position 0
		expect(container.querySelector('.aar-player-time')?.textContent).toBe(
			'0:00 / 0:05',
		);
	});

	it('clears the #t= start on same-file embeds once playback engages', () => {
		const audio = makeFakeAudio();
		audio.duration = 5;
		audio.readyState = 1;
		// One shared timeline drives both embeds of the file
		const registry = makeRegistry(audio);

		const withOffset = makeContainer();
		makePlayer(
			withOffset,
			registry,
			PLAIN,
			makeFile(1000, 'wav'),
			3,
		).onload();
		const plain = makeContainer();
		makePlayer(
			plain,
			registry,
			PLAIN,
			makeFile(1000, 'wav'),
			null,
		).onload();
		expect(withOffset.querySelector('.aar-player-time')?.textContent).toBe(
			'0:03 / 0:05',
		);

		// Playing the plain embed engages the shared timeline; after it returns
		// to 0 paused, the #t= embed must reflect the live timeline, not its hint
		audio.emit('play');
		audio.currentTime = 0;
		audio.paused = true;
		audio.emit('timeupdate');

		expect(withOffset.querySelector('.aar-player-time')?.textContent).toBe(
			'0:00 / 0:05',
		);
	});
});

describe('lazy waveform decode (B2)', () => {
	/** A controllable IntersectionObserver: never auto-fires; the test drives it. */
	class MockIntersectionObserver {
		static instances: MockIntersectionObserver[] = [];
		readonly observe = jest.fn();
		readonly unobserve = jest.fn();
		readonly disconnect = jest.fn();
		constructor(private readonly callback: IntersectionObserverCallback) {
			MockIntersectionObserver.instances.push(this);
		}
		/** Simulate the observed player scrolling into view. */
		triggerIntersect(): void {
			this.callback(
				[{ isIntersecting: true } as IntersectionObserverEntry],
				this as unknown as IntersectionObserver,
			);
		}
	}

	const WAVEFORM: ResolvedPlayerSettings = {
		showWaveform: true,
		enableMarkers: false,
	};

	let originalIO: typeof IntersectionObserver | undefined;
	let warn: jest.SpyInstance;

	beforeEach(() => {
		MockIntersectionObserver.instances = [];
		originalIO = window.IntersectionObserver;
		window.IntersectionObserver =
			MockIntersectionObserver as unknown as typeof IntersectionObserver;
		// loadWaveform's decode rejects in these tests; silence the warning
		warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
	});

	afterEach(() => {
		window.IntersectionObserver = originalIO as typeof IntersectionObserver;
		warn.mockRestore();
	});

	/** Builds a waveform player wired to a decode spy. */
	function makeWaveformPlayer(decode: jest.Mock): AudioPlayer {
		return new AudioPlayer(
			makeContainer(),
			app,
			makeFile(1000, 'wav'),
			WAVEFORM,
			makeRegistry(makeFakeAudio()),
			new WaveformPeakCache(),
			{ decode },
			markerStore,
			{ startSeconds: null, sourcePath: 'note.md', immediate: true },
		);
	}

	const tick = (): Promise<void> =>
		new Promise((resolve) => setTimeout(resolve, 0));

	const rejectingDecode = (): jest.Mock =>
		jest.fn(() => Promise.reject(new Error('no decode in tests')));

	it('does not decode until the player scrolls into view', async () => {
		const decode = rejectingDecode();
		makeWaveformPlayer(decode).onload();

		// The waveform layer is built eagerly, but nothing is decoded yet — a
		// long note with many recordings must not decode every embed up front
		expect(MockIntersectionObserver.instances).toHaveLength(1);
		expect(decode).not.toHaveBeenCalled();

		MockIntersectionObserver.instances[0].triggerIntersect();
		await tick();

		expect(decode).toHaveBeenCalledTimes(1);
	});

	it('decodes only once and stops observing after the first intersection', async () => {
		const decode = rejectingDecode();
		makeWaveformPlayer(decode).onload();
		const observer = MockIntersectionObserver.instances[0];

		observer.triggerIntersect();
		await tick();
		// Scrolling away and back must not re-decode
		observer.triggerIntersect();
		await tick();

		expect(decode).toHaveBeenCalledTimes(1);
		expect(observer.disconnect).toHaveBeenCalled();
	});

	it('disconnects the observer on unload without decoding off-screen', () => {
		const decode = rejectingDecode();
		const player = makeWaveformPlayer(decode);
		// load() (not onload()) so the mock marks the child loaded and runs the
		// registered unload cleanups
		player.load();
		const observer = MockIntersectionObserver.instances[0];

		player.unload();

		expect(observer.disconnect).toHaveBeenCalled();
		expect(decode).not.toHaveBeenCalled();
	});

	it('decodes immediately when IntersectionObserver is unavailable', async () => {
		window.IntersectionObserver =
			undefined as unknown as typeof IntersectionObserver;
		const decode = rejectingDecode();
		makeWaveformPlayer(decode).onload();
		await tick();

		// No observer to defer behind -> decode right away (fallback path)
		expect(decode).toHaveBeenCalledTimes(1);
		expect(MockIntersectionObserver.instances).toHaveLength(0);
	});
});
