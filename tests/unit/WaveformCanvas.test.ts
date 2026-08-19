/**
 * Unit tests for the waveform renderer. The central regression guard is that
 * moving the playhead (setProgress) does no canvas work - it only updates the
 * clip variable - so playback never re-rasterizes or re-downsamples the
 * waveform, which is what made large notes janky before.
 */

import { App, Modal } from 'obsidian';
import { at } from '../helpers/assertions';
import { WaveformCanvas } from 'src/player/views/WaveformCanvas';
import * as WaveformData from 'src/player/WaveformData';
import { installCanvas2dContext } from '../helpers/canvas';
import type { CanvasContextDouble } from '../helpers/canvas';
import { maybeEl } from '../helpers/dom';
import { PLAYER } from '../helpers/selectors';

let canvas: CanvasContextDouble;

beforeEach(() => {
	// jsdom's getContext throws unless the native canvas package is present,
	// so the painting half of this renderer could never run under test.
	canvas = installCanvas2dContext();
});

afterEach(() => {
	canvas.restore();
});

/** Builds an Obsidian-extended seek element with a width a test controls. */
function makeSeekEl(width = 600): HTMLElement {
	const seekEl = new Modal(new App()).contentEl.createDiv({
		cls: 'aar-player-seek',
	});
	Object.defineProperty(seekEl, 'clientWidth', {
		value: width,
		configurable: true,
	});
	return seekEl;
}

