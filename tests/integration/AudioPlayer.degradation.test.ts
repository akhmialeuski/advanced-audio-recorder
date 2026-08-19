/**
 * The player's fallback and browser-integration paths.
 *
 * These are the parts that only run when something goes wrong or when a
 * browser API is involved, so none of them had ever executed under jsdom: the
 * native audio element the player degrades to when the enhanced render throws,
 * the wait for Obsidian to populate an embed, the speed menu, and the clipboard
 * write behind "copy timestamp link". Between them they were most of what kept
 * AudioPlayer at 77% statements and 68% branches.
 * @module tests/integration/AudioPlayer.degradation.test
 */

import { AudioPlayer } from 'src/player/AudioPlayer';
import { WaveformPeakCache } from 'src/player/WaveformData';
import type { AudioPlayerRegistry } from 'src/player/AudioPlayerRegistry';
import type { ResolvedPlayerSettings } from 'src/player/playerSettings';
import { PLAYER_PLAYBACK_RATE_PRESETS } from 'src/constants';
import { at } from '../helpers/assertions';
import { tick } from '../helpers/async';
import { menuInstances, noticeMessages } from '../mocks/obsidian';
import type { Menu as MockMenu } from '../mocks/obsidian';
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
import { internalsOf } from '../helpers/doubles';

const PLAIN: ResolvedPlayerSettings = {
	showWaveform: false,
	enableMarkers: false,
};

/** A player over a fresh container, rendered immediately. */
function makePlayer(
	container: HTMLElement,
	registry: AudioPlayerRegistry,
): AudioPlayer {
	return new AudioPlayer(
		container,
		app,
		makeFile(1000, 'wav'),
		PLAIN,
		registry,
		new WaveformPeakCache(),
		decoder,
		makeMarkerStore(),
		{ startSeconds: null, sourcePath: 'note.md', immediate: true },
	);
}

/** Reaches the private members these degradation paths are reached through. */
interface PlayerInternals {
	renderPlayer: () => void;
	showSpeedMenu: (event: MouseEvent) => void;
	copyTimestampLink: (time?: number) => Promise<void>;
	whenEmbedReady: (run: () => void) => void;
	isEmbedLoaded: () => boolean;
}

/**
 * The player's internals, for the paths only reachable from inside it.
 * @param player - The player under test
 * @returns The same object, typed with the members under test
 */
function internals(player: AudioPlayer): PlayerInternals {
	return internalsOf<PlayerInternals>(player);
}

describe('degrading to the native audio element', () => {
	it('replaces a failed enhanced render with a working native player', () => {
		const consoleError = jest
			.spyOn(console, 'error')
			.mockImplementation(() => undefined);
		const container = makeContainer();
		const player = makePlayer(container, makeRegistry(makeFakeAudio()));
		jest.spyOn(internals(player), 'renderPlayer').mockImplementation(() => {
			throw new Error('embed bug');
		});

		player.onload();

		// A blank note is the worst outcome; a plain audio element is not.
		const audio = container.querySelector('audio');
		expect(audio).not.toBeNull();
		expect(audio?.controls).toBe(true);
		expect(audio?.getAttribute('src')).toBe('app://media');
		expect(container.classList.contains('aar-player')).toBe(false);
		expect(consoleError).toHaveBeenCalledWith(
			expect.stringContaining('falling back to the native audio element'),
			expect.any(Error),
		);
	});

	it('reports a fallback that also fails rather than throwing on into Obsidian', () => {
		const consoleError = jest
			.spyOn(console, 'error')
			.mockImplementation(() => undefined);
		const container = makeContainer();
		const player = makePlayer(container, makeRegistry(makeFakeAudio()));
		jest.spyOn(internals(player), 'renderPlayer').mockImplementation(() => {
			throw new Error('embed bug');
		});
		jest.spyOn(container, 'empty').mockImplementation(() => {
			throw new Error('detached');
		});

		expect(() => {
			player.onload();
		}).not.toThrow();
		expect(consoleError).toHaveBeenCalledWith(
			expect.stringContaining('Native audio fallback also failed'),
			expect.any(Error),
		);
	});

	it('renders once, however many times load is asked for', () => {
		const container = makeContainer();
		const player = makePlayer(container, makeRegistry(makeFakeAudio()));
		const render = jest.spyOn(internals(player), 'renderPlayer');

		player.onload();
		player.loadFile();

		expect(render).toHaveBeenCalledTimes(1);
	});
});

