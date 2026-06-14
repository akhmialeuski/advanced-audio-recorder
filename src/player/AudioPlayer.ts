/**
 * Enhanced audio player rendered in place of Obsidian's built-in audio
 * embed. Adds a waveform (or seek bar), playback-speed control, skip
 * buttons, a volume control, loop, a time display, and a "copy
 * timestamp link" action. Implemented as a MarkdownRenderChild so its
 * lifecycle (event listeners, audio element, registry registration,
 * observers) is torn down automatically when the note re-renders or the
 * leaf closes.
 * @module player/AudioPlayer
 */

import { MarkdownRenderChild, Notice, setIcon } from 'obsidian';
import type { App, TFile } from 'obsidian';
import {
	PLUGIN_LOG_PREFIX,
	PLAYER_WAVEFORM_BARS_PER_100PX,
	PLAYER_PLAYBACK_RATE_PRESETS,
} from '../constants';
import { formatTimecode } from '../utils/TimeUtils';
import type { ResolvedPlayerSettings } from '../settings/Settings';
import {
	computeWaveformPeaks,
	waveformCacheKey,
	WaveformPeakCache,
} from './WaveformData';
import type {
	AudioPlayerRegistry,
	SeekablePlayer,
} from './AudioPlayerRegistry';

/**
 * A very large finite time used to coax browsers into computing the
 * real duration of a stream (notably MediaRecorder WebM) that initially
 * reports Infinity. Seeking near the end triggers a durationchange with
 * the true value, after which playback is reset to the start.
 */
const DURATION_PROBE_SECONDS = 1e101;

/**
 * Options passed to a player when it is created for an embed.
 */
export interface AudioPlayerOptions {
	/** Offset in seconds to seek to once metadata is available. */
	startSeconds: number | null;
	/** Vault path of the note hosting the embed (for link generation). */
	sourcePath: string;
}

/**
 * Renders and drives a single enhanced audio player instance.
 */
export class AudioPlayer extends MarkdownRenderChild implements SeekablePlayer {
	private readonly audio: HTMLAudioElement;
	private playButton!: HTMLElement;
	private seekEl!: HTMLElement;
	private canvas: HTMLCanvasElement | null = null;
	private progressFillEl: HTMLElement | null = null;
	private timeEl: HTMLElement | null = null;
	private speedButton: HTMLElement | null = null;
	private peaks: number[] | null = null;
	private isSeeking = false;
	private durationProbeActive = false;
	private resizeObserver: ResizeObserver | null = null;

	/**
	 * @param containerEl - The embed element to take over
	 * @param app - Obsidian App instance
	 * @param file - Audio file to play
	 * @param settings - Sanitized player settings
	 * @param registry - Registry for timecode-link seeking
	 * @param peakCache - Shared waveform peak cache
	 * @param options - Per-embed options (start offset, source note)
	 */
	constructor(
		containerEl: HTMLElement,
		private readonly app: App,
		private readonly file: TFile,
		private readonly settings: ResolvedPlayerSettings,
		private readonly registry: AudioPlayerRegistry,
		private readonly peakCache: WaveformPeakCache,
		private readonly options: AudioPlayerOptions,
	) {
		super(containerEl);
		this.audio = new Audio();
	}

	/**
	 * Builds the player UI, wires events, and starts waveform
	 * extraction. Runs when the render child is attached.
	 */
	onload(): void {
		this.containerEl.empty();
		this.containerEl.addClass('aar-player');
		// The embed element keeps Obsidian's own audio loader alive; an
		// audio child it injects later is removed so our player is the
		// only one shown
		this.guardAgainstDefaultEmbed();

		this.audio.preload = 'metadata';
		this.audio.src = this.app.vault.getResourcePath(this.file);
		this.audio.loop = this.settings.defaultLoop;
		this.audio.playbackRate = this.settings.defaultPlaybackRate;

		this.buildControls();
		this.buildSeekArea();
		this.registerAudioEvents();

		this.registry.register(this.file.path, this);
		this.register(() => {
			this.registry.unregister(this.file.path, this);
		});
		this.register(() => {
			this.audio.pause();
			// Releasing the source lets the browser reclaim the decoder
			this.audio.removeAttribute('src');
			this.audio.load();
		});

		if (this.settings.showWaveform) {
			void this.loadWaveform();
		}
	}

