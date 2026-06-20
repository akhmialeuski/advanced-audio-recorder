/**
 * Waveform rendering for the enhanced audio player. Owns the canvas layer of
 * the seek area and keeps per-frame work off the playback hot path: the
 * waveform shape is drawn once and redrawn only when the peaks change or the
 * area is resized, while the playback position is reflected by updating a
 * single inherited CSS variable that clips an accent-colored overlay canvas.
 *
 * This avoids the forced layout (reading clientWidth), the canvas
 * reallocation (assigning canvas.width), and the peak re-downsampling that
 * redrawing the whole waveform on every timeupdate would otherwise incur.
 * @module player/views/WaveformCanvas
 */

import {
	PLAYER_WAVEFORM_BARS_PER_100PX,
	PLAYER_WAVEFORM_FALLBACK_PLAYED,
	PLAYER_WAVEFORM_FALLBACK_UNPLAYED,
	PLAYER_WAVEFORM_FALLBACK_WIDTH_PX,
	PLAYER_WAVEFORM_HEIGHT,
} from '../../constants';
import { downsamplePeaks } from '../WaveformData';

/** Minimum number of waveform bars regardless of the rendered width. */
const MIN_WAVEFORM_BARS = 32;

/** Fraction of a bar's width left as a gap between bars. */
const BAR_GAP_FRACTION = 0.2;

/** Vertical padding (px) kept inside the canvas so bars never touch the edge. */
const BAR_VERTICAL_INSET = 2;

/**
 * Renders the waveform into a seek area and reflects playback progress
 * cheaply. Two stacked canvases hold the unplayed (base) and played (accent)
 * renderings of the same bars; a CSS clip on the played canvas reveals it up
 * to the current position, so moving the playhead never touches a canvas.
 */
export class WaveformCanvas {
	private readonly baseCanvas: HTMLCanvasElement;
	private readonly playedCanvas: HTMLCanvasElement;
	private peaks: number[] | null = null;
	/** Downsampled bars cached for the width they were computed at. */
	private barsCache: { width: number; bars: number[] } | null = null;
	/** Cached theme colors; refreshed on demand (e.g. after a resize). */
	private colors: { played: string; unplayed: string } | null = null;

	/**
	 * @param seekEl - The seek area element that hosts the waveform layer
	 */
	constructor(private readonly seekEl: HTMLElement) {
		this.seekEl.setCssProps({
			'--aar-waveform-height': `${String(PLAYER_WAVEFORM_HEIGHT)}px`,
		});
		const layer = this.seekEl.createDiv({ cls: 'aar-player-waveform' });
		this.baseCanvas = layer.createEl('canvas', {
			cls: 'aar-player-canvas',
		});
		this.playedCanvas = layer.createEl('canvas', {
			cls: 'aar-player-canvas aar-player-canvas-played',
		});
	}

	/**
	 * Stores new peaks and redraws the waveform. Safe to call repeatedly with
	 * progressive snapshots as peaks are computed.
	 * @param peaks - Normalized peaks (0..1) at the cache resolution
	 */
	setPeaks(peaks: number[]): void {
		this.peaks = peaks;
		this.barsCache = null;
		this.redraw();
	}

	/** Whether peaks have been supplied yet. */
	hasPeaks(): boolean {
		return this.peaks !== null;
	}

	/**
	 * Reflects the played fraction by updating the clip variable only. No
	 * canvas work happens here, so this is safe to call on every timeupdate.
	 * @param fraction - Played fraction in 0..1
	 */
	setProgress(fraction: number): void {
		const clamped = Math.min(1, Math.max(0, fraction));
		this.seekEl.setCssProps({
			'--aar-progress': `${String(clamped * 100)}%`,
		});
	}

	/**
	 * Invalidates the cached theme colors so the next redraw re-reads them
	 * (e.g. after a theme change detected on resize).
	 */
	invalidateColors(): void {
		this.colors = null;
	}

