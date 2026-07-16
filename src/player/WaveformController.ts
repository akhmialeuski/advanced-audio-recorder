/**
 * Progressive waveform decode and rendering for one player: decides when
 * the waveform applies, defers the decode until the player is near the
 * viewport, computes (or reuses cached) peaks, and drives the canvas as
 * they fill in. The seek area itself and what seeking does stay with the
 * player.
 * @module player/WaveformController
 */

import type { App, TFile } from 'obsidian';
import {
	PLUGIN_LOG_PREFIX,
	WAVEFORM_CACHE_BUCKETS,
	PLAYER_WAVEFORM_REDRAW_RETRIES,
	PLAYER_WAVEFORM_PREFETCH_MARGIN_PX,
} from '../constants';
import { getMaxDecodeBytes } from '../platform/capabilities';
import {
	computeWaveformPeaksProgressive,
	waveformCacheKey,
	WaveformPeakCache,
	type AudioDecoder,
} from './WaveformData';
import { WaveformCanvas } from './views/WaveformCanvas';

/** Lifecycle hooks the controller needs from the player. */
export interface WaveformHost {
	/** Registers a cleanup tied to the current render pass. */
	registerRenderCleanup(cleanup: () => void): void;
	/** True once the player is torn down; async work must stop. */
	isUnloaded(): boolean;
}

/**
 * Owns the waveform canvas and its decode pipeline for one player.
 */
export class WaveformController {
	/** Waveform renderer, or null when the plain bar is shown. */
	private canvas: WaveformCanvas | null = null;
	/** Observer that defers the waveform decode until the player is on screen. */
	private observer: IntersectionObserver | null = null;
	/** The seek area hosting the canvas for the current render. */
	private seekEl: HTMLElement | null = null;

	constructor(
		private readonly app: App,
		private readonly file: TFile,
		private readonly decoder: AudioDecoder,
		private readonly peakCache: WaveformPeakCache,
		private readonly host: WaveformHost,
	) {}

	/**
	 * Whether the waveform should be drawn for this file. It is shown for files
	 * up to a platform-dependent safety ceiling (far lower on mobile, whose
	 * WebView gets a small memory budget); an oversized file falls back to the
	 * plain (still seekable) bar instead, because decoding it for a cosmetic
	 * waveform would risk an out-of-memory spike. Realistic recordings stay
	 * well under the ceiling and are still drawn progressively.
	 * @param showWaveform - The waveform window toggle from settings
	 */
	shouldRender(showWaveform: boolean): boolean {
		return showWaveform && this.file.stat.size <= getMaxDecodeBytes();
	}

	/**
	 * Drops the canvas and seek-area refs at the start of a render pass.
	 * Without this, toggling the waveform off would leave a stale renderer
	 * so progress updates would target the dead canvas and never update the
	 * new progress bar. The observers themselves are torn down by the
	 * render-scoped cleanups.
	 */
	reset(): void {
		this.canvas = null;
		this.seekEl = null;
	}

	/**
	 * Creates the canvas inside the seek area and keeps it redrawn on
	 * resize (re-reading theme colors in case the theme changed).
	 * @param seekEl - The seek area element for the current render
	 */
	mount(seekEl: HTMLElement): void {
		this.seekEl = seekEl;
		this.canvas = new WaveformCanvas(seekEl);
		const resizeObserver = new ResizeObserver(() => {
			// Re-read theme colors in case the theme changed, then redraw
			this.canvas?.invalidateColors();
			this.canvas?.redraw();
		});
		resizeObserver.observe(seekEl);
		this.host.registerRenderCleanup(() => {
			resizeObserver.disconnect();
		});
	}

	/** Whether the waveform canvas is mounted for the current render. */
	isMounted(): boolean {
		return this.canvas !== null;
	}

	/**
	 * Moves the played-portion clip on the canvas (cheap; no canvas work).
	 * @param fraction - Playback progress in [0, 1]
	 */
	setProgress(fraction: number): void {
		this.canvas?.setProgress(fraction);
	}

