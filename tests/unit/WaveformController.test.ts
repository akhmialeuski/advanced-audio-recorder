/**
 * Tests the waveform decode pipeline for one player.
 *
 * This was the least covered file in the player - 58% of statements and 28% of
 * branches - and the uncovered part is the whole point of it: deferring the
 * decode until the player is on screen, reusing cached peaks, drawing partial
 * results as they arrive, abandoning everything the moment the player unloads,
 * and retrying the draw until the seek area has a width. jsdom reports a
 * clientWidth of zero and has no IntersectionObserver, which is why none of it
 * had ever run.
 * @module tests/unit/WaveformController.test
 */

import type { App, TFile } from 'obsidian';
import { WaveformController } from 'src/player/WaveformController';
import type { WaveformHost } from 'src/player/WaveformController';
import { WaveformPeakCache, waveformCacheKey } from 'src/player/WaveformData';
import type { AudioDecoder } from 'src/player/WaveformData';
import {
	PLAYER_WAVEFORM_REDRAW_RETRIES,
	WAVEFORM_CACHE_BUCKETS,
} from 'src/constants';
import { at } from '../helpers/assertions';
import { createFile } from '../helpers/createApp';
import { createMockAudioBuffer } from '../helpers/createMockAudioBuffer';
import { tick } from '../helpers/async';
import { addObsidianDomExtensions } from '../mocks/domExtensions';
import { installCanvas2dContext } from '../helpers/canvas';
import type { CanvasContextDouble } from '../helpers/canvas';

let canvas: CanvasContextDouble;

beforeEach(() => {
	canvas = installCanvas2dContext();
});

afterEach(() => {
	canvas.restore();
});

/** A seek area with a width a test controls, since jsdom always reports zero. */
function createSeekEl(width: number): HTMLElement {
	// The canvas builds itself with Obsidian's DOM helpers, which jsdom has no
	// notion of, so the host element needs them the way a real one would.
	const el = addObsidianDomExtensions(document.createElement('div'));
	Object.defineProperty(el, 'clientWidth', {
		configurable: true,
		get: () => width,
	});
	return el;
}

/** Replaces the seek area's reported width after it was mounted. */
function setWidth(el: HTMLElement, width: number): void {
	Object.defineProperty(el, 'clientWidth', {
		configurable: true,
		get: () => width,
	});
}

/** The controller with the collaborators a test drives and asserts on. */
function createSut(
	overrides: {
		file?: TFile;
		bytes?: ArrayBuffer;
		decode?: AudioDecoder['decode'];
		cache?: WaveformPeakCache;
		unloaded?: () => boolean;
	} = {},
): {
	controller: WaveformController;
	file: TFile;
	app: App;
	readBinary: jest.Mock;
	decode: jest.Mock;
	cache: WaveformPeakCache;
	cleanups: (() => void)[];
	isUnloaded: jest.Mock;
} {
	const file =
		overrides.file ??
		createFile('Recordings/take.wav', { size: 4096, mtime: 100 });
	const readBinary = jest
		.fn()
		.mockResolvedValue(overrides.bytes ?? new ArrayBuffer(8));
	const app = { vault: { readBinary } } as unknown as App;
	const decode = jest.fn(
		overrides.decode ??
			(() => Promise.resolve(createMockAudioBuffer(1, 8, 8))),
	);
	const cache = overrides.cache ?? new WaveformPeakCache();
	const cleanups: (() => void)[] = [];
	const isUnloaded = jest.fn(overrides.unloaded ?? (() => false));
	const host: WaveformHost = {
		registerRenderCleanup: (cleanup) => cleanups.push(cleanup),
		isUnloaded,
	};
	return {
		controller: new WaveformController(app, file, { decode }, cache, host),
		file,
		app,
		readBinary,
		decode,
		cache,
		cleanups,
		isUnloaded,
	};
}