	/**
	 * Seeks to an absolute offset and starts playback. Used both by the
	 * skip buttons and by timecode links via the registry.
	 * @param seconds - Target offset in seconds
	 */
	seekTo(seconds: number): void {
		const target = Math.max(0, seconds);
		const apply = (): void => {
			this.audio.currentTime = Number.isFinite(this.audio.duration)
				? Math.min(target, this.audio.duration)
				: target;
			void this.audio.play().catch(() => {
				// Autoplay can be blocked; the user can press play
			});
		};
		if (this.audio.readyState >= 1) {
			apply();
		} else {
			this.audio.addEventListener('loadedmetadata', apply, {
				once: true,
			});
		}
	}

	/**
	 * Reports whether the player is still attached to the document, so
	 * the registry can prune stale entries.
	 */
	isConnected(): boolean {
		return this.containerEl.isConnected;
	}

	/**
	 * Removes any `audio` element Obsidian's embed loader injects after
	 * we take over, guaranteeing our player is the only one rendered
	 * regardless of post-processor ordering. The observer is scoped to
	 * the embed and disconnected on unload.
	 */
	private guardAgainstDefaultEmbed(): void {
		const observer = new MutationObserver((mutations) => {
			for (const mutation of mutations) {
				mutation.addedNodes.forEach((node) => {
					if (
						node.instanceOf(HTMLAudioElement) &&
						node !== this.audio
					) {
						node.remove();
					}
				});
			}
		});
		observer.observe(this.containerEl, { childList: true });
		this.registerCleanup(() => observer.disconnect());
	}

	/**
	 * Builds the control row (play/pause, skip, speed, volume, loop,
	 * time, copy-timestamp) honoring the enabled-control settings.
	 */
	private buildControls(): void {
		const controls = this.containerEl.createDiv({
			cls: 'aar-player-controls',
		});

		this.playButton = this.createIconButton(
			controls,
			'play',
			'Play / pause',
			() => {
				this.togglePlay();
			},
		);

		if (this.settings.showSkipButtons) {
			this.createIconButton(
				controls,
				'rewind',
				`Back ${String(this.settings.skipSeconds)}s`,
				() => {
					this.skip(-this.settings.skipSeconds);
				},
			);
			this.createIconButton(
				controls,
				'fast-forward',
				`Forward ${String(this.settings.skipSeconds)}s`,
				() => {
					this.skip(this.settings.skipSeconds);
				},
			);
		}

		if (this.settings.showSpeedControl) {
			this.speedButton = controls.createEl('button', {
				cls: 'aar-player-btn aar-player-speed',
				text: this.formatRate(this.settings.defaultPlaybackRate),
			});
			this.speedButton.setAttribute('aria-label', 'Playback speed');
			this.registerDomEvent(this.speedButton, 'click', () => {
				this.cyclePlaybackRate();
			});
		}

		if (this.settings.showVolumeControl) {
			const volume = controls.createEl('input', {
				cls: 'aar-player-volume',
				attr: {
					type: 'range',
					min: '0',
					max: '1',
					step: '0.05',
					value: '1',
					'aria-label': 'Volume',
				},
			});
			this.registerDomEvent(volume, 'input', () => {
				this.audio.volume = Number(volume.value);
			});
		}

		const loopButton = this.createIconButton(
			controls,
			'repeat',
			'Loop',
			() => {
				this.audio.loop = !this.audio.loop;
				loopButton.toggleClass('is-active', this.audio.loop);
			},
		);
		loopButton.toggleClass('is-active', this.audio.loop);

		if (this.settings.showTimeDisplay) {
			this.timeEl = controls.createDiv({ cls: 'aar-player-time' });
			this.timeEl.setText('0:00 / 0:00');
		}

		if (this.settings.enableTimestampLinks) {
			this.createIconButton(
				controls,
				'link',
				'Copy timestamp link',
				() => {
					void this.copyTimestampLink();
				},
			);
		}
	}

