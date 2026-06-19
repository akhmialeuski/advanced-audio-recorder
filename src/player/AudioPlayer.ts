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

import { MarkdownRenderChild, Menu, Notice, setIcon } from 'obsidian';
import type { App, TFile } from 'obsidian';
import {
	PLUGIN_LOG_PREFIX,
	PLAYER_WAVEFORM_BARS_PER_100PX,
	PLAYER_PLAYBACK_RATE_PRESETS,
	PLAYER_WAVEFORM_FALLBACK_PLAYED,
	PLAYER_WAVEFORM_FALLBACK_UNPLAYED,
	WAVEFORM_CACHE_BUCKETS,
} from '../constants';
import { formatTimecode } from '../utils/TimeUtils';
import { playbackProgress } from './playbackProgress';
import type { ResolvedPlayerSettings } from '../settings/Settings';
import {
	computeWaveformPeaks,
	downsamplePeaks,
	waveformCacheKey,
	WaveformPeakCache,
	type AudioDecoder,
} from './WaveformData';
import type {
	AudioPlayerRegistry,
	SeekablePlayer,
} from './AudioPlayerRegistry';
import type { MarkerStore } from './markers/MarkerStore';
import {
	activeMarkerIndex,
	addMarker,
	chapters,
	markerRows,
	nextChapterTime,
	previousChapterTime,
	removeMarker,
	sortMarkers,
	updateMarker,
	type MarkerKind,
	type MarkerRow,
	type PlayerMarker,
} from './markers/markerModel';
import { formatPlaybackRate, speedMenuItems } from './playbackRate';
import { isEditableContext } from './playerMode';
import {
	setPlayerEmbedActions,
	clearPlayerEmbedActions,
	type PlayerEmbedActions,
} from './playerEmbedActions';

/**
 * A very large finite time used to coax browsers into computing the
 * real duration of a stream (notably MediaRecorder WebM) that initially
 * reports Infinity. Seeking near the end triggers a durationchange with
 * the true value, after which playback is reset to the start.
 */
const DURATION_PROBE_SECONDS = 1e101;

/**
 * How long to wait for a probed stream to report its real duration
 * before giving up, so playback is not left stranded at the probe seek
 * position when the corrected duration never arrives.
 */
const DURATION_PROBE_TIMEOUT_MS = 5000;

/**
 * Fallback delay before rendering the player when Obsidian never signals
 * that the embed finished loading (e.g. a broken link, or a change to
 * Obsidian's embed markup), so the player is never left unrendered.
 */
const EMBED_LOAD_FALLBACK_MS = 400;

/**
 * Debounce before persisting a marker rename, so the rename is saved and
 * synced to other views shortly after typing even when no change/blur
 * event fires (e.g. toggling edit/preview by hotkey), without writing on
 * every keystroke.
 */
const RENAME_DEBOUNCE_MS = 400;

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
	/**
	 * Render immediately instead of waiting for Obsidian to load the
	 * embed. Set when the player owns its container from the start (the
	 * embed-registry path), where no default player is ever injected.
	 */
	immediate?: boolean;
}

/**
 * Renders and drives a single enhanced audio player instance.
 */
export class AudioPlayer extends MarkdownRenderChild implements SeekablePlayer {
	/** Shared per-file audio element, acquired from the registry on render so
	 * every view mode controls the same playback. */
	private audio!: HTMLAudioElement;
	/** True when this player created the shared audio (applies the #t= start
	 * offset; secondary players must not move shared playback). */
	private ownsAudio = false;
	private playButton!: HTMLElement;
	private seekEl!: HTMLElement;
	private canvas: HTMLCanvasElement | null = null;
	private progressFillEl: HTMLElement | null = null;
	private timeEl: HTMLElement | null = null;
	private speedButton: HTMLElement | null = null;
	private peaks: number[] | null = null;
	private isSeeking = false;
	private durationProbeActive = false;
	/**
	 * Set on teardown. Async work checks this rather than
	 * containerEl.isConnected, because the embed-registry path renders
	 * while the container is briefly detached (not yet inserted), and
	 * bailing then would drop the waveform and markers.
	 */
	private unloaded = false;
	/**
	 * Whether marker/chapter editing is allowed. Defaults to read-only and
	 * is set true only once the embed is confirmed to be inside the editor
	 * (Live Preview); Reading view stays read-only. Defaulting to false
	 * means a missed/late detection can never wrongly show edit controls
	 * in Reading view — the regression this guards against.
	 */
	private editable = false;
	private resizeObserver: ResizeObserver | null = null;
	private markersOverlayEl: HTMLElement | null = null;
	private markerListEl: HTMLElement | null = null;
	/** Row elements of the marker list, in sorted order, for active highlight. */
	private markerRowEls: HTMLElement[] = [];
	/** Pending debounced marker-rename persist timer. */
	private renameTimer = 0;
	private muteButton: HTMLElement | null = null;
	private markers: PlayerMarker[] = [];
	/** Cached waveform colors; refreshed on load and on resize. */
	private waveformColors: { played: string; unplayed: string } | null = null;

