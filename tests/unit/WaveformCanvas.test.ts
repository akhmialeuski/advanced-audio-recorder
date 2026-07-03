/**
 * Unit tests for the waveform renderer. The central regression guard is that
 * moving the playhead (setProgress) does no canvas work - it only updates the
 * clip variable - so playback never re-rasterizes or re-downsamples the
 * waveform, which is what made large notes janky before.
 */

import { App, Modal } from 'obsidian';
import { WaveformCanvas } from 'src/player/views/WaveformCanvas';
import * as WaveformData from 'src/player/WaveformData';

/** Builds an Obsidian-extended seek element with a non-zero width. */
function makeSeekEl(): HTMLElement {
	const seekEl = new Modal(new App()).contentEl.createDiv({
		cls: 'aar-player-seek',
	});
	Object.defineProperty(seekEl, 'clientWidth', {
		value: 600,
		configurable: true,
	});
	return seekEl;
}

describe('WaveformCanvas', () => {
	it('mounts a base and a played canvas in a positioned layer', () => {
		const seekEl = makeSeekEl();
		new WaveformCanvas(seekEl);
		expect(seekEl.querySelector('.aar-player-waveform')).not.toBeNull();
		const canvases = seekEl.querySelectorAll('canvas');
		expect(canvases).toHaveLength(2);
		expect(canvases[0].classList.contains('aar-player-canvas')).toBe(true);
		expect(canvases[1].classList.contains('aar-player-canvas-played')).toBe(
			true,
		);
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
		try {
			const waveform = new WaveformCanvas(seekEl);
			waveform.setPeaks(new Array<number>(2048).fill(0.5));
			const callsAfterSet = spy.mock.calls.length;
			expect(callsAfterSet).toBeGreaterThanOrEqual(1);
			// Same width: redraw reuses the cached bars, no re-downsample
			waveform.redraw();
			expect(spy.mock.calls.length).toBe(callsAfterSet);
		} finally {
			spy.mockRestore();
		}
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
});