describe('shouldRender', () => {
	it.each([
		{
			name: 'the setting is off',
			showWaveform: false,
			size: 1024,
			expected: false,
		},
		{
			name: 'the setting is on',
			showWaveform: true,
			size: 1024,
			expected: true,
		},
		{
			name: 'the file is far past the decode ceiling',
			showWaveform: true,
			size: 5_000_000_000,
			expected: false,
		},
	])('is $expected when $name', ({ showWaveform, size, expected }) => {
		const { controller } = createSut({
			file: createFile('a.wav', { size }),
		});

		expect(controller.shouldRender(showWaveform)).toBe(expected);
	});
});

describe('mount and reset', () => {
	it('reports no canvas until it is mounted', () => {
		const { controller } = createSut();

		expect(controller.isMounted()).toBe(false);
	});

	it('creates the canvas inside the seek area', () => {
		const { controller } = createSut();
		const seekEl = createSeekEl(200);

		controller.mount(seekEl);

		expect(controller.isMounted()).toBe(true);
		expect(seekEl.querySelector('canvas')).not.toBeNull();
	});

	it('drops the canvas on reset, so a re-render does not draw into the old one', () => {
		const { controller } = createSut();
		controller.mount(createSeekEl(200));

		controller.reset();

		expect(controller.isMounted()).toBe(false);
	});

	it('disconnects the resize observer through the render cleanup', () => {
		const disconnect = jest.fn();
		const observe = jest.fn();
		const original = globalThis.ResizeObserver;
		globalThis.ResizeObserver = jest.fn(() => ({
			observe,
			unobserve: jest.fn(),
			disconnect,
		}));
		try {
			const { controller, cleanups } = createSut();
			const seekEl = createSeekEl(200);

			controller.mount(seekEl);
			expect(observe).toHaveBeenCalledWith(seekEl);

			at(cleanups, 0)();
			expect(disconnect).toHaveBeenCalled();
		} finally {
			globalThis.ResizeObserver = original;
		}
	});

	it('ignores a progress update before anything is mounted', () => {
		const { controller } = createSut();

		expect(() => {
			controller.setProgress(0.5);
		}).not.toThrow();
	});
});

describe('scheduleLoad without IntersectionObserver', () => {
	const original = globalThis.IntersectionObserver;

	beforeEach(() => {
		// jsdom has none, but be explicit: this is the branch under test.
		Reflect.deleteProperty(globalThis, 'IntersectionObserver');
	});

	afterEach(() => {
		globalThis.IntersectionObserver = original;
	});

	it('decodes at once, so the waveform still appears', async () => {
		const { controller, readBinary } = createSut();
		controller.mount(createSeekEl(200));

		controller.scheduleLoad(document.createElement('div'));
		await tick();

		expect(readBinary).toHaveBeenCalled();
	});
});