	/**
	 * Builds the seek area: a waveform canvas when waveforms are enabled,
	 * otherwise a linear progress bar. Both support click and drag
	 * seeking through the same pointer handlers.
	 */
	private buildSeekArea(): void {
		this.seekEl = this.containerEl.createDiv({ cls: 'aar-player-seek' });
		if (this.settings.showWaveform) {
			this.seekEl.addClass('aar-player-seek-waveform');
			this.seekEl.style.setProperty(
				'--aar-waveform-height',
				`${String(this.settings.waveformHeight)}px`,
			);
			this.canvas = this.seekEl.createEl('canvas', {
				cls: 'aar-player-canvas',
			});
			this.resizeObserver = new ResizeObserver(() => {
				this.drawWaveform();
			});
			this.resizeObserver.observe(this.seekEl);
			this.registerCleanup(() => {
				this.resizeObserver?.disconnect();
				this.resizeObserver = null;
			});
		} else {
			this.seekEl.addClass('aar-player-seek-bar');
			this.progressFillEl = this.seekEl.createDiv({
				cls: 'aar-player-progress-fill',
			});
		}
		this.registerSeekPointer();
	}

	/**
	 * Wires pointer events for click/drag seeking on the seek area. The
	 * move and release listeners live on the document so a drag that
	 * leaves the player still tracks the pointer.
	 */
	private registerSeekPointer(): void {
		this.registerDomEvent(this.seekEl, 'pointerdown', (event) => {
			this.isSeeking = true;
			this.seekToPointer(event);
		});
		this.registerDomEvent(activeDocument, 'pointermove', (event) => {
			if (this.isSeeking) {
				this.seekToPointer(event);
			}
		});
		this.registerDomEvent(activeDocument, 'pointerup', () => {
			this.isSeeking = false;
		});
	}

	/**
	 * Seeks to the position under the pointer along the seek area.
	 * @param event - Pointer event from the seek interaction
	 */
	private seekToPointer(event: PointerEvent): void {
		if (!Number.isFinite(this.audio.duration) || this.audio.duration <= 0) {
			return;
		}
		const rect = this.seekEl.getBoundingClientRect();
		if (rect.width === 0) {
			return;
		}
		const fraction = Math.min(
			1,
			Math.max(0, (event.clientX - rect.left) / rect.width),
		);
		this.audio.currentTime = fraction * this.audio.duration;
		this.updateProgress();
	}

	/**
	 * Subscribes to the audio element's lifecycle events that drive the
	 * UI and resolves an initially-unknown (Infinity) duration.
	 */
	private registerAudioEvents(): void {
		this.registerDomEvent(this.audio, 'loadedmetadata', () => {
			if (!Number.isFinite(this.audio.duration)) {
				this.resolveInfiniteDuration();
			} else {
				this.applyStartOffset();
			}
			this.updateProgress();
		});
		this.registerDomEvent(this.audio, 'timeupdate', () => {
			this.updateProgress();
		});
		this.registerDomEvent(this.audio, 'play', () => {
			setIcon(this.playButton, 'pause');
		});
		this.registerDomEvent(this.audio, 'pause', () => {
			setIcon(this.playButton, 'play');
		});
		this.registerDomEvent(this.audio, 'ended', () => {
			setIcon(this.playButton, 'play');
		});
	}

	/**
	 * Resolves a duration that the browser initially reports as Infinity
	 * (common for MediaRecorder WebM) by probing a far seek position and
	 * waiting for the corrected value, then restoring the start.
	 */
	private resolveInfiniteDuration(): void {
		if (this.durationProbeActive) {
			return;
		}
		this.durationProbeActive = true;
		const onDurationChange = (): void => {
			if (!Number.isFinite(this.audio.duration)) {
				return;
			}
			this.audio.removeEventListener('durationchange', onDurationChange);
			this.durationProbeActive = false;
			this.audio.currentTime = 0;
			this.applyStartOffset();
			this.updateProgress();
		};
		this.audio.addEventListener('durationchange', onDurationChange);
		this.register(() =>
			this.audio.removeEventListener('durationchange', onDurationChange),
		);
		try {
			this.audio.currentTime = DURATION_PROBE_SECONDS;
		} catch {
			// Some sources reject the probe seek; leave the duration
			// unknown and fall back to a non-seekable display
			this.audio.removeEventListener('durationchange', onDurationChange);
			this.durationProbeActive = false;
		}
	}

