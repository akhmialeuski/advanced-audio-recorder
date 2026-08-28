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
 * They also cover the waveform decision (drawn progressively for files up to a
 * high safety ceiling; the plain seekable bar is used for pathological files
 * beyond it), the render-scoped teardown that keeps in-place re-renders from
 * accumulating observers, the seekTo autoplay contract (timecode links play;
 * in-player jumps preserve the play/pause state), and per-embed playback
 * independence: distinct embeds of one file (plain vs #t=) drive independent
 * audio elements, so playing or seeking one never moves the other (issue #38),
 * while marker registrations stay per file so marker edits sync across embeds.
 */

import { at } from '../helpers/assertions';
import { allEls, clickControl, control, el, maybeEl } from '../helpers/dom';
import { PLAYER } from '../helpers/selectors';
import { AudioPlayer } from 'src/player/AudioPlayer';
import { WaveformPeakCache } from 'src/player/WaveformData';
import type { AudioPlayerRegistry } from 'src/player/AudioPlayerRegistry';

import type { ResolvedPlayerSettings } from 'src/player/playerSettings';
import type { TFile } from 'obsidian';
import { tick } from '../helpers/async';

import {
	app,
	decoder,
	makeContainer,
	makeFakeAudio,
	makeFile,
	makeMarkerStore,
	makeRegistry,
	type FakeAudio,
} from '../helpers/audioPlayerHarness';

const markerStore = makeMarkerStore();

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
	skipSeconds: 10,
};

/**
 * Two embeds of one file mounted side by side: one carrying a `#t=` start, one
 * plain. This is the arrangement issue #38 is about - distinct embeds of the
 * same file must drive independent playback - and three tests set it up.
 * @param startSeconds - The `#t=` offset the first embed carries
 * @returns Both containers and both elements the registry handed out
 */
function mountTimedAndPlainEmbeds(startSeconds = 3): {
	withOffset: HTMLElement;
	plain: HTMLElement;
	timedAudio: FakeAudio;
	plainAudio: FakeAudio;
} {
	const timedAudio = makeFakeAudio();
	timedAudio.duration = 5;
	timedAudio.readyState = 1;
	const plainAudio = makeFakeAudio();
	plainAudio.duration = 5;
	plainAudio.readyState = 1;
	const registry = makeRegistry(timedAudio, plainAudio);

	const withOffset = makeContainer();
	makePlayer(
		withOffset,
		registry,
		PLAIN,
		makeFile(1000, 'wav'),
		startSeconds,
	).onload();
	const plain = makeContainer();
	makePlayer(plain, registry, PLAIN, makeFile(1000, 'wav'), null).onload();

	return { withOffset, plain, timedAudio, plainAudio };
}

afterEach(() => {
	document.body.innerHTML = '';
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
		player.applySettings({
			showWaveform: false,
			enableMarkers: true,
			skipSeconds: 10,
		});

		expect(audio.playbackRate).toBe(1.5);
	});

	it('reflects the live loop state on the loop button after a mode switch', () => {
		const audio = makeFakeAudio();
		const registry = makeRegistry(audio);
		makePlayer(makeContainer(), registry, PLAIN).onload();
		audio.loop = true;

		const container = makeContainer();
		makePlayer(container, registry, PLAIN).onload();
		expect(control(container, 'Loop')).toBeActiveControl();
	});

	it('reflects the live playback rate on the speed button after a re-render', () => {
		const audio = makeFakeAudio();
		const player = makePlayer(makeContainer(), makeRegistry(audio), PLAIN);
		player.onload();
		audio.playbackRate = 1.75;
		player.applySettings({
			showWaveform: false,
			enableMarkers: true,
			skipSeconds: 10,
		});

		expect(el(document, PLAYER.speed).textContent).toBe('1.75x');
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
		const controlsBefore = el(document, PLAYER.controls);

		// A save that did not change a player window must not rebuild anything
		player.applySettings({ ...PLAIN });

		expect(el(document, PLAYER.controls)).toBe(controlsBefore);
	});

	it('rebuilds the player when a window toggle actually changes', () => {
		const player = makePlayer(
			makeContainer(),
			makeRegistry(makeFakeAudio()),
			PLAIN,
		);
		player.onload();
		const controlsBefore = el(document, PLAYER.controls);

		player.applySettings({
			showWaveform: false,
			enableMarkers: true,
			skipSeconds: 10,
		});

		expect(el(document, PLAYER.controls)).not.toBe(controlsBefore);
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
		expect(maybeEl(container, PLAYER.seekBar)).not.toBeNull();
		expect(maybeEl(container, PLAYER.seekWaveform)).toBeNull();
		expect(maybeEl(container, PLAYER.progressFill)).not.toBeNull();
	});

	it('renders the waveform layer for a small file when enabled', async () => {
		jest.spyOn(console, 'warn').mockImplementation(() => {
			// Silence the expected decode-rejection warning
		});
		const container = makeContainer();
		makePlayer(container, makeRegistry(makeFakeAudio()), {
			showWaveform: true,
			enableMarkers: false,
			skipSeconds: 10,
		}).onload();
		expect(maybeEl(container, PLAYER.seekWaveform)).not.toBeNull();
		expect(maybeEl(container, PLAYER.waveform)).not.toBeNull();
		expect(allEls(container, 'canvas')).toHaveLength(2);
		// Let the fire-and-forget waveform load settle (decode rejects)
		// while the warning is still silenced
		await tick();
	});

	it('renders the waveform for a large file below the safety ceiling', async () => {
		jest.spyOn(console, 'warn').mockImplementation(() => {
			// Silence the expected decode-rejection warning
		});
		const container = makeContainer();
		// A multi-hundred-MB (hour-long) recording must still get the
		// waveform - it is computed progressively, not skipped by a cap
		makePlayer(
			container,
			makeRegistry(makeFakeAudio()),
			{ showWaveform: true, enableMarkers: false, skipSeconds: 10 },
			makeFile(500 * 1024 * 1024, 'wav'),
		).onload();
		expect(maybeEl(container, PLAYER.seekWaveform)).not.toBeNull();
		expect(maybeEl(container, PLAYER.waveform)).not.toBeNull();
		expect(maybeEl(container, PLAYER.seekBar)).toBeNull();
		// Let the fire-and-forget waveform load settle (decode rejects)
		await tick();
	});

	it('falls back to the plain bar for a pathological file above the ceiling', () => {
		const container = makeContainer();
		// A multi-gigabyte file is not decoded for a cosmetic waveform: the
		// plain (still seekable) bar is shown so the decode can never spike
		// memory. No decode runs, so no warning is emitted.
		makePlayer(
			container,
			makeRegistry(makeFakeAudio()),
			{ showWaveform: true, enableMarkers: false, skipSeconds: 10 },
			makeFile(2 * 1024 * 1024 * 1024, 'wav'),
		).onload();
		expect(maybeEl(container, PLAYER.seekWaveform)).toBeNull();
		expect(maybeEl(container, PLAYER.seekBar)).not.toBeNull();
		expect(maybeEl(container, PLAYER.progressFill)).not.toBeNull();
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
		expect(container).toShowTime('0:03 / 0:05');
		expect(audio.paused).toBe(true);
		// ...but it must NOT move the shared element, so a second embed of the
		// same file is never dragged to 0:03 (the start is per-embed, display
		// only, until this embed's playback actually begins)
		expect(audio.currentTime).toBe(0);
	});

	it('keeps a plain embed at 0:00 while a same-file #t= embed shows its offset', () => {
		// Two distinct embeds of ONE file drive independent playback elements
		// (issue #38). The #t= start stays per-embed: the plain embed must not
		// inherit the other embed's 0:03, and neither element is moved.
		const { withOffset, plain, timedAudio, plainAudio } =
			mountTimedAndPlainEmbeds();

		expect(withOffset).toShowTime('0:03 / 0:05');
		expect(plain).toShowTime('0:00 / 0:05');
		expect(timedAudio.currentTime).toBe(0);
		expect(plainAudio.currentTime).toBe(0);
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

		clickControl(container, 'Play / pause');

		// Pressing play engages the embed at its #t= start
		expect(audio.currentTime).toBe(3);
		expect(audio.play).toHaveBeenCalled();
	});

	it('shows the live shared position, not its #t= start, once playback is engaged', () => {
		const audio = makeFakeAudio();
		audio.duration = 5;
		audio.readyState = 1;
		// The same embed in another view/pane (or the user) has already moved
		// this embed's playback
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
		expect(container).toShowTime('0:04 / 0:05');
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

		expect(container).toShowTime('0:05 / 0:05');
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
		expect(container).toShowTime('0:03 / 0:05');

		// Playback engages the shared timeline, then the user returns to the
		// very start and pauses
		audio.emit('play');
		audio.currentTime = 0;
		audio.paused = true;
		audio.emit('timeupdate');

		// The #t=3 hint is consumed: it must NOT reappear at position 0
		expect(container).toShowTime('0:00 / 0:05');
	});

	it('keeps the #t= start while a different embed of the same file plays (issue #38)', () => {
		// Distinct embeds of one file have independent playback: playing the
		// plain embed must neither move the #t= embed's position nor consume
		// its start hint.
		const { withOffset, plain, timedAudio, plainAudio } =
			mountTimedAndPlainEmbeds();

		// The plain embed plays and advances to 0:02
		plainAudio.paused = false;
		plainAudio.emit('play');
		plainAudio.currentTime = 2;
		plainAudio.emit('timeupdate');

		expect(plain).toShowTime('0:02 / 0:05');
		// The #t= embed is untouched: still paused at its own 0:03 start
		expect(withOffset).toShowTime('0:03 / 0:05');
		expect(timedAudio.currentTime).toBe(0);
		expect(timedAudio.play).not.toHaveBeenCalled();
	});

	it('does not move a same-file embed when another embed is seeked (issue #38)', () => {
		const timedAudio = makeFakeAudio();
		timedAudio.duration = 5;
		timedAudio.readyState = 1;
		const plainAudio = makeFakeAudio();
		plainAudio.duration = 5;
		plainAudio.readyState = 1;
		const registry = makeRegistry(timedAudio, plainAudio);

		const withOffset = makeContainer();
		makePlayer(
			withOffset,
			registry,
			PLAIN,
			makeFile(1000, 'wav'),
			3,
		).onload();
		const plain = makeContainer();
		const plainPlayer = makePlayer(
			plain,
			registry,
			PLAIN,
			makeFile(1000, 'wav'),
			null,
		);
		plainPlayer.onload();

		// Seeking the plain embed moves only its own element
		plainPlayer.seekTo(4, false);
		plainAudio.emit('timeupdate');

		expect(plainAudio.currentTime).toBe(4);
		expect(plain).toShowTime('0:04 / 0:05');
		expect(timedAudio.currentTime).toBe(0);
		expect(withOffset).toShowTime('0:03 / 0:05');
	});

	it('registers every embed of a file under the file path, keeping markers in sync', () => {
		// Marker data is per FILE: the registry's player registrations (used
		// to broadcast marker reloads) must stay keyed by path even though
		// each embed drives its own playback element.
		const registry = makeRegistry();
		const first = makePlayer(
			makeContainer(),
			registry,
			PLAIN,
			makeFile(1000, 'wav'),
			3,
		);
		first.onload();
		const second = makePlayer(
			makeContainer(),
			registry,
			PLAIN,
			makeFile(1000, 'wav'),
			null,
		);
		second.onload();

		expect(registry.register).toHaveBeenCalledWith('rec.wav', first);
		expect(registry.register).toHaveBeenCalledWith('rec.wav', second);
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
		skipSeconds: 10,
	};

	let originalIO: typeof IntersectionObserver | undefined;

	beforeEach(() => {
		MockIntersectionObserver.instances = [];
		originalIO = window.IntersectionObserver;
		window.IntersectionObserver =
			MockIntersectionObserver as unknown as typeof IntersectionObserver;
		// loadWaveform's decode rejects in these tests; silence the warning
		jest.spyOn(console, 'warn').mockImplementation(() => undefined);
	});

	afterEach(() => {
		window.IntersectionObserver = originalIO as typeof IntersectionObserver;
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

	const rejectingDecode = (): jest.Mock =>
		jest.fn(() => Promise.reject(new Error('no decode in tests')));

	it('does not decode until the player scrolls into view', async () => {
		const decode = rejectingDecode();
		makeWaveformPlayer(decode).onload();

		// The waveform layer is built eagerly, but nothing is decoded yet - a
		// long note with many recordings must not decode every embed up front
		expect(MockIntersectionObserver.instances).toHaveLength(1);
		expect(decode).not.toHaveBeenCalled();

		at(MockIntersectionObserver.instances, 0).triggerIntersect();
		await tick();

		expect(decode).toHaveBeenCalledTimes(1);
	});

	it('decodes only once and stops observing after the first intersection', async () => {
		const decode = rejectingDecode();
		makeWaveformPlayer(decode).onload();
		const observer = at(MockIntersectionObserver.instances, 0);

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
		const observer = at(MockIntersectionObserver.instances, 0);

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

describe('render-scoped teardown across in-place re-renders (F1)', () => {
	/**
	 * A MutationObserver that tracks how many instances are currently
	 * connected, so the test can assert the default-embed guard observer is
	 * torn down per render instead of accumulating one per re-render.
	 */
	class CountingMutationObserver {
		static live = 0;
		private connected = false;
		observe(): void {
			if (!this.connected) {
				this.connected = true;
				CountingMutationObserver.live += 1;
			}
		}
		disconnect(): void {
			if (this.connected) {
				this.connected = false;
				CountingMutationObserver.live -= 1;
			}
		}
		takeRecords(): MutationRecord[] {
			return [];
		}
	}

	let originalMO: typeof MutationObserver;

	beforeEach(() => {
		CountingMutationObserver.live = 0;
		originalMO = window.MutationObserver;
		window.MutationObserver = CountingMutationObserver;
	});

	afterEach(() => {
		window.MutationObserver = originalMO;
	});

	it('keeps exactly one default-embed guard observer across many re-renders', () => {
		const player = makePlayer(
			makeContainer(),
			makeRegistry(makeFakeAudio()),
			PLAIN,
		);
		player.onload();
		// One live guard observer after the initial render
		expect(CountingMutationObserver.live).toBe(1);

		// Several in-place re-renders, each a real layout change so renderUi runs
		for (let i = 0; i < 6; i++) {
			player.applySettings({
				showWaveform: false,
				enableMarkers: i % 2 === 0,
				skipSeconds: 10,
			});
		}

		// The guard observer is disconnected per render, so exactly one stays
		// live; before the fix this grew to one per re-render
		expect(CountingMutationObserver.live).toBe(1);
	});

	it('disconnects the last render guard observer on unload', () => {
		const player = makePlayer(
			makeContainer(),
			makeRegistry(makeFakeAudio()),
			PLAIN,
		);
		// load() (not onload()) so the mock marks the child loaded and runs the
		// registered unload cleanups
		player.load();
		expect(CountingMutationObserver.live).toBe(1);

		player.unload();

		expect(CountingMutationObserver.live).toBe(0);
	});
});