describe('scheduleLoad with IntersectionObserver', () => {
	let observers: {
		callback: IntersectionObserverCallback;
		observe: jest.Mock;
		disconnect: jest.Mock;
	}[];
	const original = globalThis.IntersectionObserver;

	beforeEach(() => {
		observers = [];
		globalThis.IntersectionObserver = jest.fn(
			(callback: IntersectionObserverCallback) => {
				const entry = {
					callback,
					observe: jest.fn(),
					disconnect: jest.fn(),
					unobserve: jest.fn(),
					takeRecords: jest.fn(),
				};
				observers.push(entry);
				return entry;
			},
		) as unknown as typeof IntersectionObserver;
	});

	afterEach(() => {
		globalThis.IntersectionObserver = original;
	});

	/** Delivers an intersection event to the observer at the given index. */
	function intersect(index: number, isIntersecting: boolean): void {
		const observer = at(observers, index);
		observer.callback(
			[{ isIntersecting } as IntersectionObserverEntry],
			{} as IntersectionObserver,
		);
	}

	it('waits for the player to come near the viewport before decoding', async () => {
		const { controller, readBinary } = createSut();
		controller.mount(createSeekEl(200));
		const observeEl = document.createElement('div');

		controller.scheduleLoad(observeEl);
		await tick();

		expect(at(observers, 0).observe).toHaveBeenCalledWith(observeEl);
		expect(readBinary).not.toHaveBeenCalled();
	});

	it('ignores an event that reports the player is still off screen', async () => {
		const { controller, readBinary } = createSut();
		controller.mount(createSeekEl(200));
		controller.scheduleLoad(document.createElement('div'));

		intersect(0, false);
		await tick();

		expect(readBinary).not.toHaveBeenCalled();
	});

	it('decodes once the player comes into view, then stops observing', async () => {
		const { controller, readBinary } = createSut();
		controller.mount(createSeekEl(200));
		controller.scheduleLoad(document.createElement('div'));

		intersect(0, true);
		await tick();

		expect(readBinary).toHaveBeenCalledTimes(1);
		expect(at(observers, 0).disconnect).toHaveBeenCalled();
	});

	it('decodes only once even if the observer fires again', async () => {
		const { controller, readBinary } = createSut();
		controller.mount(createSeekEl(200));
		controller.scheduleLoad(document.createElement('div'));

		intersect(0, true);
		await tick();
		intersect(0, true);
		await tick();

		expect(readBinary).toHaveBeenCalledTimes(1);
	});

	it('ignores an observer the next render replaced', async () => {
		const { controller, readBinary } = createSut();
		controller.mount(createSeekEl(200));
		controller.scheduleLoad(document.createElement('div'));
		// A re-render installs a second observer; the first is stale.
		controller.scheduleLoad(document.createElement('div'));

		intersect(0, true);
		await tick();

		expect(readBinary).not.toHaveBeenCalled();
	});

	it('disconnects on re-render through the render cleanup', () => {
		const { controller, cleanups } = createSut();
		controller.mount(createSeekEl(200));
		controller.scheduleLoad(document.createElement('div'));

		for (const cleanup of cleanups) {
			cleanup();
		}

		expect(at(observers, 0).disconnect).toHaveBeenCalled();
	});
});

describe('the decode pipeline', () => {
	beforeEach(() => {
		jest.useFakeTimers();
	});

	afterEach(() => {
		jest.useRealTimers();
	});

	/** Loads through the no-IntersectionObserver path, which decodes at once. */
	async function load(
		sut: ReturnType<typeof createSut>,
		seekEl: HTMLElement,
	): Promise<void> {
		const original = globalThis.IntersectionObserver;
		Reflect.deleteProperty(globalThis, 'IntersectionObserver');
		try {
			sut.controller.mount(seekEl);
			sut.controller.scheduleLoad(document.createElement('div'));
			// The peaks are computed in 64 chunks that yield between them, and
			// the draw retries across animation frames after that.
			await jest.runAllTimersAsync();
		} finally {
			globalThis.IntersectionObserver = original;
		}
	}

	it('draws the peaks it computed', async () => {
		const sut = createSut();
		const seekEl = createSeekEl(200);

		await load(sut, seekEl);

		expect(sut.decode).toHaveBeenCalled();
		expect(seekEl.querySelector('canvas')).not.toBeNull();
		// Bars were painted, not just peaks stored.
		expect(canvas.rects.length).toBeGreaterThan(0);
	});

	it('caches the peaks under the file path, size, and mtime', async () => {
		const sut = createSut();

		await load(sut, createSeekEl(200));

		const key = waveformCacheKey(
			sut.file.path,
			sut.file.stat.mtime,
			sut.file.stat.size,
		);
		expect(sut.cache.get(key)).toBeDefined();
	});

	it('reuses cached peaks instead of reading the file again', async () => {
		const cache = new WaveformPeakCache();
		const file = createFile('a.wav', { size: 4096, mtime: 100 });
		cache.set(
			waveformCacheKey(file.path, file.stat.mtime, file.stat.size),
			Array.from({ length: WAVEFORM_CACHE_BUCKETS }, () => 0.5),
		);
		const sut = createSut({ file, cache });

		await load(sut, createSeekEl(200));

		expect(sut.readBinary).not.toHaveBeenCalled();
		expect(sut.decode).not.toHaveBeenCalled();
	});

	it('leaves the seekable bar alone when the decode throws', async () => {
		const warn = jest
			.spyOn(console, 'warn')
			.mockImplementation(() => undefined);
		const sut = createSut({
			decode: () => Promise.reject(new Error('not audio')),
		});

		await load(sut, createSeekEl(200));

		// No visible error: the player still works, it just has no waveform.
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining('Failed to build waveform'),
			expect.any(Error),
		);
	});

	it('leaves the seekable bar alone when the file cannot be read', async () => {
		const warn = jest
			.spyOn(console, 'warn')
			.mockImplementation(() => undefined);
		const sut = createSut();
		sut.readBinary.mockRejectedValue(new Error('gone'));

		await load(sut, createSeekEl(200));

		expect(warn).toHaveBeenCalled();
	});

	it.each([
		{ name: 'before the file is read', afterCalls: 0 },
		{ name: 'after the file is read', afterCalls: 1 },
		{ name: 'after the peaks are computed', afterCalls: 2 },
	])(
		'abandons the decode when the player unloads $name',
		async ({ afterCalls }) => {
			let calls = 0;
			const sut = createSut({
				unloaded: () => calls++ >= afterCalls,
			});

			await load(sut, createSeekEl(200));

			// Whatever stage it stopped at, nothing was cached and nothing threw.
			const key = waveformCacheKey(
				sut.file.path,
				sut.file.stat.mtime,
				sut.file.stat.size,
			);
			expect(sut.cache.get(key)).toBeUndefined();
		},
	);
});

