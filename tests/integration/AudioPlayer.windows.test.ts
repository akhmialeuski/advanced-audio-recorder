/**
 * The player following its note between windows.
 *
 * Dragging a tab into a pop-out moves the rendered note there without
 * rendering it again, so whatever a render pass bound to the window it was
 * built in stays bound to it: the waveform drawn at that window's pixel ratio
 * and the marker list listening on its document. The player renders itself
 * again when Obsidian reports the move, and these tests hold it to that,
 * through a real player, the real waveform pipeline and a cached waveform,
 * with an iframe's window standing in for the pop-out.
 * @module tests/integration/AudioPlayer.windows.test
 */

import { AudioPlayer } from 'src/player/AudioPlayer';
import { WaveformPeakCache, waveformCacheKey } from 'src/player/WaveformData';
import type { ResolvedPlayerSettings } from 'src/player/playerSettings';
import { WAVEFORM_CACHE_BUCKETS } from 'src/constants';
import { flushMicrotasks } from '../helpers/async';
import { installCanvas2dContext } from '../helpers/canvas';
import type { CanvasContextDouble } from '../helpers/canvas';
import { el } from '../helpers/dom';
import { makePopoutWindow } from '../helpers/popoutHarness';
import { PLAYER } from '../helpers/selectors';
import {
	app,
	decoder,
	makeContainer,
	makeFakeAudio,
	makeFile,
	makeMarkerStore,
	makeRegistry,
} from '../helpers/audioPlayerHarness';

const WAVEFORM: ResolvedPlayerSettings = {
	showWaveform: true,
	enableMarkers: false,
	skipSeconds: 10,
};

/** The width jsdom is told every element has, since it lays nothing out. */
const SEEK_WIDTH = 300;

let canvas: CanvasContextDouble;

beforeEach(() => {
	canvas = installCanvas2dContext();
	// Every seek area a render builds has to report a width, and each render
	// builds a new one, so the width is given to every element.
	jest.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(
		SEEK_WIDTH,
	);
	jest.replaceProperty(window, 'devicePixelRatio', 1);
});

afterEach(() => {
	canvas.restore();
	document.body.innerHTML = '';
});

/**
 * A player drawing a cached waveform in the main window, rendered and
 * attached the way an open note shows it.
 * @returns The player and the container it renders into
 */
function createSut(): { player: AudioPlayer; container: HTMLElement } {
	const file = makeFile(1000, 'wav');
	const peakCache = new WaveformPeakCache();
	peakCache.set(
		waveformCacheKey(file.path, file.stat.mtime, file.stat.size),
		Array.from({ length: WAVEFORM_CACHE_BUCKETS }, () => 0.5),
	);
	const container = makeContainer();
	const player = new AudioPlayer(
		container,
		app,
		file,
		WAVEFORM,
		makeRegistry(makeFakeAudio()),
		peakCache,
		decoder,
		makeMarkerStore(),
		{ startSeconds: null, sourcePath: 'note.md', immediate: true },
	);
	player.load();
	return { player, container };
}

/** The waveform's base canvas as the container holds it now. */
function baseCanvas(container: HTMLElement): HTMLCanvasElement {
	return el<HTMLCanvasElement>(container, PLAYER.canvas);
}

describe('a player whose note moves into a pop-out', () => {
	it('redraws the waveform at the pop-out pixel ratio', async () => {
		const { container } = createSut();
		const popout = makePopoutWindow();
		jest.replaceProperty(popout, 'devicePixelRatio', 2);

		popout.document.body.appendChild(container);
		await flushMicrotasks();

		expect(baseCanvas(container).width).toBe(SEEK_WIDTH * 2);
	});

	// Each move is followed, not only the first: the pass rendered in the
	// first pop-out has to give way to one bound to the second.
	it('redraws again when the note moves on to another pop-out', async () => {
		const { container } = createSut();
		const first = makePopoutWindow();
		const second = makePopoutWindow();
		jest.replaceProperty(first, 'devicePixelRatio', 2);
		jest.replaceProperty(second, 'devicePixelRatio', 3);
		first.document.body.appendChild(container);
		await flushMicrotasks();

		second.document.body.appendChild(container);
		await flushMicrotasks();

		expect(baseCanvas(container).width).toBe(SEEK_WIDTH * 3);
	});

	// Live Preview takes an embed's widget out and puts it back as the
	// viewport changes. That is not a move, and rebuilding the player for it
	// would throw away the canvas on every scroll.
	it('keeps its canvas when it is put back into the same window', async () => {
		const { container } = createSut();
		const before = baseCanvas(container);

		container.remove();
		await flushMicrotasks();
		document.body.appendChild(container);
		await flushMicrotasks();

		expect(baseCanvas(container)).toBe(before);
	});

	it('stops following its note once it unloads', async () => {
		const { player, container } = createSut();
		const before = baseCanvas(container);
		const popout = makePopoutWindow();

		player.unload();
		popout.document.body.appendChild(container);
		await flushMicrotasks();

		expect(baseCanvas(container)).toBe(before);
	});
});
