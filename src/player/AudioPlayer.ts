/**
 * Enhanced audio player rendered in place of Obsidian's built-in audio
 * embed. Adds a waveform (or seek bar), playback-speed control, skip
 * buttons, a volume control, mute, loop, a time display, per-file
 * markers and chapters, and a "copy timestamp link" action. Implemented
 * as a MarkdownRenderChild so its lifecycle (event listeners, audio
 * element, registry registration, observers) is torn down automatically
 * when the note re-renders or the leaf closes.
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
import type { MarkerStore } from './markers/MarkerStore';
import {
	addMarker,
	bookmarks,
	chapters,
	nextChapterTime,
	previousChapterTime,
	removeMarker,
	updateMarker,
	type MarkerKind,
	type PlayerMarker,
} from './markers/markerModel';
import {
	PLAYER_ACTIONS_PROP,
	type PlayerEmbedActions,
	type PlayerEmbedElement,
} from './playerEmbedActions';

/**
 * A very large finite time used to coax browsers into computing the
 * real duration of a stream (notably MediaRecorder WebM) that initially
 * reports Infinity. Seeking near the end triggers a durationchange with
 * the true value, after which playback is reset to the start.
 */
const DURATION_PROBE_SECONDS = 1e101;

/**
 * Generates a short, collision-resistant marker id. Uses crypto.randomUUID
 * when available, falling back to a timestamp-and-random combination.
 */