describe('waiting for Obsidian to populate the embed', () => {
	it('runs the takeover at once when the embed is already there', () => {
		const player = makePlayer(
			makeContainer(),
			makeRegistry(makeFakeAudio()),
		);
		jest.spyOn(internals(player), 'isEmbedLoaded').mockReturnValue(true);
		const run = jest.fn();

		internals(player).whenEmbedReady(run);

		expect(run).toHaveBeenCalledTimes(1);
	});

	it('waits for the embed to appear, then takes over exactly once', async () => {
		jest.useFakeTimers();
		try {
			const container = makeContainer();
			const player = makePlayer(container, makeRegistry(makeFakeAudio()));
			let loaded = false;
			jest.spyOn(internals(player), 'isEmbedLoaded').mockImplementation(
				() => loaded,
			);
			const run = jest.fn();
			internals(player).whenEmbedReady(run);
			expect(run).not.toHaveBeenCalled();

			// Obsidian fills the container in; the observer notices.
			loaded = true;
			container.appendChild(document.createElement('span'));
			// A MutationObserver delivers on a microtask, not a timer.
			await Promise.resolve();

			expect(run).toHaveBeenCalledTimes(1);

			// The fallback timer must not fire a second takeover.
			await jest.advanceTimersByTimeAsync(10_000);
			expect(run).toHaveBeenCalledTimes(1);
		} finally {
			jest.useRealTimers();
		}
	});

	it('takes over on the fallback timer when the embed signal never arrives', () => {
		jest.useFakeTimers();
		try {
			const player = makePlayer(
				makeContainer(),
				makeRegistry(makeFakeAudio()),
			);
			jest.spyOn(internals(player), 'isEmbedLoaded').mockReturnValue(
				false,
			);
			const run = jest.fn();

			internals(player).whenEmbedReady(run);
			jest.advanceTimersByTime(10_000);

			// Better a late takeover than an embed that stays native forever.
			expect(run).toHaveBeenCalledTimes(1);
		} finally {
			jest.useRealTimers();
		}
	});

	it('stops waiting when the player unloads first', async () => {
		jest.useFakeTimers();
		try {
			const player = makePlayer(
				makeContainer(),
				makeRegistry(makeFakeAudio()),
			);
			// load(), not onload(): the teardown that cancels the wait is
			// registered with the component, and unload() only runs those for a
			// component the framework actually loaded.
			player.load();
			jest.spyOn(internals(player), 'isEmbedLoaded').mockReturnValue(
				false,
			);
			const run = jest.fn();
			internals(player).whenEmbedReady(run);

			player.unload();
			await jest.advanceTimersByTimeAsync(10_000);

			expect(run).not.toHaveBeenCalled();
		} finally {
			jest.useRealTimers();
		}
	});
});

describe('the playback speed menu', () => {
	/** Opens the speed menu over a player whose rate is set. */
	function openSpeedMenu(rate: number): {
		menu: MockMenu;
		audio: FakeAudio;
		event: MouseEvent;
	} {
		const audio = makeFakeAudio();
		const player = makePlayer(makeContainer(), makeRegistry(audio));
		// After the render, which seeds the rate from settings.
		player.onload();
		audio.playbackRate = rate;
		const event = new MouseEvent('click');

		internals(player).showSpeedMenu(event);

		return { menu: at(menuInstances, 0), audio, event };
	}

	it('offers every preset', () => {
		const { menu } = openSpeedMenu(1);

		expect(menu.items).toHaveLength(PLAYER_PLAYBACK_RATE_PRESETS.length);
	});

	it('checks exactly the entry matching the current rate', () => {
		const { menu } = openSpeedMenu(
			at([...PLAYER_PLAYBACK_RATE_PRESETS], 1),
		);

		const checked = menu.items.filter((item) => item.checked);
		expect(checked).toHaveLength(1);
	});

	it('checks nothing when the current rate matches no preset', () => {
		const { menu } = openSpeedMenu(1.37);

		expect(menu.items.some((item) => item.checked)).toBe(false);
	});

	it('applies the rate that was picked', () => {
		const target = at([...PLAYER_PLAYBACK_RATE_PRESETS], 2);
		const { menu, audio } = openSpeedMenu(1);

		const entry = menu.items.find(
			(item) => item.title === `${String(target)}x`,
		);
		entry?.click();

		expect(audio.playbackRate).toBe(target);
	});

	it('opens where the click was', () => {
		// Obsidian positions the menu from the event it is shown at, so the
		// event has to be the press that opened it - a fresh MouseEvent would
		// put the menu at the top-left corner of the window.
		const { menu, event } = openSpeedMenu(1);

		expect(menu.shownAtEvent).toBe(event);
	});
});