	/**
	 * @param containerEl - The embed element to take over
	 * @param app - Obsidian App instance
	 * @param file - Audio file to play
	 * @param settings - Sanitized player settings
	 * @param registry - Registry for timecode-link seeking
	 * @param peakCache - Shared waveform peak cache
	 * @param decoder - Shared audio decoder for waveform extraction
	 * @param markerStore - Persistence for markers and chapters
	 * @param options - Per-embed options (start offset, source note)
	 */
	constructor(
		containerEl: HTMLElement,
		private readonly app: App,
		private readonly file: TFile,
		private settings: ResolvedPlayerSettings,
		private readonly registry: AudioPlayerRegistry,
		private readonly peakCache: WaveformPeakCache,
		private readonly decoder: AudioDecoder,
		private readonly markerStore: MarkerStore,
		private readonly options: AudioPlayerOptions,
	) {
		super(containerEl);
	}

	/**
	 * Defers the takeover until Obsidian has finished loading the embed,
	 * then renders the player. Obsidian loads internal media embeds
	 * asynchronously through its own loader, which owns the embed element
	 * and overwrites a player built too early — notably for files it
	 * treats as video (mp4, webm, mov, mkv, ogv). Rendering only after the
	 * embed is populated lets empty() clear Obsidian's native element so
	 * our player is the one that survives.
	 */
	onload(): void {
		if (this.options.immediate) {
			// The embed-registry path hands us an owned container with no
			// default player to wait for, so render right away
			this.renderPlayer();
			return;
		}
		this.whenEmbedReady(() => {
			this.renderPlayer();
		});
	}

	/**
	 * Reports whether Obsidian has populated the embed: it either set the
	 * `is-loaded` class or injected a native media element.
	 */
	private isEmbedLoaded(): boolean {
		return (
			this.containerEl.hasClass('is-loaded') ||
			this.containerEl.querySelector('audio, video') !== null
		);
	}

	/**
	 * Runs the takeover once Obsidian has populated the embed, or after a
	 * short fallback delay if that signal never arrives. The observer and
	 * timer are torn down on unload and after firing once.
	 * @param run - Callback that performs the takeover
	 */
	private whenEmbedReady(run: () => void): void {
		if (this.isEmbedLoaded()) {
			run();
			return;
		}
		let done = false;
		let fallback = 0;
		let observer: MutationObserver | null = null;
		const finish = (): void => {
			if (done) {
				return;
			}
			done = true;
			observer?.disconnect();
			window.clearTimeout(fallback);
			run();
		};
		observer = new MutationObserver(() => {
			if (this.isEmbedLoaded()) {
				finish();
			}
		});
		observer.observe(this.containerEl, {
			childList: true,
			attributes: true,
			attributeFilter: ['class'],
		});
		fallback = window.setTimeout(finish, EMBED_LOAD_FALLBACK_MS);
		this.register(() => {
			observer?.disconnect();
			window.clearTimeout(fallback);
		});
	}

	/**
	 * One-time setup: wires the audio element and events, registers with the
	 * registry, and renders the UI. The audio element and its listeners are
	 * created once here (never on a settings re-render) so playback is never
	 * interrupted and listeners never duplicate. Runs once the embed is
	 * ready (see whenEmbedReady).
	 */
	private renderPlayer(): void {
		this.register(() => {
			this.unloaded = true;
		});

		// Bind to the file's shared audio element so every view mode controls
		// the same playback; the registry releases it once the last player
		// unloads
		const { audio, isNew } = this.registry.acquireAudio(
			this.file.path,
			this.app.vault.getResourcePath(this.file),
		);
		this.audio = audio;
		this.ownsAudio = isNew;
		this.register(() => {
			this.registry.releaseAudio(this.file.path);
		});

		this.registerAudioEvents();

		this.registry.register(this.file.path, this);
		this.register(() => {
			this.registry.unregister(this.file.path, this);
		});

		this.renderUi();
	}