describe('drawing once the seek area has a width', () => {
	beforeEach(() => {
		jest.useFakeTimers();
	});

	afterEach(() => {
		jest.useRealTimers();
	});

	/** Loads through the immediate path and drains every queued timer. */
	async function loadInto(
		sut: ReturnType<typeof createSut>,
		seekEl: HTMLElement,
	): Promise<void> {
		const original = globalThis.IntersectionObserver;
		Reflect.deleteProperty(globalThis, 'IntersectionObserver');
		try {
			sut.controller.mount(seekEl);
			sut.controller.scheduleLoad(document.createElement('div'));
			await jest.runAllTimersAsync();
		} finally {
			globalThis.IntersectionObserver = original;
		}
	}

	it('gives up after a bounded number of frames rather than spinning', async () => {
		const raf = jest.spyOn(window, 'requestAnimationFrame');
		const sut = createSut();

		await loadInto(sut, createSeekEl(0));

		// One frame per retry and no more: a seek area that never gets a width
		// must not keep a callback alive for the life of the note.
		expect(raf).toHaveBeenCalledTimes(PLAYER_WAVEFORM_REDRAW_RETRIES);
	});

	it('stops retrying as soon as the width settles', async () => {
		const raf = jest.spyOn(window, 'requestAnimationFrame');
		const sut = createSut();
		const seekEl = createSeekEl(0);
		// The layout settles one frame in, which is the case this retry loop
		// exists for.
		let frames = 0;
		jest.spyOn(window, 'requestAnimationFrame').mockImplementation(
			(callback) => {
				frames += 1;
				setWidth(seekEl, 300);
				return window.setTimeout(() => callback(0), 16);
			},
		);

		await loadInto(sut, seekEl);

		expect(frames).toBe(1);
		expect(raf).toHaveBeenCalledTimes(1);
	});

	it('does not queue a frame at all when the width is already known', async () => {
		const raf = jest.spyOn(window, 'requestAnimationFrame');
		const sut = createSut();

		await loadInto(sut, createSeekEl(240));

		expect(raf).not.toHaveBeenCalled();
	});

	it('cancels the pending frame through the render cleanup', async () => {
		const cancel = jest.spyOn(window, 'cancelAnimationFrame');
		const sut = createSut();
		const seekEl = createSeekEl(0);
		const original = globalThis.IntersectionObserver;
		Reflect.deleteProperty(globalThis, 'IntersectionObserver');
		try {
			sut.controller.mount(seekEl);
			sut.controller.scheduleLoad(document.createElement('div'));
			// Far enough for the peaks to land and the first frame to be
			// queued, but not so far that the retries run out.
			await jest.advanceTimersByTimeAsync(200);
		} finally {
			globalThis.IntersectionObserver = original;
		}

		for (const cleanup of sut.cleanups) {
			cleanup();
		}

		expect(cancel).toHaveBeenCalled();
	});
});