	/**
	 * Applies the timecode start offset from the embed subpath, once,
	 * after the duration is known.
	 */
	private applyStartOffset(): void {
		if (this.options.startSeconds === null) {
			return;
		}
		const target = this.options.startSeconds;
		this.options.startSeconds = null;
		this.audio.currentTime = Number.isFinite(this.audio.duration)
			? Math.min(target, this.audio.duration)
			: target;
	}

	/**
	 * Decodes the file and computes (or reuses cached) waveform peaks,
	 * skipping files larger than the configured limit to avoid decoding
	 * very large recordings into memory.
	 */
	private async loadWaveform(): Promise<void> {
		if (this.file.stat.size > this.settings.waveformMaxFileSizeBytes) {
			this.seekEl.addClass('aar-player-waveform-skipped');
			return;
		}
		const bucketCount = this.computeBucketCount();
		const cacheKey = waveformCacheKey(
			this.file.path,
			this.file.stat.mtime,
			this.file.stat.size,
			bucketCount,
		);
		const cached = this.peakCache.get(cacheKey);
		if (cached) {
			this.peaks = cached;
			this.drawWaveform();
			return;
		}
		let audioContext: AudioContext | null = null;
		try {
			const data = await this.app.vault.readBinary(this.file);
			if (!this.containerEl.isConnected) {
				return;
			}
			audioContext = new AudioContext();
			const audioBuffer = await audioContext.decodeAudioData(data);
			const channels: Float32Array[] = [];
			for (let i = 0; i < audioBuffer.numberOfChannels; i++) {
				channels.push(audioBuffer.getChannelData(i));
			}
			this.peaks = computeWaveformPeaks(channels, bucketCount);
			this.peakCache.set(cacheKey, this.peaks);
			this.drawWaveform();
		} catch (error) {
			console.warn(
				`${PLUGIN_LOG_PREFIX} Failed to build waveform for ${this.file.path}:`,
				error,
			);
			this.seekEl.addClass('aar-player-waveform-skipped');
		} finally {
			if (audioContext) {
				void audioContext.close().catch(() => {
					// Closing a context that already failed is non-fatal
				});
			}
		}
	}

	/**
	 * Derives the number of waveform bars from the current seek width so
	 * the resolution matches the rendered size.
	 */
	private computeBucketCount(): number {
		const width = this.seekEl.clientWidth || 600;
		return Math.max(
			32,
			Math.floor((width / 100) * PLAYER_WAVEFORM_BARS_PER_100PX),
		);
	}

	/**
	 * Draws the waveform onto the canvas at device-pixel resolution,
	 * coloring the played portion with the accent color and the rest
	 * muted. No-op until peaks are available.
	 */
	private drawWaveform(): void {
		if (!this.canvas || !this.peaks) {
			return;
		}
		const dpr = activeWindow.devicePixelRatio || 1;
		const cssWidth = this.seekEl.clientWidth;
		const cssHeight = this.settings.waveformHeight;
		if (cssWidth === 0) {
			return;
		}
		this.canvas.width = Math.floor(cssWidth * dpr);
		this.canvas.height = Math.floor(cssHeight * dpr);
		const ctx = this.canvas.getContext('2d');
		if (!ctx) {
			return;
		}
		ctx.scale(dpr, dpr);
		ctx.clearRect(0, 0, cssWidth, cssHeight);

		const styles = activeWindow.getComputedStyle(this.canvas);
		const playedColor =
			styles.getPropertyValue('--aar-waveform-played').trim() ||
			'#7c6fda';
		const unplayedColor =
			styles.getPropertyValue('--aar-waveform-unplayed').trim() ||
			'#b3b3b3';

		const barCount = this.peaks.length;
		const barWidth = cssWidth / barCount;
		const gap = Math.min(1, barWidth * 0.2);
		const playedFraction =
			Number.isFinite(this.audio.duration) && this.audio.duration > 0
				? this.audio.currentTime / this.audio.duration
				: 0;
		const playedBars = playedFraction * barCount;

		for (let i = 0; i < barCount; i++) {
			const barHeight = Math.max(1, this.peaks[i] * (cssHeight - 2));
			const x = i * barWidth;
			const y = (cssHeight - barHeight) / 2;
			ctx.fillStyle = i <= playedBars ? playedColor : unplayedColor;
			ctx.fillRect(x, y, Math.max(1, barWidth - gap), barHeight);
		}
	}