	/**
	 * Re-renders the player UI from the current settings. Re-runnable: called
	 * on first render and again by applySettings when a window toggle
	 * changes. It rebuilds only the DOM the player owns inside its container,
	 * leaving the audio element (and playback) untouched — so toggling the
	 * waveform or markers window applies instantly without a note re-render.
	 */
	private renderUi(): void {
		// Tear down the re-creatable observer before rebuilding the seek area
		this.resizeObserver?.disconnect();
		this.resizeObserver = null;

		this.containerEl.empty();
		this.containerEl.addClass('aar-player');
		// The embed element keeps Obsidian's own audio loader alive; an
		// audio child it injects later is removed so our player is the
		// only one shown
		this.guardAgainstDefaultEmbed();

		this.audio.loop = this.settings.defaultLoop;
		this.audio.playbackRate = this.settings.defaultPlaybackRate;

		this.buildControls();
		this.buildSeekArea();
		if (this.settings.enableMarkers && this.settings.showMarkerList) {
			this.markerListEl = this.containerEl.createDiv({
				cls: 'aar-player-marker-list',
			});
			this.registerMarkerListDelegation(this.markerListEl);
		} else {
			this.markerListEl = null;
		}

		if (this.settings.enableMarkers) {
			void this.loadMarkers();
		} else {
			this.markers = [];
		}

		// Publish now with the default (read-only) mode; applyMode
		// re-publishes once the real mode is known
		this.publishContextActions();

		// Editable only in Live Preview; this can be told reliably once the
		// embed is attached, so apply the edit/read-only affordances then.
		// Defaulting to read-only means Reading view is correct even if this
		// never runs.
		this.whenAttached(() => {
			this.applyMode();
		});

		if (this.settings.showWaveform) {
			void this.loadWaveform();
		}

		this.updateProgress();
	}