	/**
	 * Decodes the waveform lazily: a long note with several recordings must not
	 * decode every embed up front. Waits until the player is near the viewport
	 * (IntersectionObserver), then decodes once. Environments without
	 * IntersectionObserver decode immediately so the waveform still appears. The
	 * observer is torn down on re-render and on unload.
	 * @param observeEl - The player container to watch for visibility
	 */
	scheduleLoad(observeEl: HTMLElement): void {
		// typeof is safe even where IntersectionObserver is undeclared (tests,
		// non-DOM hosts); there, decode immediately so the waveform still shows
		if (typeof IntersectionObserver === 'undefined') {
			void this.load();
			return;
		}
		const observer = new IntersectionObserver(
			(entries) => {
				if (!entries.some((entry) => entry.isIntersecting)) {
					return;
				}
				// One-shot: ignore any later callback for a consumed/replaced
				// observer, then decode once and stop observing
				if (this.observer !== observer) {
					return;
				}
				observer.disconnect();
				this.observer = null;
				void this.load();
			},
			{ rootMargin: `${String(PLAYER_WAVEFORM_PREFETCH_MARGIN_PX)}px` },
		);
		this.observer = observer;
		observer.observe(observeEl);
		// Scoped to this render: a re-render or unload disconnects it, so a
		// stale observer never decodes into a replaced player
		this.host.registerRenderCleanup(() => {
			observer.disconnect();
			if (this.observer === observer) {
				this.observer = null;
			}
		});
	}

	/**
	 * Decodes the file and computes (or reuses cached) waveform peaks. The
	 * peaks are computed progressively off the main thread's hot path and the
	 * waveform is drawn as they fill in. A decode failure falls back silently
	 * to the plain, still-seekable bar.
	 */
	private async load(): Promise<void> {
		// Cache at a fixed resolution independent of width, so resizing or
		// switching view modes redraws from cache instead of re-decoding
		const cacheKey = waveformCacheKey(
			this.file.path,
			this.file.stat.mtime,
			this.file.stat.size,
		);
		const cached = this.peakCache.get(cacheKey);
		if (cached) {
			this.applyPeaks(cached);
			return;
		}
		try {
			const data = await this.app.vault.readBinary(this.file);
			if (this.host.isUnloaded()) {
				return;
			}
			const audioBuffer = await this.decoder.decode(data);
			if (this.host.isUnloaded()) {
				return;
			}
			const channels: Float32Array[] = [];
			for (let i = 0; i < audioBuffer.numberOfChannels; i++) {
				channels.push(audioBuffer.getChannelData(i));
			}
			const peaks = await computeWaveformPeaksProgressive(
				channels,
				WAVEFORM_CACHE_BUCKETS,
				{
					// Draw each partial result so the waveform fills in
					onProgress: (snapshot) => {
						if (!this.host.isUnloaded()) {
							this.canvas?.setPeaks(snapshot);
						}
					},
					shouldAbort: () => this.host.isUnloaded(),
				},
			);
			if (this.host.isUnloaded()) {
				return;
			}
			this.peakCache.set(cacheKey, peaks);
			this.applyPeaks(peaks);
		} catch (error) {
			// Leave the (still seekable) bar without a waveform; no visible
			// error - the player keeps working
			console.warn(
				`${PLUGIN_LOG_PREFIX} Failed to build waveform for ${this.file.path}:`,
				error,
			);
		}
	}

	/**
	 * Hands final peaks to the waveform and ensures they are drawn once the
	 * seek area has a measurable width.
	 * @param peaks - Normalized peaks
	 */
	private applyPeaks(peaks: number[]): void {
		if (!this.canvas || this.host.isUnloaded()) {
			return;
		}
		this.canvas.setPeaks(peaks);
		this.redrawWhenSized();
	}

	/**
	 * Draws the waveform once the seek area has a measurable width. On first
	 * render the canvas can be laid out a frame or two after the peaks are
	 * ready (width still 0), so a plain draw would no-op. Retry across a few
	 * animation frames until the width settles.
	 * @param attempts - Remaining retries before giving up
	 */
	private redrawWhenSized(attempts = PLAYER_WAVEFORM_REDRAW_RETRIES): void {
		if (!this.canvas || !this.canvas.hasPeaks() || this.host.isUnloaded()) {
			return;
		}
		if (this.seekEl && this.seekEl.clientWidth > 0) {
			this.canvas.redraw();
			return;
		}
		if (attempts <= 0) {
			return;
		}
		const rafId = window.requestAnimationFrame(() => {
			this.redrawWhenSized(attempts - 1);
		});
		// Cancel outright on re-render/unload instead of relying on the
		// unloaded flag alone to fizzle the retry chain.
		this.host.registerRenderCleanup(() => {
			window.cancelAnimationFrame(rafId);
		});
	}
}