	/**
	 * Updates the seek visuals and time display from the current
	 * playback position.
	 */
	private updateProgress(): void {
		if (this.canvas && this.peaks) {
			this.drawWaveform();
		} else if (this.progressFillEl) {
			const fraction =
				Number.isFinite(this.audio.duration) && this.audio.duration > 0
					? this.audio.currentTime / this.audio.duration
					: 0;
			this.progressFillEl.style.width = `${String(fraction * 100)}%`;
		}
		if (this.timeEl) {
			const total = Number.isFinite(this.audio.duration)
				? this.audio.duration
				: 0;
			this.timeEl.setText(
				`${formatTimecode(this.audio.currentTime)} / ${formatTimecode(total)}`,
			);
		}
	}

	/**
	 * Toggles playback, swallowing autoplay-policy rejections.
	 */
	private togglePlay(): void {
		if (this.audio.paused) {
			void this.audio.play().catch((error: unknown) => {
				console.warn(
					`${PLUGIN_LOG_PREFIX} Playback could not start:`,
					error,
				);
			});
		} else {
			this.audio.pause();
		}
	}

	/**
	 * Skips playback by a relative number of seconds, clamped to the
	 * track bounds.
	 * @param deltaSeconds - Signed number of seconds to skip
	 */
	private skip(deltaSeconds: number): void {
		const max = Number.isFinite(this.audio.duration)
			? this.audio.duration
			: this.audio.currentTime + Math.abs(deltaSeconds);
		this.audio.currentTime = Math.min(
			max,
			Math.max(0, this.audio.currentTime + deltaSeconds),
		);
		this.updateProgress();
	}

	/**
	 * Advances the playback rate to the next preset, wrapping around, and
	 * reflects it on the speed button.
	 */
	private cyclePlaybackRate(): void {
		const current = this.audio.playbackRate;
		const index = PLAYER_PLAYBACK_RATE_PRESETS.findIndex(
			(rate) => Math.abs(rate - current) < 1e-6,
		);
		const next =
			PLAYER_PLAYBACK_RATE_PRESETS[
				(index + 1) % PLAYER_PLAYBACK_RATE_PRESETS.length
			];
		this.audio.playbackRate = next;
		if (this.speedButton) {
			this.speedButton.setText(this.formatRate(next));
		}
	}

	/**
	 * Copies a timecode link to the current position, respecting the
	 * vault's link-format preference.
	 */
	private async copyTimestampLink(): Promise<void> {
		const seconds = Math.floor(this.audio.currentTime);
		const link = this.app.fileManager.generateMarkdownLink(
			this.file,
			this.options.sourcePath,
			`#t=${String(seconds)}`,
			formatTimecode(seconds),
		);
		try {
			await navigator.clipboard.writeText(link);
			new Notice(`Copied timestamp link at ${formatTimecode(seconds)}`);
		} catch (error) {
			console.warn(
				`${PLUGIN_LOG_PREFIX} Failed to copy timestamp link:`,
				error,
			);
			new Notice('Could not copy timestamp link to the clipboard.');
		}
	}

	/**
	 * Formats a playback rate for the speed button (e.g. "1.5x").
	 * @param rate - Playback rate multiplier
	 */
	private formatRate(rate: number): string {
		return `${String(rate)}x`;
	}

	/**
	 * Creates an icon button in a container and wires its click handler.
	 * @param container - Parent element
	 * @param icon - Obsidian icon id
	 * @param label - Accessible label / tooltip
	 * @param onClick - Click handler
	 * @returns The created button element
	 */
	private createIconButton(
		container: HTMLElement,
		icon: string,
		label: string,
		onClick: () => void,
	): HTMLElement {
		const button = container.createEl('button', {
			cls: 'aar-player-btn',
			attr: { 'aria-label': label },
		});
		setIcon(button, icon);
		this.registerDomEvent(button, 'click', onClick);
		return button;
	}

	/**
	 * Registers a cleanup callback that runs on unload. Thin wrapper over
	 * MarkdownRenderChild.register for readability at call sites that
	 * tear down observers.
	 * @param cleanup - Cleanup callback
	 */
	private registerCleanup(cleanup: () => void): void {
		this.register(cleanup);
	}
}