	/**
	 * Redraws both canvases at the current width. No-op until peaks exist or
	 * while the seek area has no measurable width. Cheap enough to call on
	 * resize, but never called on a mere position change.
	 */
	redraw(): void {
		if (!this.peaks) {
			return;
		}
		const cssWidth = this.seekEl.clientWidth;
		if (cssWidth === 0) {
			return;
		}
		const cssHeight = PLAYER_WAVEFORM_HEIGHT;
		const bars = this.barsForWidth(cssWidth);
		const { played, unplayed } = this.resolveColors();
		this.paint(this.baseCanvas, bars, cssWidth, cssHeight, unplayed);
		this.paint(this.playedCanvas, bars, cssWidth, cssHeight, played);
	}

	/**
	 * Downsamples the peaks to the bar count for a width, reusing the cached
	 * result when the width is unchanged so a redraw never re-downsamples.
	 * @param cssWidth - Current CSS width of the seek area
	 */
	private barsForWidth(cssWidth: number): number[] {
		if (this.barsCache && this.barsCache.width === cssWidth) {
			return this.barsCache.bars;
		}
		const bars = downsamplePeaks(
			this.peaks ?? [],
			this.bucketCount(cssWidth),
		);
		this.barsCache = { width: cssWidth, bars };
		return bars;
	}

	/**
	 * Derives the number of bars from the width so the resolution matches the
	 * rendered size.
	 * @param cssWidth - Current CSS width of the seek area
	 */
	private bucketCount(cssWidth: number): number {
		const width = cssWidth || PLAYER_WAVEFORM_FALLBACK_WIDTH_PX;
		return Math.max(
			MIN_WAVEFORM_BARS,
			Math.floor((width / 100) * PLAYER_WAVEFORM_BARS_PER_100PX),
		);
	}

	/**
	 * Paints the bars onto a canvas at device-pixel resolution in one color.
	 * @param canvas - Target canvas
	 * @param bars - Downsampled bar heights (0..1)
	 * @param cssWidth - CSS width
	 * @param cssHeight - CSS height
	 * @param color - Fill color for every bar
	 */
	private paint(
		canvas: HTMLCanvasElement,
		bars: number[],
		cssWidth: number,
		cssHeight: number,
		color: string,
	): void {
		const dpr = activeWindow.devicePixelRatio || 1;
		canvas.width = Math.floor(cssWidth * dpr);
		canvas.height = Math.floor(cssHeight * dpr);
		const ctx = canvas.getContext('2d');
		if (!ctx) {
			return;
		}
		ctx.scale(dpr, dpr);
		ctx.clearRect(0, 0, cssWidth, cssHeight);
		const barCount = bars.length;
		if (barCount === 0) {
			return;
		}
		const barWidth = cssWidth / barCount;
		const gap = Math.min(1, barWidth * BAR_GAP_FRACTION);
		ctx.fillStyle = color;
		for (let i = 0; i < barCount; i++) {
			const barHeight = Math.max(
				1,
				bars[i] * (cssHeight - BAR_VERTICAL_INSET),
			);
			const x = i * barWidth;
			const y = (cssHeight - barHeight) / 2;
			ctx.fillRect(x, y, Math.max(1, barWidth - gap), barHeight);
		}
	}

	/**
	 * Resolves the played/unplayed colors from the theme once and caches
	 * them, since they do not change during playback.
	 */
	private resolveColors(): { played: string; unplayed: string } {
		if (this.colors) {
			return this.colors;
		}
		const styles = activeWindow.getComputedStyle(this.baseCanvas);
		this.colors = {
			played:
				styles.getPropertyValue('--aar-waveform-played').trim() ||
				PLAYER_WAVEFORM_FALLBACK_PLAYED,
			unplayed:
				styles.getPropertyValue('--aar-waveform-unplayed').trim() ||
				PLAYER_WAVEFORM_FALLBACK_UNPLAYED,
		};
		return this.colors;
	}
}