describe('copying a timestamp link', () => {
	/** Installs a clipboard whose write can be made to fail. */
	function installClipboard(failing = false): { writeText: jest.Mock } {
		const writeText = jest.fn(() =>
			failing
				? Promise.reject(new Error('denied'))
				: Promise.resolve(undefined),
		);
		Object.defineProperty(navigator, 'clipboard', {
			configurable: true,
			value: { writeText },
		});
		return { writeText };
	}

	it('writes a link to the current position and says so', async () => {
		const { writeText } = installClipboard();
		const audio = makeFakeAudio();
		audio.currentTime = 65;
		const player = makePlayer(makeContainer(), makeRegistry(audio));
		player.onload();

		await internals(player).copyTimestampLink();

		expect(writeText).toHaveBeenCalledWith('[[rec.webm]]');
		expect(noticeMessages()).toContain('Copied timestamp link at 1:05');
	});

	it('writes a link to a position it was handed', async () => {
		installClipboard();
		const player = makePlayer(
			makeContainer(),
			makeRegistry(makeFakeAudio()),
		);
		player.onload();

		await internals(player).copyTimestampLink(3723);

		expect(noticeMessages()).toContain('Copied timestamp link at 1:02:03');
	});

	it.each([
		{ name: 'a fractional position', time: 9.9, shown: '0:09' },
		{ name: 'a negative position', time: -5, shown: '0:00' },
		{ name: 'the very start', time: 0, shown: '0:00' },
		// The two positions a media element reports before it has a real
		// one. Neither is a timestamp, and both must copy a link the reader
		// can click rather than one reading NaN.
		{
			name: 'a position that is not a number',
			time: Number.NaN,
			shown: '0:00',
		},
		{
			name: 'an infinite position',
			time: Number.POSITIVE_INFINITY,
			shown: '0:00',
		},
		// One tick either side of the minute boundary: flooring must not
		// round 59.999 up into the next minute.
		{ name: 'a hair under a minute', time: 59.999, shown: '0:59' },
		{ name: 'exactly a minute', time: 60, shown: '1:00' },
	])('floors $name to $shown', async ({ time, shown }) => {
		installClipboard();
		const player = makePlayer(
			makeContainer(),
			makeRegistry(makeFakeAudio()),
		);
		player.onload();

		await internals(player).copyTimestampLink(time);

		expect(noticeMessages()).toContain(`Copied timestamp link at ${shown}`);
	});

	it('says the copy failed rather than claiming it worked', async () => {
		const warn = jest
			.spyOn(console, 'warn')
			.mockImplementation(() => undefined);
		installClipboard(true);
		const player = makePlayer(
			makeContainer(),
			makeRegistry(makeFakeAudio()),
		);
		player.onload();

		await internals(player).copyTimestampLink(10);

		expect(noticeMessages()).toContain(
			'Could not copy timestamp link to the clipboard.',
		);
		expect(noticeMessages()).not.toContain('Copied timestamp link at 0:10');
		expect(warn).toHaveBeenCalled();
	});
});

describe('settings applied to a live player', () => {
	it('ignores settings identical to the current ones', () => {
		const container = makeContainer();
		const player = makePlayer(container, makeRegistry(makeFakeAudio()));
		player.onload();
		const render = jest.spyOn(internals(player), 'renderPlayer');

		player.applySettings({ ...PLAIN });

		expect(render).not.toHaveBeenCalled();
	});

	it('ignores settings applied after unload', async () => {
		const container = makeContainer();
		const player = makePlayer(container, makeRegistry(makeFakeAudio()));
		player.onload();
		const render = jest.spyOn(internals(player), 'renderPlayer');

		player.unload();
		player.applySettings({ showWaveform: true, enableMarkers: true });
		await tick();

		expect(render).not.toHaveBeenCalled();
	});
});