describe('WaveformCanvas', () => {
	it('mounts a base and a played canvas in a positioned layer', () => {
		const seekEl = makeSeekEl();
		new WaveformCanvas(seekEl);
		expect(maybeEl(seekEl, PLAYER.waveform)).not.toBeNull();
		const canvases = seekEl.querySelectorAll('canvas');
		expect(canvases).toHaveLength(2);
		expect(at(canvases, 0).classList.contains('aar-player-canvas')).toBe(
			true,
		);
		expect(
			at(canvases, 1).classList.contains('aar-player-canvas-played'),
		).toBe(true);
	});

	it('updates only the progress variable on setProgress (no canvas work)', () => {
		const seekEl = makeSeekEl();
		const waveform = new WaveformCanvas(seekEl);
		waveform.setPeaks([0.2, 0.4, 0.8, 1]);
		const base = seekEl.querySelector('canvas') as HTMLCanvasElement;
		const widthAfterDraw = base.width;
		expect(widthAfterDraw).toBeGreaterThan(0);

		waveform.setProgress(0.5);
		expect(seekEl.style.getPropertyValue('--aar-progress')).toBe('50%');
		// The canvas is not reallocated when only the position changes
		expect(base.width).toBe(widthAfterDraw);
	});

	it('clamps the progress fraction to 0..1', () => {
		const seekEl = makeSeekEl();
		const waveform = new WaveformCanvas(seekEl);
		waveform.setProgress(2);
		expect(seekEl.style.getPropertyValue('--aar-progress')).toBe('100%');
		waveform.setProgress(-1);
		expect(seekEl.style.getPropertyValue('--aar-progress')).toBe('0%');
	});

	it('downsamples once per width and reuses the cache on redraw', () => {
		const seekEl = makeSeekEl();
		const spy = jest.spyOn(WaveformData, 'downsamplePeaks');
		const waveform = new WaveformCanvas(seekEl);
		waveform.setPeaks(new Array<number>(2048).fill(0.5));
		const callsAfterSet = spy.mock.calls.length;
		expect(callsAfterSet).toBeGreaterThanOrEqual(1);
		// Same width: redraw reuses the cached bars, no re-downsample
		waveform.redraw();
		expect(spy.mock.calls).toHaveLength(callsAfterSet);
	});

	it('does not draw before peaks are set', () => {
		const seekEl = makeSeekEl();
		const waveform = new WaveformCanvas(seekEl);
		waveform.redraw();
		expect(waveform.hasPeaks()).toBe(false);
	});

	it('reports peaks once supplied', () => {
		const seekEl = makeSeekEl();
		const waveform = new WaveformCanvas(seekEl);
		waveform.setPeaks([0.1, 0.2]);
		expect(waveform.hasPeaks()).toBe(true);
	});

	it('paints a bar per downsampled peak, inset and gapped', () => {
		const waveform = new WaveformCanvas(makeSeekEl(600));

		waveform.setPeaks([0.25, 0.5, 1]);

		// Two canvases are painted per redraw - the unplayed base and the
		// played overlay - and the recorder keeps only the last clear's worth.
		expect(canvas.rects.length).toBeGreaterThan(0);
		for (const rect of canvas.rects) {
			expect(rect.width).toBeGreaterThan(0);
			expect(rect.height).toBeGreaterThanOrEqual(1);
		}
	});

	it('gives a silent peak a visible sliver rather than nothing', () => {
		const waveform = new WaveformCanvas(makeSeekEl(600));

		waveform.setPeaks(new Array<number>(120).fill(0));

		// A bar of height zero would leave a gap in the waveform where silence
		// is; a one-pixel bar reads as "quiet here" instead.
		expect(canvas.rects.every((rect) => rect.height >= 1)).toBe(true);
	});

	it('scales the canvas to the device pixel ratio', () => {
		Object.defineProperty(window, 'devicePixelRatio', {
			configurable: true,
			value: 2,
		});
		const seekEl = makeSeekEl(600);

		new WaveformCanvas(seekEl).setPeaks([0.5, 0.5]);

		const base = seekEl.querySelector('canvas') as HTMLCanvasElement;
		expect(base.width).toBe(1200);
	});

	it('re-reads the theme colours after they are invalidated', () => {
		const seekEl = makeSeekEl(600);
		const waveform = new WaveformCanvas(seekEl);
		waveform.setPeaks([0.5, 0.5]);
		const computed = jest.spyOn(window, 'getComputedStyle');

		waveform.redraw();
		const cachedCalls = computed.mock.calls.length;
		waveform.invalidateColors();
		waveform.redraw();

		expect(computed.mock.calls.length).toBeGreaterThan(cachedCalls);
	});

	it('does not redraw while the seek area has no width', () => {
		const waveform = new WaveformCanvas(makeSeekEl(0));

		waveform.setPeaks([0.5, 0.5]);

		// Painting into a zero-width canvas would allocate nothing useful and
		// throw the cached bars away for a width that is about to change.
		expect(canvas.rects).toHaveLength(0);
	});

	it('re-downsamples when the width changes', () => {
		const spy = jest.spyOn(WaveformData, 'downsamplePeaks');
		const seekEl = makeSeekEl(600);
		const waveform = new WaveformCanvas(seekEl);
		waveform.setPeaks(new Array<number>(2048).fill(0.5));
		const afterFirst = spy.mock.calls.length;

		Object.defineProperty(seekEl, 'clientWidth', {
			value: 300,
			configurable: true,
		});
		waveform.redraw();

		expect(spy.mock.calls.length).toBeGreaterThan(afterFirst);
	});

	it('paints nothing when the canvas has no 2d context', () => {
		const seekEl = makeSeekEl(600);
		const waveform = new WaveformCanvas(seekEl);
		// A context the browser refuses to give (memory pressure, a lost
		// context) must degrade to no waveform, not to a thrown render.
		jest.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
			null,
		);

		expect(() => {
			waveform.setPeaks([0.5, 0.5]);
		}).not.toThrow();
		expect(canvas.rects).toHaveLength(0);
	});

	it('paints nothing for an empty peak list', () => {
		const waveform = new WaveformCanvas(makeSeekEl(600));

		waveform.setPeaks([]);

		expect(waveform.hasPeaks()).toBe(true);
		expect(canvas.rects).toHaveLength(0);
	});
});