function generateMarkerId(): string {
	const cryptoApi = (
		activeWindow as Window & { crypto?: { randomUUID?: () => string } }
	).crypto;
	if (cryptoApi?.randomUUID) {
		return cryptoApi.randomUUID();
	}
	return `${String(Date.now())}-${Math.random().toString(36).slice(2)}`;
}

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
	private markersOverlayEl: HTMLElement | null = null;
	private markerListEl: HTMLElement | null = null;
	private muteButton: HTMLElement | null = null;
	private markers: PlayerMarker[] = [];

	/**
	 * @param containerEl - The embed element to take over
	 * @param app - Obsidian App instance
	 * @param file - Audio file to play
	 * @param settings - Sanitized player settings
	 * @param registry - Registry for timecode-link seeking
	 * @param peakCache - Shared waveform peak cache
	 * @param markerStore - Persistence for markers and chapters
	 * @param options - Per-embed options (start offset, source note)
	 */
	constructor(
		containerEl: HTMLElement,
		private readonly app: App,
		private readonly file: TFile,
		private readonly settings: ResolvedPlayerSettings,
		private readonly registry: AudioPlayerRegistry,
		private readonly peakCache: WaveformPeakCache,
		private readonly markerStore: MarkerStore,
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
		if (this.settings.enableMarkers && this.settings.showMarkerList) {
			this.markerListEl = this.containerEl.createDiv({
				cls: 'aar-player-marker-list',
			});
		}
		this.registerAudioEvents();

		if (this.settings.enableMarkers) {
			void this.loadMarkers();
		}

		this.publishContextActions();

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

		if (this.settings.showMuteButton) {
			this.muteButton = this.createIconButton(
				controls,
				'volume-2',
				'Mute / unmute',
				() => {
					this.toggleMute();
				},
			);
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
				if (this.audio.muted && Number(volume.value) > 0) {
					this.audio.muted = false;
					this.updateMuteIcon();
				}
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

		if (this.settings.enableMarkers) {
			this.createIconButton(
				controls,
				'bookmark-plus',
				'Add marker at current position',
				() => {
					void this.addMarkerAt(this.audio.currentTime, 'bookmark');
				},
			);
			this.createIconButton(
				controls,
				'list-plus',
				'Add chapter at current position',
				() => {
					void this.addMarkerAt(this.audio.currentTime, 'chapter');
				},
			);
			if (this.settings.showChapterNav) {
				this.createIconButton(
					controls,
					'chevron-first',
					'Previous chapter',
					() => {
						this.jumpToPreviousChapter();
					},
				);
				this.createIconButton(
					controls,
					'chevron-last',
					'Next chapter',
					() => {
						this.jumpToNextChapter();
					},
				);
			}
		}

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
		if (this.settings.enableMarkers) {
			this.markersOverlayEl = this.seekEl.createDiv({
				cls: 'aar-player-markers',
			});
			// Double-clicking the track drops a bookmark at that position
			this.registerDomEvent(this.seekEl, 'dblclick', (event) => {
				const time = this.pointerTime(event);
				if (time !== null) {
					void this.addMarkerAt(time, 'bookmark');
				}
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
			// Ignore non-primary buttons so a right-click opens the
			// context menu instead of seeking
			if (event.button !== 0) {
				return;
			}
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
	 * Converts a pointer event's horizontal position into a playback
	 * offset along the seek area, or null when the duration is unknown.
	 * @param event - Pointer or mouse event over the seek area
	 */
	private pointerTime(event: PointerEvent | MouseEvent): number | null {
		return this.timeAtClientX(event.clientX);
	}

	/**
	 * Converts a client X coordinate to a playback offset along the seek
	 * area, or null when the duration is unknown or the area has no width.
	 * @param clientX - Horizontal viewport coordinate
	 */
	private timeAtClientX(clientX: number): number | null {
		if (!Number.isFinite(this.audio.duration) || this.audio.duration <= 0) {
			return null;
		}
		const rect = this.seekEl.getBoundingClientRect();
		if (rect.width === 0) {
			return null;
		}
		const fraction = Math.min(
			1,
			Math.max(0, (clientX - rect.left) / rect.width),
		);
		return fraction * this.audio.duration;
	}

	/**
	 * Publishes position-aware actions on the embed element so the
	 * context menu can offer marker, chapter, timestamp, and play/pause
	 * actions on right-click. The reference is removed on unload.
	 */
	private publishContextActions(): void {
		const actions: PlayerEmbedActions = {
			markersEnabled: this.settings.enableMarkers,
			timestampLinksEnabled: this.settings.enableTimestampLinks,
			timeAtClientX: (clientX: number) => this.timeAtClientX(clientX),
			addMarkerAtTime: (time: number, kind: MarkerKind) => {
				void this.addMarkerAt(time, kind);
			},
			copyTimestampAtTime: (time: number) => {
				void this.copyTimestampLink(time);
			},
			togglePlayback: () => {
				this.togglePlay();
			},
		};
		const el = this.containerEl as PlayerEmbedElement;
		el[PLAYER_ACTIONS_PROP] = actions;
		this.register(() => {
			delete el[PLAYER_ACTIONS_PROP];
		});
	}

	/**
	 * Seeks to the position under the pointer along the seek area.
	 * @param event - Pointer event from the seek interaction
	 */
	private seekToPointer(event: PointerEvent): void {
		const time = this.pointerTime(event);
		if (time === null) {
			return;
		}
		this.audio.currentTime = time;
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
				this.renderMarkers();
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
			this.renderMarkers();
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
	 * Toggles the muted state and refreshes the mute button icon.
	 */
	private toggleMute(): void {
		this.audio.muted = !this.audio.muted;
		this.updateMuteIcon();
	}

	/**
	 * Reflects the current muted state on the mute button.
	 */
	private updateMuteIcon(): void {
		if (this.muteButton) {
			setIcon(
				this.muteButton,
				this.audio.muted ? 'volume-x' : 'volume-2',
			);
			this.muteButton.toggleClass('is-active', this.audio.muted);
		}
	}

	/**
	 * Loads persisted markers for this file and renders them.
	 */
	private async loadMarkers(): Promise<void> {
		try {
			const stored = await this.markerStore.get(this.file.path);
			if (!this.containerEl.isConnected) {
				return;
			}
			this.markers = stored;
			this.renderMarkers();
		} catch (error) {
			console.warn(
				`${PLUGIN_LOG_PREFIX} Failed to load markers for ${this.file.path}:`,
				error,
			);
		}
	}

	/**
	 * Adds a marker or chapter at the given time with a default label,
	 * persists it, and re-renders. The user can rename it afterwards in
	 * the marker list.
	 * @param time - Offset in seconds
	 * @param kind - Whether to add a bookmark or a chapter
	 */
	private async addMarkerAt(time: number, kind: MarkerKind): Promise<void> {
		const safeTime = Math.max(0, time);
		const sameKindCount = this.markers.filter(
			(marker) => marker.kind === kind,
		).length;
		const label =
			kind === 'chapter'
				? `Chapter ${String(sameKindCount + 1)}`
				: `Marker ${String(sameKindCount + 1)}`;
		this.markers = addMarker(this.markers, {
			id: generateMarkerId(),
			time: safeTime,
			label,
			kind,
		});
		this.renderMarkers();
		await this.persistMarkers();
		new Notice(`${label} added at ${formatTimecode(safeTime)}`);
	}

	/**
	 * Removes a marker by id, persists, and re-renders.
	 * @param id - Marker identifier
	 */
	private async deleteMarker(id: string): Promise<void> {
		this.markers = removeMarker(this.markers, id);
		this.renderMarkers();
		await this.persistMarkers();
	}

	/**
	 * Renames a marker, persists, and re-renders.
	 * @param id - Marker identifier
	 * @param label - New label
	 */
	private async renameMarker(id: string, label: string): Promise<void> {
		this.markers = updateMarker(this.markers, id, { label });
		await this.persistMarkers();
	}

	/**
	 * Jumps playback to the next chapter after the current position.
	 */
	private jumpToNextChapter(): void {
		const target = nextChapterTime(
			chapters(this.markers),
			this.audio.currentTime,
		);
		if (target !== null) {
			this.seekTo(target);
		}
	}

	/**
	 * Jumps playback to the previous chapter (or the start of the current
	 * one shortly after its boundary).
	 */
	private jumpToPreviousChapter(): void {
		const target = previousChapterTime(
			chapters(this.markers),
			this.audio.currentTime,
		);
		this.seekTo(target ?? 0);
	}

	/**
	 * Persists the current markers for this file.
	 */
	private async persistMarkers(): Promise<void> {
		try {
			await this.markerStore.set(this.file.path, this.markers);
		} catch (error) {
			console.warn(
				`${PLUGIN_LOG_PREFIX} Failed to save markers for ${this.file.path}:`,
				error,
			);
		}
	}

	/**
	 * Renders marker ticks over the seek area and rebuilds the marker
	 * list. Ticks are positioned only when the duration is known; the
	 * list is always rebuilt so labels and timecodes stay current.
	 */
	private renderMarkers(): void {
		if (!this.settings.enableMarkers) {
			return;
		}
		this.renderMarkerTicks();
		this.renderMarkerList();
	}

	/**
	 * Positions a tick (bookmarks) or boundary line (chapters) for every
	 * marker along the seek area.
	 */
	private renderMarkerTicks(): void {
		if (!this.markersOverlayEl) {
			return;
		}
		this.markersOverlayEl.empty();
		const duration = this.audio.duration;
		if (!Number.isFinite(duration) || duration <= 0) {
			return;
		}
		for (const marker of this.markers) {
			const left = Math.min(100, (marker.time / duration) * 100);
			const tick = this.markersOverlayEl.createDiv({
				cls:
					marker.kind === 'chapter'
						? 'aar-player-tick aar-player-tick-chapter'
						: 'aar-player-tick aar-player-tick-bookmark',
			});
			tick.style.left = `${String(left)}%`;
			tick.setAttribute(
				'aria-label',
				`${marker.label} (${formatTimecode(marker.time)})`,
			);
			this.registerDomEvent(tick, 'pointerdown', (event) => {
				// Let a right-click fall through to the context menu
				if (event.button !== 0) {
					return;
				}
				// Stop the seek handler from also firing for this click
				event.stopPropagation();
				this.seekTo(marker.time);
			});
		}
	}

	/**
	 * Rebuilds the marker list below the player: each row jumps on click,
	 * renames inline, and can be deleted.
	 */
	private renderMarkerList(): void {
		if (!this.markerListEl) {
			return;
		}
		this.markerListEl.empty();
		const ordered = [...bookmarks(this.markers), ...chapters(this.markers)];
		for (const marker of ordered) {
			const row = this.markerListEl.createDiv({
				cls: 'aar-player-marker-row',
			});
			const jump = row.createEl('button', {
				cls: 'aar-player-marker-time',
				text: formatTimecode(marker.time),
			});
			jump.setAttribute(
				'aria-label',
				marker.kind === 'chapter'
					? 'Jump to chapter'
					: 'Jump to marker',
			);
			setIcon(
				row.createSpan({ cls: 'aar-player-marker-kind' }),
				marker.kind === 'chapter' ? 'list' : 'bookmark',
			);
			this.registerDomEvent(jump, 'click', () => {
				this.seekTo(marker.time);
			});
			const label = row.createEl('input', {
				cls: 'aar-player-marker-label',
				attr: { type: 'text', value: marker.label },
			});
			this.registerDomEvent(label, 'change', () => {
				void this.renameMarker(marker.id, label.value);
			});
			const remove = row.createEl('button', {
				cls: 'aar-player-marker-delete',
				attr: { 'aria-label': 'Delete' },
			});
			setIcon(remove, 'trash-2');
			this.registerDomEvent(remove, 'click', () => {
				void this.deleteMarker(marker.id);
			});
		}
	}

	/**
	 * Copies a timecode link to a position, respecting the vault's
	 * link-format preference.
	 * @param time - Offset in seconds (defaults to the current position)
	 */
	private async copyTimestampLink(
		time = this.audio.currentTime,
	): Promise<void> {
		const seconds = Math.floor(Math.max(0, time));
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