	/**
	 * Re-renders the player UI in place with new settings (e.g. after the
	 * waveform or markers window is toggled). Playback continues
	 * uninterrupted because the audio element is not rebuilt.
	 * @param settings - The new render-ready player settings
	 */
	applySettings(settings: ResolvedPlayerSettings): void {
		if (this.unloaded) {
			return;
		}
		this.settings = settings;
		this.renderUi();
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
	 * Re-reads this player's markers from the store and re-renders them.
	 * Called by the registry when another view changed the same file's
	 * markers, so reading view and Live Preview stay in sync.
	 */
	reloadMarkers(): void {
		if (this.settings.enableMarkers) {
			void this.loadMarkers();
		}
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
			// Reflect the shared audio's current state, so a player rendered
			// while playback is already running (e.g. after a mode switch)
			// shows the pause icon rather than a stale play icon
			this.audio.paused ? 'play' : 'pause',
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
				text: formatPlaybackRate(this.settings.defaultPlaybackRate),
			});
			this.speedButton.setAttribute('aria-label', 'Playback speed');
			this.registerDomEvent(this.speedButton, 'click', (event) => {
				this.showSpeedMenu(event);
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
			// Adding markers/chapters is edit-only; hidden in reading view
			this.createIconButton(
				controls,
				'bookmark-plus',
				'Add marker at current position',
				() => {
					void this.addMarkerAt(this.audio.currentTime, 'bookmark');
				},
			).addClass('aar-player-edit-only');
			this.createIconButton(
				controls,
				'list-plus',
				'Add chapter at current position',
				() => {
					void this.addMarkerAt(this.audio.currentTime, 'chapter');
				},
			).addClass('aar-player-edit-only');
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
		// Reset the element refs every render. Without this, toggling the
		// waveform off leaves a stale (removed) canvas in this.canvas, so
		// updateProgress would draw onto the dead canvas and never update the
		// new progress bar — the seek position would freeze.
		this.canvas = null;
		this.progressFillEl = null;
		// Expose the seek area as a keyboard-operable slider so seeking is
		// not mouse-only (the native audio element offered this for free)
		this.seekEl.setAttribute('role', 'slider');
		this.seekEl.setAttribute('tabindex', '0');
		this.seekEl.setAttribute('aria-label', 'Seek');
		this.seekEl.setAttribute('aria-valuemin', '0');
		if (this.settings.showWaveform) {
			this.seekEl.addClass('aar-player-seek-waveform');
			this.seekEl.setCssProps({
				'--aar-waveform-height': `${String(this.settings.waveformHeight)}px`,
			});
			this.canvas = this.seekEl.createEl('canvas', {
				cls: 'aar-player-canvas',
			});
			this.resizeObserver = new ResizeObserver(() => {
				// Re-read theme colors in case the theme changed, then redraw
				this.waveformColors = null;
				this.drawWaveform();
			});
			this.resizeObserver.observe(this.seekEl);
			this.registerCleanup(() => {
				this.resizeObserver?.disconnect();
				this.resizeObserver = null;
			});
		} else {
			// Plain progress bar: a filled track (played, high contrast) over
			// a muted track (remaining), with a thumb marking the position
			this.seekEl.addClass('aar-player-seek-bar');
			this.progressFillEl = this.seekEl.createDiv({
				cls: 'aar-player-progress-fill',
			});
			this.seekEl.createDiv({ cls: 'aar-player-progress-thumb' });
		}
		if (this.settings.enableMarkers) {
			this.markersOverlayEl = this.seekEl.createDiv({
				cls: 'aar-player-markers',
			});
			// One delegated handler serves every tick, so rebuilding the
			// overlay never accumulates per-tick listeners
			this.registerDomEvent(
				this.markersOverlayEl,
				'pointerdown',
				(event) => {
					if (event.button !== 0) {
						return;
					}
					const time = this.markerTimeFromEvent(event);
					if (time !== null) {
						// Keep the seek handler on the parent from firing too
						event.stopPropagation();
						this.seekTo(time);
					}
				},
			);
			// Double-clicking the track drops a bookmark (edit mode only)
			this.registerDomEvent(this.seekEl, 'dblclick', (event) => {
				if (!this.editable) {
					return;
				}
				const time = this.pointerTime(event);
				if (time !== null) {
					void this.addMarkerAt(time, 'bookmark');
				}
			});
		}
		this.registerSeekPointer();
		this.registerSeekKeyboard();
	}

	/**
	 * Wires keyboard seeking on the slider-role seek area: arrow keys
	 * nudge by a few seconds, Home/End jump to the bounds.
	 */
	private registerSeekKeyboard(): void {
		const stepSeconds = 5;
		this.registerDomEvent(this.seekEl, 'keydown', (event) => {
			switch (event.key) {
				case 'ArrowRight':
				case 'ArrowUp':
					this.skip(stepSeconds);
					break;
				case 'ArrowLeft':
				case 'ArrowDown':
					this.skip(-stepSeconds);
					break;
				case 'Home':
					this.audio.currentTime = 0;
					this.updateProgress();
					break;
				case 'End':
					if (Number.isFinite(this.audio.duration)) {
						this.audio.currentTime = this.audio.duration;
						this.updateProgress();
					}
					break;
				default:
					return;
			}
			event.preventDefault();
		});
	}

	/**
	 * Resolves the marker time for a delegated overlay pointer event by
	 * reading the tick's stored time, or null when the target is not a
	 * tick.
	 * @param event - Pointer event on the markers overlay
	 */
	private markerTimeFromEvent(event: PointerEvent): number | null {
		const target = event.target as HTMLElement | null;
		const tick = target?.closest<HTMLElement>('.aar-player-tick');
		if (!tick?.dataset.time) {
			return null;
		}
		const time = Number(tick.dataset.time);
		return Number.isFinite(time) ? time : null;
	}

	/**
	 * Wires pointer events for click/drag seeking on the seek area. The
	 * seek area captures the pointer on press so a drag that leaves it
	 * still tracks, without a document-wide listener per player instance.
	 */
	private registerSeekPointer(): void {
		this.registerDomEvent(this.seekEl, 'pointerdown', (event) => {
			// Ignore non-primary buttons so a right-click opens the
			// context menu instead of seeking
			if (event.button !== 0) {
				return;
			}
			this.isSeeking = true;
			// Route subsequent pointer events to the seek area even when
			// the cursor leaves it during the drag
			this.seekEl.setPointerCapture(event.pointerId);
			this.seekToPointer(event);
		});
		this.registerDomEvent(this.seekEl, 'pointermove', (event) => {
			if (this.isSeeking) {
				this.seekToPointer(event);
			}
		});
		this.registerDomEvent(this.seekEl, 'pointerup', (event) => {
			this.isSeeking = false;
			if (this.seekEl.hasPointerCapture(event.pointerId)) {
				this.seekEl.releasePointerCapture(event.pointerId);
			}
		});
		this.registerDomEvent(this.seekEl, 'pointercancel', () => {
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
	 * Runs the callback once the embed is attached to the document (the
	 * embed-registry path renders while still detached), so DOM-context
	 * checks like the editor-mode probe are reliable. Gives up after a
	 * short budget, leaving the editable default untouched.
	 * @param run - Callback to run once attached
	 */
	private whenAttached(run: () => void): void {
		if (this.containerEl.isConnected) {
			run();
			return;
		}
		let attempts = 90;
		const tick = (): void => {
			if (this.unloaded) {
				return;
			}
			if (this.containerEl.isConnected) {
				run();
				return;
			}
			if (attempts-- <= 0) {
				return;
			}
			window.requestAnimationFrame(tick);
		};
		window.requestAnimationFrame(tick);
	}

	/**
	 * Resolves the edit/read-only mode from the attached DOM and applies
	 * it: toggles the read-only class (hides edit-only controls via CSS),
	 * rebuilds the marker UI for the mode, and re-publishes the context
	 * actions so add-marker entries are gated.
	 */
	private applyMode(): void {
		this.editable = isEditableContext(this.containerEl);
		this.containerEl.toggleClass('aar-player-readonly', !this.editable);
		this.renderMarkers();
		this.publishContextActions();
	}

	/**
	 * Publishes position-aware actions on the embed element so the
	 * context menu can offer marker, chapter, timestamp, and play/pause
	 * actions on right-click. The reference is removed on unload.
	 */
	private publishContextActions(): void {
		const actions: PlayerEmbedActions = {
			// Adding markers/chapters from the context menu is edit-only
			markersEnabled: this.settings.enableMarkers && this.editable,
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
		setPlayerEmbedActions(this.containerEl, actions);
		this.register(() => {
			clearPlayerEmbedActions(this.containerEl);
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
		let watchdog = 0;
		const finish = (resolved: boolean): void => {
			this.audio.removeEventListener('durationchange', onDurationChange);
			window.clearTimeout(watchdog);
			this.durationProbeActive = false;
			// Restore the start position whether or not the probe worked;
			// leaving currentTime near the probe value would strand
			// playback at the end of the file
			this.audio.currentTime = 0;
			if (resolved) {
				this.applyStartOffset();
			}
			this.renderMarkers();
			this.updateProgress();
		};
		const onDurationChange = (): void => {
			if (Number.isFinite(this.audio.duration)) {
				finish(true);
			}
		};
		this.audio.addEventListener('durationchange', onDurationChange);
		// Give up if the corrected duration never arrives, so the probe
		// seek position is not left stranded at the end of the stream
		watchdog = window.setTimeout(() => {
			if (this.durationProbeActive) {
				finish(false);
			}
		}, DURATION_PROBE_TIMEOUT_MS);
		this.register(() => {
			this.audio.removeEventListener('durationchange', onDurationChange);
			window.clearTimeout(watchdog);
		});
		try {
			this.audio.currentTime = DURATION_PROBE_SECONDS;
		} catch {
			// Some sources reject the probe seek; give up immediately and
			// fall back to a non-seekable display
			finish(false);
		}
	}

	/**
	 * Applies the timecode start offset from the embed subpath, once,
	 * after the duration is known.
	 */
	private applyStartOffset(): void {
		// Only the player that created the shared audio applies its #t= start;
		// a secondary player (e.g. the other view mode) must not jump shared
		// playback to its own offset
		if (!this.ownsAudio) {
			this.options.startSeconds = null;
			return;
		}
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
	 * Decodes the file and computes (or reuses cached) waveform peaks. The
	 * waveform is always attempted for supported audio (no size limit); a
	 * decode failure falls back silently to the plain, still-seekable bar.
	 */
	private async loadWaveform(): Promise<void> {
		// Cache at a fixed resolution independent of width, so resizing or
		// switching view modes redraws from cache instead of re-decoding
		const cacheKey = waveformCacheKey(
			this.file.path,
			this.file.stat.mtime,
			this.file.stat.size,
		);
		const cached = this.peakCache.get(cacheKey);
		if (cached) {
			this.peaks = cached;
			this.redrawWaveformWhenSized();
			return;
		}
		try {
			const data = await this.app.vault.readBinary(this.file);
			if (this.unloaded) {
				return;
			}
			const audioBuffer = await this.decoder.decode(data);
			if (this.unloaded) {
				return;
			}
			const channels: Float32Array[] = [];
			for (let i = 0; i < audioBuffer.numberOfChannels; i++) {
				channels.push(audioBuffer.getChannelData(i));
			}
			this.peaks = computeWaveformPeaks(channels, WAVEFORM_CACHE_BUCKETS);
			this.peakCache.set(cacheKey, this.peaks);
			this.redrawWaveformWhenSized();
		} catch (error) {
			// Leave the (still seekable) bar without a waveform; no visible
			// error — the player keeps working
			console.warn(
				`${PLUGIN_LOG_PREFIX} Failed to build waveform for ${this.file.path}:`,
				error,
			);
		}
	}

	/**
	 * Draws the waveform once the seek area has a measurable width. On
	 * first render the canvas can be laid out a frame or two after the
	 * peaks are ready (width still 0), so a plain draw would no-op and
	 * leave the waveform blank until the user interacts. Retry across a
	 * few animation frames until the width settles.
	 * @param attempts - Remaining retries before giving up
	 */
	private redrawWaveformWhenSized(attempts = 10): void {
		if (!this.canvas || !this.peaks || this.unloaded) {
			return;
		}
		if (this.seekEl.clientWidth > 0) {
			this.drawWaveform();
			return;
		}
		if (attempts <= 0) {
			return;
		}
		window.requestAnimationFrame(() => {
			this.redrawWaveformWhenSized(attempts - 1);
		});
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

		const { played: playedColor, unplayed: unplayedColor } =
			this.resolveWaveformColors();

		// Downsample the cached high-res peaks to the current width
		const bars = downsamplePeaks(this.peaks, this.computeBucketCount());
		const barCount = bars.length;
		const barWidth = cssWidth / barCount;
		const gap = Math.min(1, barWidth * 0.2);
		const playedFraction = playbackProgress(
			this.audio.currentTime,
			this.audio.duration,
		);
		const playedBars = playedFraction * barCount;

		for (let i = 0; i < barCount; i++) {
			const barHeight = Math.max(1, bars[i] * (cssHeight - 2));
			const x = i * barWidth;
			const y = (cssHeight - barHeight) / 2;
			ctx.fillStyle = i <= playedBars ? playedColor : unplayedColor;
			ctx.fillRect(x, y, Math.max(1, barWidth - gap), barHeight);
		}
	}

	/**
	 * Returns the waveform colors, reading them from the theme once and
	 * caching the result. The colors do not change during playback, so
	 * resolving them on every redraw would force a needless style
	 * recalculation; the cache is invalidated on resize to pick up theme
	 * changes.
	 */
	private resolveWaveformColors(): { played: string; unplayed: string } {
		if (this.waveformColors) {
			return this.waveformColors;
		}
		const styles = activeWindow.getComputedStyle(
			this.canvas ?? this.seekEl,
		);
		this.waveformColors = {
			played:
				styles.getPropertyValue('--aar-waveform-played').trim() ||
				PLAYER_WAVEFORM_FALLBACK_PLAYED,
			unplayed:
				styles.getPropertyValue('--aar-waveform-unplayed').trim() ||
				PLAYER_WAVEFORM_FALLBACK_UNPLAYED,
		};
		return this.waveformColors;
	}

	/**
	 * Updates the seek visuals and time display from the current
	 * playback position.
	 */
	private updateProgress(): void {
		if (this.canvas && this.peaks) {
			this.drawWaveform();
		} else if (this.progressFillEl) {
			const fraction = playbackProgress(
				this.audio.currentTime,
				this.audio.duration,
			);
			// Set on the seek area so both the fill (width) and the thumb
			// (left) read the same position via the inherited variable
			this.seekEl.setCssProps({
				'--aar-progress': `${String(fraction * 100)}%`,
			});
		}
		const total = Number.isFinite(this.audio.duration)
			? this.audio.duration
			: 0;
		if (this.timeEl) {
			this.timeEl.setText(
				`${formatTimecode(this.audio.currentTime)} / ${formatTimecode(total)}`,
			);
		}
		// Keep the slider's accessible value in sync for screen readers
		this.seekEl.setAttribute('aria-valuemax', String(Math.floor(total)));
		this.seekEl.setAttribute(
			'aria-valuenow',
			String(Math.floor(this.audio.currentTime)),
		);
		this.seekEl.setAttribute(
			'aria-valuetext',
			`${formatTimecode(this.audio.currentTime)} of ${formatTimecode(total)}`,
		);
		// Move the active-segment highlight as playback crosses boundaries
		this.updateActiveMarker();
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
	 * Opens a dropdown of the playback-rate presets at the speed button,
	 * with the current rate checked, so the user can pick any speed (not
	 * only step it upward).
	 * @param event - The click event on the speed button
	 */
	private showSpeedMenu(event: MouseEvent): void {
		const menu = new Menu();
		for (const item of speedMenuItems(
			this.audio.playbackRate,
			PLAYER_PLAYBACK_RATE_PRESETS,
		)) {
			menu.addItem((menuItem) => {
				menuItem
					.setTitle(item.label)
					.setChecked(item.checked)
					.onClick(() => {
						this.setPlaybackRate(item.rate);
					});
			});
		}
		menu.showAtMouseEvent(event);
	}

	/**
	 * Applies a playback rate and reflects it on the speed button.
	 * @param rate - Playback rate multiplier
	 */
	private setPlaybackRate(rate: number): void {
		this.audio.playbackRate = rate;
		if (this.speedButton) {
			this.speedButton.setText(formatPlaybackRate(rate));
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
			if (this.unloaded) {
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
		// Update the tick tooltip without rebuilding the list, so the
		// input the user is typing in keeps focus
		this.renderMarkerTicks();
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
			// Refresh other live players of this file (e.g. the reading-view
			// copy) so the change shows everywhere without re-opening
			this.registry.reloadMarkers(this.file.path, this);
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
			tick.setCssProps({ '--aar-tick-left': `${String(left)}%` });
			tick.dataset.time = String(marker.time);
			tick.setAttribute(
				'aria-label',
				`${marker.label} (${formatTimecode(marker.time)})`,
			);
			// Clicks are handled by one delegated listener on the overlay
			// (see buildSeekArea), so rebuilding ticks adds no listeners
		}
	}

	/**
	 * Registers the delegated click and change handlers for the marker
	 * list once, so rebuilding rows never accumulates listeners. Rows
	 * carry the marker id and an action in data attributes.
	 * @param listEl - The marker list container
	 */
	private registerMarkerListDelegation(listEl: HTMLElement): void {
		this.registerDomEvent(listEl, 'click', (event) => {
			const target = (
				event.target as HTMLElement | null
			)?.closest<HTMLElement>('[data-action]');
			const id = target?.dataset.markerId;
			if (!target || !id) {
				return;
			}
			if (target.dataset.action === 'jump') {
				const marker = this.markers.find((m) => m.id === id);
				if (marker) {
					this.seekTo(marker.time);
				}
			} else if (target.dataset.action === 'delete') {
				void this.deleteMarker(id);
			}
		});
		// Persist a rename shortly after typing (debounced), so the change
		// is saved and synced to other views even when no change/blur event
		// fires (e.g. toggling edit/preview by hotkey)
		this.registerDomEvent(listEl, 'input', (event) => {
			const input = event.target as HTMLInputElement | null;
			const id = input?.dataset.markerId;
			if (input && id && input.dataset.action === 'rename') {
				const value = input.value;
				window.clearTimeout(this.renameTimer);
				this.renameTimer = window.setTimeout(() => {
					void this.renameMarker(id, value);
				}, RENAME_DEBOUNCE_MS);
			}
		});
		this.registerDomEvent(listEl, 'change', (event) => {
			const input = event.target as HTMLInputElement | null;
			const id = input?.dataset.markerId;
			if (input && id && input.dataset.action === 'rename') {
				window.clearTimeout(this.renameTimer);
				void this.renameMarker(id, input.value);
			}
		});
		this.register(() => {
			window.clearTimeout(this.renameTimer);
		});
	}

	/**
	 * Rebuilds the marker list rows. Event handling is delegated to the
	 * list container (see registerMarkerListDelegation), so this only
	 * builds DOM and never attaches per-row listeners.
	 */
	private renderMarkerList(): void {
		if (!this.markerListEl) {
			return;
		}
		this.markerListEl.empty();
		this.markerRowEls = [];
		// markerRows is the single source of truth: the same markers, one
		// list ordered by time, in both modes; only the actions differ
		const rows = markerRows(
			this.markers,
			this.editable,
			this.knownDuration(),
		);
		for (const row of rows) {
			const rowEl = this.markerListEl.createDiv({
				cls: 'aar-player-marker-row',
			});
			this.markerRowEls.push(rowEl);
			if (this.editable) {
				this.buildEditableRow(rowEl, row);
			} else {
				this.buildReadonlyRow(rowEl, row);
			}
		}
		this.updateActiveMarker();
	}

	/**
	 * Builds an editable marker row: jump time, kind icon, rename input,
	 * and delete button.
	 * @param rowEl - The row element
	 * @param row - Row model
	 */
	private buildEditableRow(rowEl: HTMLElement, row: MarkerRow): void {
		const jump = rowEl.createEl('button', {
			cls: 'aar-player-marker-time',
			text: formatTimecode(row.time),
		});
		jump.dataset.action = 'jump';
		jump.dataset.markerId = row.id;
		jump.setAttribute(
			'aria-label',
			row.kind === 'chapter' ? 'Jump to chapter' : 'Jump to marker',
		);
		setIcon(
			rowEl.createSpan({ cls: 'aar-player-marker-kind' }),
			row.kind === 'chapter' ? 'list' : 'bookmark',
		);
		const label = rowEl.createEl('input', {
			cls: 'aar-player-marker-label',
			attr: { type: 'text', value: row.label },
		});
		label.dataset.action = 'rename';
		label.dataset.markerId = row.id;
		const remove = rowEl.createEl('button', {
			cls: 'aar-player-marker-delete',
			attr: { 'aria-label': 'Delete' },
		});
		remove.dataset.action = 'delete';
		remove.dataset.markerId = row.id;
		setIcon(remove, 'trash-2');
	}

	/**
	 * Builds a read-only marker row: the whole row is one jump target (no
	 * button chrome), the label fills the width, and the segment length is
	 * shown on the right.
	 * @param rowEl - The row element
	 * @param row - Row model
	 */
	private buildReadonlyRow(rowEl: HTMLElement, row: MarkerRow): void {
		rowEl.addClass('aar-player-marker-row-clickable');
		rowEl.dataset.action = 'jump';
		rowEl.dataset.markerId = row.id;
		rowEl.setAttribute(
			'aria-label',
			row.kind === 'chapter' ? 'Jump to chapter' : 'Jump to marker',
		);
		rowEl.createSpan({
			cls: 'aar-player-marker-time',
			text: formatTimecode(row.time),
		});
		setIcon(
			rowEl.createSpan({ cls: 'aar-player-marker-kind' }),
			row.kind === 'chapter' ? 'list' : 'bookmark',
		);
		rowEl.createSpan({
			cls: 'aar-player-marker-label-static',
			text: row.label,
		});
		rowEl.createSpan({
			cls: 'aar-player-marker-segment',
			text:
				row.segmentSeconds !== null
					? formatTimecode(row.segmentSeconds)
					: '',
		});
	}

	/**
	 * Highlights the marker row whose segment contains the current
	 * playback position, so the playing section is obvious and the
	 * highlight moves as playback crosses marker boundaries.
	 */
	private updateActiveMarker(): void {
		if (this.markerRowEls.length === 0) {
			return;
		}
		const index = activeMarkerIndex(
			sortMarkers(this.markers),
			this.audio.currentTime,
		);
		this.markerRowEls.forEach((rowEl, i) => {
			rowEl.toggleClass('is-active', i === index);
		});
	}

	/**
	 * Returns the track duration when known, otherwise null.
	 */
	private knownDuration(): number | null {
		return Number.isFinite(this.audio.duration) && this.audio.duration > 0
			? this.audio.duration
			: null;
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
