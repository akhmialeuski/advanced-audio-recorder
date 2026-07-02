/**
 * Enhanced audio player rendered in place of Obsidian's built-in audio
 * embed. Adds a waveform (or seek bar), playback-speed control, skip
 * buttons, a volume control, mute, loop, a time display, per-file
 * markers and chapters, and a "copy timestamp link" action. Implemented
 * as a MarkdownRenderChild so its lifecycle (event listeners, audio
 * element, registry registration, observers) is torn down automatically
 * when the note re-renders or the leaf closes.
 *
 * The class is a coordinator: the waveform rendering lives in WaveformCanvas
 * and the marker/chapter UI in MarkerListView, leaving this file focused on
 * the audio element, controls, seeking, mode, and persistence wiring.
 * @module player/AudioPlayer
 */

import { MarkdownRenderChild, Menu, Notice, setIcon } from 'obsidian';
import type { App, TFile } from 'obsidian';
import {
	PLUGIN_LOG_PREFIX,
	PLAYER_PLAYBACK_RATE_PRESETS,
	WAVEFORM_CACHE_BUCKETS,
	WAVEFORM_MAX_DECODE_BYTES,
	PLAYER_LOOP,
	PLAYER_PLAYBACK_RATE,
	PLAYER_SKIP_SECONDS,
	PLAYER_SEEK_KEYBOARD_STEP_SECONDS,
	PLAYER_ATTACH_WAIT_FRAMES,
	PLAYER_WAVEFORM_REDRAW_RETRIES,
	PLAYER_WAVEFORM_PREFETCH_MARGIN_PX,
} from '../constants';
import { formatTimecode } from '../utils/TimeUtils';
import { playbackProgress } from './playbackProgress';
import {
	playerSettingsEqual,
	type ResolvedPlayerSettings,
} from '../settings/Settings';
import {
	computeWaveformPeaksProgressive,
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
	addMarker,
	chapters,
	MARKER_KIND,
	nextChapterTime,
	previousChapterTime,
	removeMarker,
	updateMarker,
	type MarkerKind,
	type PlayerMarker,
} from './markers/markerModel';
import { defaultMarkerLabel, generateMarkerId } from './markers/markerFactory';
import { formatPlaybackRate, speedMenuItems } from './playbackRate';
import { isEditableContext } from './playerMode';
import {
	setPlayerEmbedActions,
	clearPlayerEmbedActions,
	type PlayerEmbedActions,
} from './playerEmbedActions';
import { WaveformCanvas } from './views/WaveformCanvas';
import {
	MarkerListView,
	type MarkerListCallbacks,
	type MarkerListHost,
} from './views/MarkerListView';

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
	/**
	 * The #t= start position to show for THIS embed until its playback engages.
	 * The audio element is shared per file, so moving its currentTime would drag
	 * every other embed of the same file; instead each embed shows its own start
	 * here (display only) and seeks the shared element to it just-in-time when
	 * the user plays or skips this embed. Null when the embed has no #t= offset.
	 */
	private startHint: number | null = null;
	private playButton!: HTMLElement;
	private seekEl!: HTMLElement;
	/** Waveform renderer, or null when the plain bar is shown. */
	private waveform: WaveformCanvas | null = null;
	/** Marker/chapter UI, or null when markers are disabled. */
	private markerView: MarkerListView | null = null;
	private progressFillEl: HTMLElement | null = null;
	private timeEl: HTMLElement | null = null;
	private speedButton: HTMLElement | null = null;
	private isSeeking = false;
	private durationProbeActive = false;
	/**
	 * Guards the one-time render so onload (Reading view) and Obsidian's
	 * loadFile (Live Preview embed widget) never both render this player.
	 */
	private renderStarted = false;
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
	 * in Reading view - the regression this guards against.
	 */
	private editable = false;
	private resizeObserver: ResizeObserver | null = null;
	/** Observer that defers the waveform decode until the player is on screen. */
	private waveformObserver: IntersectionObserver | null = null;
	private muteButton: HTMLElement | null = null;
	/** Authoritative marker list for this file; the view renders from it. */
	private markers: PlayerMarker[] = [];
	/**
	 * Cleanups scoped to the CURRENT render pass (not the component lifetime).
	 * Run at the start of every renderUi and on unload, so observers and
	 * listeners created while building the UI are torn down per render instead
	 * of accumulating across in-place settings re-renders.
	 */
	private renderCleanups: Array<() => void> = [];

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
	 * and overwrites a player built too early - notably for files it
	 * treats as video (mp4, webm, mov, mkv, ogv). Rendering only after the
	 * embed is populated lets empty() clear Obsidian's native element so
	 * our player is the one that survives.
	 */
	onload(): void {
		if (this.options.immediate) {
			// The embed-registry path hands us an owned container with no
			// default player to wait for, so render right away
			this.safeRenderPlayer();
			return;
		}
		this.whenEmbedReady(() => {
			this.safeRenderPlayer();
		});
	}

	/**
	 * Obsidian's Live Preview embed lifecycle creates the embed component and
	 * then calls `loadFile()` on it to load the file. The enhanced player is
	 * constructed with its file and renders through the immediate path, so
	 * this just ensures that render ran. Its ABSENCE was the bug: the
	 * CodeMirror embed widget called `loadFile` on a component that lacked it
	 * ("loadFile is not a function"), which crashed the editor and blanked the
	 * note (Obsidian then reported "Failed to open"). Reading view renders via
	 * onload and never calls loadFile, which is why only edited notes broke.
	 * @param file - File Obsidian asks to load (the embed's own file)
	 */
	loadFile(file?: TFile): void {
		// Render only the embed-registry (immediate) path here; the
		// post-processor path renders from onload once the embed is ready.
		if (this.options.immediate && (!file || file.path === this.file.path)) {
			this.safeRenderPlayer();
		}
	}

	/**
	 * Renders the player, but never lets a render failure escape into
	 * Obsidian's embed loader - an uncaught throw there breaks opening the
	 * whole note (Obsidian reports "Failed to open"). On failure the full
	 * error is logged and the embed falls back to a plain native audio
	 * element, so the note still opens and the audio still plays.
	 */
	private safeRenderPlayer(): void {
		if (this.renderStarted) {
			return;
		}
		this.renderStarted = true;
		try {
			this.renderPlayer();
		} catch (error) {
			console.error(
				`${PLUGIN_LOG_PREFIX} Enhanced player failed to render for ${this.file.path}; falling back to the native audio element.`,
				error,
			);
			this.renderNativeFallback();
		}
	}

	/**
	 * Replaces the container with a plain native audio element. Last-resort
	 * fallback when the enhanced render throws, so an embed bug degrades to a
	 * working native player instead of blanking the note.
	 */
	private renderNativeFallback(): void {
		try {
			this.containerEl.empty();
			this.containerEl.removeClass('aar-player');
			const audio = this.containerEl.createEl('audio');
			audio.controls = true;
			audio.src = this.app.vault.getResourcePath(this.file);
		} catch (fallbackError) {
			console.error(
				`${PLUGIN_LOG_PREFIX} Native audio fallback also failed for ${this.file.path}.`,
				fallbackError,
			);
		}
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
		// Run the current render pass's cleanups on unload too, so the last
		// render's observers and listeners are torn down with the component
		this.register(() => {
			this.runRenderCleanups();
		});

		// Bind to the file's shared audio element so every view mode controls
		// the same playback; the registry releases it once the last player
		// unloads
		const { audio, isNew } = this.registry.acquireAudio(
			this.file.path,
			this.app.vault.getResourcePath(this.file),
		);
		this.audio = audio;
		// Apply player defaults ONLY when the shared audio is first created,
		// never on a re-render: otherwise a mode switch or an unrelated
		// settings save would reset the user's chosen speed and loop.
		if (isNew) {
			this.audio.loop = PLAYER_LOOP;
			this.audio.playbackRate = PLAYER_PLAYBACK_RATE;
		}
		this.register(() => {
			this.registry.releaseAudio(this.file.path);
		});

		this.registerAudioEvents();

		this.registry.register(this.file.path, this);
		this.register(() => {
			this.registry.unregister(this.file.path, this);
		});

		// Each embed shows its OWN #t= start (display only); the shared audio is
		// never moved on render, so a second embed of the same file is not
		// dragged to this embed's offset. renderUi's updateProgress reflects it.
		this.startHint = this.options.startSeconds;

		this.renderUi();
	}

	/**
	 * Re-renders the player UI from the current settings. Re-runnable: called
	 * on first render and again by applySettings when a window toggle
	 * changes. It rebuilds only the DOM the player owns inside its container,
	 * leaving the audio element (and playback) untouched - so toggling the
	 * waveform or markers window applies instantly without a note re-render.
	 */
	private renderUi(): void {
		// Tear down the previous render pass before rebuilding, so an in-place
		// settings re-render never accumulates observers or listeners on the
		// component lifetime (each is registered per render, see below). The
		// observers' own cleanups null these fields.
		this.runRenderCleanups();

		this.containerEl.empty();
		this.containerEl.addClass('aar-player');
		// The embed element keeps Obsidian's own audio loader alive; an
		// audio child it injects later is removed so our player is the
		// only one shown
		this.guardAgainstDefaultEmbed();

		// A fresh marker view per render (the DOM it owns is recreated by
		// empty()); the authoritative markers stay on this player
		this.markerView = this.settings.enableMarkers
			? this.createMarkerView()
			: null;
		this.markerView?.setEditable(this.editable);
		this.markerView?.setMarkers(this.markers);

		this.buildControls();
		this.buildSeekArea();
		if (this.markerView) {
			this.markerView.mountList(this.containerEl);
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

		if (this.shouldShowWaveform()) {
			this.scheduleWaveformLoad();
		}

		this.updateProgress();
	}

	/**
	 * Re-renders the player UI in place with new settings (e.g. after the
	 * waveform or markers window is toggled). Does nothing when the settings
	 * are unchanged, so a save that did not touch a player window - even an
	 * unrelated recording setting - never rebuilds an open player or resets
	 * its playback. Playback continues uninterrupted because the audio
	 * element is not rebuilt.
	 * @param settings - The new render-ready player settings
	 */
	applySettings(settings: ResolvedPlayerSettings): void {
		if (this.unloaded) {
			return;
		}
		if (playerSettingsEqual(settings, this.settings)) {
			return;
		}
		this.settings = settings;
		this.renderUi();
	}

	/**
	 * Seeks to an absolute offset, optionally starting playback. Timecode
	 * links start playback (the user clicked to listen); in-player marker and
	 * chapter jumps preserve the current play/pause state, matching a seek-bar
	 * drag.
	 * @param seconds - Target offset in seconds
	 * @param autoplay - Start playback after seeking (default true)
	 */
	seekTo(seconds: number, autoplay = true): void {
		// A user seek (timecode link, marker jump) engages the shared timeline
		this.engageTimeline();
		const target = Math.max(0, seconds);
		const apply = (): void => {
			this.audio.currentTime = Number.isFinite(this.audio.duration)
				? Math.min(target, this.audio.duration)
				: target;
			if (autoplay) {
				void this.audio.play().catch(() => {
					// Autoplay can be blocked; the user can press play
				});
			}
			// Reflect the new position immediately, since a paused jump fires
			// no timeupdate to refresh the seek visuals
			this.updateProgress();
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
	 * Builds the marker view with this player's lifecycle hooks and the
	 * callbacks that keep marker data and persistence owned by the player.
	 */
	private createMarkerView(): MarkerListView {
		const host: MarkerListHost = {
			register: (cleanup) => {
				this.registerRenderCleanup(cleanup);
			},
			registerDomEvent: (el, type, callback) => {
				this.registerRenderDomEvent(el, type, callback);
			},
		};
		const callbacks: MarkerListCallbacks = {
			// Jumps preserve the play/pause state (do not force playback)
			onJump: (time) => {
				this.seekTo(time, false);
			},
			onDelete: (id) => {
				void this.deleteMarker(id);
			},
			onRename: (id, label) => {
				void this.renameMarker(id, label);
			},
			onAddAt: (time, kind) => {
				void this.addMarkerAt(time, kind);
			},
			timeAtClientX: (clientX) => this.timeAtClientX(clientX),
		};
		return new MarkerListView(host, callbacks);
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
		this.registerRenderCleanup(() => observer.disconnect());
	}

	/**
	 * Builds the control row (play/pause, skip, speed, volume, loop,
	 * time, copy-timestamp). Every control is fixed; only the marker
	 * controls depend on the markers window being enabled.
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

		this.createIconButton(
			controls,
			'rewind',
			`Back ${String(PLAYER_SKIP_SECONDS)}s`,
			() => {
				this.skip(-PLAYER_SKIP_SECONDS);
			},
		);
		this.createIconButton(
			controls,
			'fast-forward',
			`Forward ${String(PLAYER_SKIP_SECONDS)}s`,
			() => {
				this.skip(PLAYER_SKIP_SECONDS);
			},
		);

		this.speedButton = controls.createEl('button', {
			cls: 'aar-player-btn aar-player-speed',
			// Reflect the shared audio's current rate, not the default, so a
			// re-render after a mode switch keeps showing the chosen speed
			text: formatPlaybackRate(this.audio.playbackRate),
		});
		this.speedButton.setAttribute('aria-label', 'Playback speed');
		this.registerRenderDomEvent(this.speedButton, 'click', (event) => {
			this.showSpeedMenu(event);
		});

		this.muteButton = this.createIconButton(
			controls,
			'volume-2',
			'Mute / unmute',
			() => {
				this.toggleMute();
			},
		);
		this.updateMuteIcon();

		const volume = controls.createEl('input', {
			cls: 'aar-player-volume',
			attr: {
				type: 'range',
				min: '0',
				max: '1',
				step: '0.05',
				// Reflect the shared audio's current volume on re-render
				value: String(this.audio.volume),
				'aria-label': 'Volume',
			},
		});
		this.registerRenderDomEvent(volume, 'input', () => {
			this.audio.volume = Number(volume.value);
			if (this.audio.muted && Number(volume.value) > 0) {
				this.audio.muted = false;
				this.updateMuteIcon();
			}
		});

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
					void this.addMarkerAt(
						this.audio.currentTime,
						MARKER_KIND.bookmark,
					);
				},
			).addClass('aar-player-edit-only');
			this.createIconButton(
				controls,
				'list-plus',
				'Add chapter at current position',
				() => {
					void this.addMarkerAt(
						this.audio.currentTime,
						MARKER_KIND.chapter,
					);
				},
			).addClass('aar-player-edit-only');
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

		this.timeEl = controls.createDiv({ cls: 'aar-player-time' });
		this.timeEl.setText('0:00 / 0:00');

		this.createIconButton(controls, 'link', 'Copy timestamp link', () => {
			void this.copyTimestampLink();
		});
	}

	/**
	 * Builds the seek area: a waveform when enabled (and the file is small
	 * enough), otherwise a linear progress bar. Both support click and drag
	 * seeking through the same pointer handlers.
	 */
	private buildSeekArea(): void {
		this.seekEl = this.containerEl.createDiv({ cls: 'aar-player-seek' });
		// Reset the renderer refs every render. Without this, toggling the
		// waveform off would leave a stale renderer so updateProgress would
		// target the dead canvas and never update the new progress bar.
		this.waveform = null;
		this.progressFillEl = null;
		// Expose the seek area as a keyboard-operable slider so seeking is
		// not mouse-only (the native audio element offered this for free)
		this.seekEl.setAttribute('role', 'slider');
		this.seekEl.setAttribute('tabindex', '0');
		this.seekEl.setAttribute('aria-label', 'Seek');
		this.seekEl.setAttribute('aria-valuemin', '0');
		if (this.shouldShowWaveform()) {
			this.seekEl.addClass('aar-player-seek-waveform');
			this.waveform = new WaveformCanvas(this.seekEl);
			this.resizeObserver = new ResizeObserver(() => {
				// Re-read theme colors in case the theme changed, then redraw
				this.waveform?.invalidateColors();
				this.waveform?.redraw();
			});
			this.resizeObserver.observe(this.seekEl);
			this.registerRenderCleanup(() => {
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
		if (this.markerView) {
			// Ticks/dblclick overlay sits on top of the seek area
			this.markerView.mountOverlay(this.seekEl);
		}
		this.registerSeekPointer();
		this.registerSeekKeyboard();
	}

	/**
	 * Wires keyboard seeking on the slider-role seek area: arrow keys
	 * nudge by a few seconds, Home/End jump to the bounds.
	 */
	private registerSeekKeyboard(): void {
		this.registerRenderDomEvent(this.seekEl, 'keydown', (event) => {
			switch (event.key) {
				case 'ArrowRight':
				case 'ArrowUp':
					this.skip(PLAYER_SEEK_KEYBOARD_STEP_SECONDS);
					break;
				case 'ArrowLeft':
				case 'ArrowDown':
					this.skip(-PLAYER_SEEK_KEYBOARD_STEP_SECONDS);
					break;
				case 'Home':
					this.engageTimeline();
					this.audio.currentTime = 0;
					this.updateProgress();
					break;
				case 'End':
					this.engageTimeline();
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
	 * Wires pointer events for click/drag seeking on the seek area. The
	 * seek area captures the pointer on press so a drag that leaves it
	 * still tracks, without a document-wide listener per player instance.
	 */
	private registerSeekPointer(): void {
		this.registerRenderDomEvent(this.seekEl, 'pointerdown', (event) => {
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
		this.registerRenderDomEvent(this.seekEl, 'pointermove', (event) => {
			if (this.isSeeking) {
				this.seekToPointer(event);
			}
		});
		this.registerRenderDomEvent(this.seekEl, 'pointerup', (event) => {
			this.isSeeking = false;
			if (this.seekEl.hasPointerCapture(event.pointerId)) {
				this.seekEl.releasePointerCapture(event.pointerId);
			}
		});
		this.registerRenderDomEvent(this.seekEl, 'pointercancel', () => {
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
		let attempts = PLAYER_ATTACH_WAIT_FRAMES;
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
		this.markerView?.setEditable(this.editable);
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
			// The copy-timestamp action is a fixed control, always available
			timestampLinksEnabled: true,
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
		this.registerRenderCleanup(() => {
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
		// A user drag engages the shared timeline
		this.engageTimeline();
		this.audio.currentTime = time;
		this.updateProgress();
	}

	/**
	 * Subscribes to the audio element's lifecycle events that drive the
	 * UI and resolves an initially-unknown (Infinity) duration.
	 */
	private registerAudioEvents(): void {
		this.registerDomEvent(this.audio, 'loadedmetadata', () => {
			// Some plugin-produced mp4 files load with no usable duration: it
			// reads as Infinity/NaN, or as a finite 0 (a multitrack mp4 whose
			// container never got its real length stamped). Both leave the
			// timeline stuck at 0:00, so probe for the true length in either case.
			if (
				!Number.isFinite(this.audio.duration) ||
				this.audio.duration <= 0
			) {
				this.resolveInfiniteDuration();
			} else {
				this.renderMarkers();
			}
			this.updateProgress();
		});
		this.registerDomEvent(this.audio, 'timeupdate', () => {
			this.updateProgress();
		});
		this.registerDomEvent(this.audio, 'play', () => {
			// Any play (this embed or another) makes the timeline live, so a
			// per-embed #t= start hint must not reappear afterwards
			this.engageTimeline();
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
	 * Resolves a duration the browser does not report up front - Infinity/NaN
	 * (common for MediaRecorder WebM) or a finite 0 (some multitrack mp4 whose
	 * container lacks a stamped length) - by probing a far seek position and
	 * waiting for a real, positive value, then restoring the start. When the
	 * seek yields no usable length the watchdog gives up and the bar stays
	 * unseekable, so a truly length-less file degrades rather than hangs.
	 */
	private resolveInfiniteDuration(): void {
		if (this.durationProbeActive) {
			return;
		}
		this.durationProbeActive = true;
		let watchdog = 0;
		const finish = (): void => {
			this.audio.removeEventListener('durationchange', onDurationChange);
			window.clearTimeout(watchdog);
			this.durationProbeActive = false;
			// Restore the start position; leaving currentTime near the probe
			// value would strand playback at the end of the file. The #t= start
			// (if any) is shown via the display hint, not by moving the shared
			// element here.
			this.audio.currentTime = 0;
			this.renderMarkers();
			this.updateProgress();
		};
		const onDurationChange = (): void => {
			// Wait for a real, positive length: a file that loaded at 0 reports a
			// finite-but-useless 0, so finishing on "finite" alone would lock in
			// the bogus zero instead of the corrected duration.
			if (
				Number.isFinite(this.audio.duration) &&
				this.audio.duration > 0
			) {
				finish();
			}
		};
		this.audio.addEventListener('durationchange', onDurationChange);
		// Give up if the corrected duration never arrives, so the probe
		// seek position is not left stranded at the end of the stream
		watchdog = window.setTimeout(() => {
			if (this.durationProbeActive) {
				finish();
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
			finish();
		}
	}

	/**
	 * The position to display for this embed: its #t= start hint while the
	 * shared audio is still untouched (at the very start, paused), otherwise the
	 * real shared playback position. This is what lets two embeds of one file
	 * show different start positions even though they share one audio element.
	 */
	private currentPosition(): number {
		if (
			this.startHint !== null &&
			this.audio.currentTime === 0 &&
			this.audio.paused &&
			!this.registry.isAudioEngaged(this.file.path)
		) {
			return Number.isFinite(this.audio.duration)
				? Math.min(this.startHint, this.audio.duration)
				: this.startHint;
		}
		return this.audio.currentTime;
	}

	/**
	 * Engages this embed's #t= start: seeks the shared audio to the hint (once,
	 * and only while it is still at the very start) so playback begins there,
	 * then clears the hint so the embed follows real shared playback. A no-op
	 * once already engaged or when the embed has no #t= offset.
	 */
	private engageStart(): void {
		if (this.startHint === null) {
			return;
		}
		const target = this.startHint;
		this.startHint = null;
		if (this.audio.currentTime === 0) {
			this.audio.currentTime = Number.isFinite(this.audio.duration)
				? Math.min(target, this.audio.duration)
				: target;
		}
	}

	/**
	 * Records that the user has engaged this file's shared playback (played or
	 * sought it). Consumes this embed's #t= start hint and marks the shared
	 * timeline engaged in the registry, so the hint never reappears on any
	 * embed of the file - even after playback later returns to 0.
	 */
	private engageTimeline(): void {
		this.startHint = null;
		this.registry.markAudioEngaged(this.file.path);
	}

	/**
	 * Decodes the waveform lazily: a long note with several recordings must not
	 * decode every embed up front. Waits until the player is near the viewport
	 * (IntersectionObserver), then decodes once. Environments without
	 * IntersectionObserver decode immediately so the waveform still appears. The
	 * observer is torn down on re-render and on unload.
	 */
	private scheduleWaveformLoad(): void {
		// typeof is safe even where IntersectionObserver is undeclared (tests,
		// non-DOM hosts); there, decode immediately so the waveform still shows
		if (typeof IntersectionObserver === 'undefined') {
			void this.loadWaveform();
			return;
		}
		const observer = new IntersectionObserver(
			(entries) => {
				if (!entries.some((entry) => entry.isIntersecting)) {
					return;
				}
				// One-shot: ignore any later callback for a consumed/replaced
				// observer, then decode once and stop observing
				if (this.waveformObserver !== observer) {
					return;
				}
				observer.disconnect();
				this.waveformObserver = null;
				void this.loadWaveform();
			},
			{ rootMargin: `${String(PLAYER_WAVEFORM_PREFETCH_MARGIN_PX)}px` },
		);
		this.waveformObserver = observer;
		observer.observe(this.containerEl);
		// Scoped to this render: a re-render or unload disconnects it, so a
		// stale observer never decodes into a replaced player
		this.registerRenderCleanup(() => {
			observer.disconnect();
			if (this.waveformObserver === observer) {
				this.waveformObserver = null;
			}
		});
	}

	/**
	 * Decodes the file and computes (or reuses cached) waveform peaks. The
	 * peaks are computed progressively off the main thread's hot path and the
	 * waveform is drawn as they fill in. A decode failure falls back silently
	 * to the plain, still-seekable bar.
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
			this.applyWaveformPeaks(cached);
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
			const peaks = await computeWaveformPeaksProgressive(
				channels,
				WAVEFORM_CACHE_BUCKETS,
				{
					// Draw each partial result so the waveform fills in
					onProgress: (snapshot) => {
						if (!this.unloaded) {
							this.waveform?.setPeaks(snapshot);
						}
					},
					shouldAbort: () => this.unloaded,
				},
			);
			if (this.unloaded) {
				return;
			}
			this.peakCache.set(cacheKey, peaks);
			this.applyWaveformPeaks(peaks);
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
	private applyWaveformPeaks(peaks: number[]): void {
		if (!this.waveform || this.unloaded) {
			return;
		}
		this.waveform.setPeaks(peaks);
		this.redrawWaveformWhenSized();
	}

	/**
	 * Draws the waveform once the seek area has a measurable width. On first
	 * render the canvas can be laid out a frame or two after the peaks are
	 * ready (width still 0), so a plain draw would no-op. Retry across a few
	 * animation frames until the width settles.
	 * @param attempts - Remaining retries before giving up
	 */
	private redrawWaveformWhenSized(
		attempts = PLAYER_WAVEFORM_REDRAW_RETRIES,
	): void {
		if (!this.waveform || !this.waveform.hasPeaks() || this.unloaded) {
			return;
		}
		if (this.seekEl.clientWidth > 0) {
			this.waveform.redraw();
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
	 * Updates the seek visuals and time display from the current
	 * playback position.
	 */
	private updateProgress(): void {
		// Use the display position (the #t= start hint until this embed engages,
		// else the real shared position) so each embed reflects its own start
		const position = this.currentPosition();
		const fraction = playbackProgress(position, this.audio.duration);
		if (this.waveform) {
			// Cheap: only moves the clip variable, no canvas work
			this.waveform.setProgress(fraction);
		} else if (this.progressFillEl) {
			// Set on the seek area so both the fill (width) and the thumb
			// (left) read the same position via the inherited variable
			this.seekEl.setCssProps({
				'--aar-progress': `${String(fraction * 100)}%`,
			});
		}
		const total =
			Number.isFinite(this.audio.duration) && this.audio.duration > 0
				? this.audio.duration
				: 0;
		if (this.timeEl) {
			// Format elapsed against the total so both sides share one width
			this.timeEl.setText(
				`${formatTimecode(position, total)} / ${formatTimecode(total, total)}`,
			);
		}
		// Keep the slider's accessible value in sync for screen readers
		this.seekEl.setAttribute('aria-valuemax', String(Math.floor(total)));
		this.seekEl.setAttribute('aria-valuenow', String(Math.floor(position)));
		this.seekEl.setAttribute(
			'aria-valuetext',
			`${formatTimecode(position, total)} of ${formatTimecode(total, total)}`,
		);
		// Move the active-segment highlight as playback crosses boundaries
		this.markerView?.updateActive(position);
	}

	/**
	 * Toggles playback, swallowing autoplay-policy rejections.
	 */
	private togglePlay(): void {
		if (this.audio.paused) {
			// Begin from this embed's #t= start (if pending) rather than 0
			this.engageStart();
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
		// Engage the #t= start first so a skip is relative to the shown position
		this.engageStart();
		this.engageTimeline();
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
		const label = defaultMarkerLabel(this.markers, kind);
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
	 * Renames a marker, persists, and refreshes the ticks. The list is not
	 * rebuilt so the input the user is typing in keeps focus.
	 * @param id - Marker identifier
	 * @param label - New label
	 */
	private async renameMarker(id: string, label: string): Promise<void> {
		this.markers = updateMarker(this.markers, id, { label });
		this.markerView?.setMarkers(this.markers);
		this.markerView?.refreshTicks(this.knownDuration());
		await this.persistMarkers();
	}

	/**
	 * Jumps playback to the next chapter after the current position,
	 * preserving the play/pause state.
	 */
	private jumpToNextChapter(): void {
		const target = nextChapterTime(
			chapters(this.markers),
			this.audio.currentTime,
		);
		if (target !== null) {
			this.seekTo(target, false);
		}
	}

	/**
	 * Jumps playback to the previous chapter (or the start of the current
	 * one shortly after its boundary), preserving the play/pause state.
	 */
	private jumpToPreviousChapter(): void {
		const target = previousChapterTime(
			chapters(this.markers),
			this.audio.currentTime,
		);
		this.seekTo(target ?? 0, false);
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
	 * Re-renders this player's markers (ticks and list) from the current
	 * data and duration.
	 */
	private renderMarkers(): void {
		if (!this.settings.enableMarkers) {
			return;
		}
		this.markerView?.setMarkers(this.markers);
		this.markerView?.render(this.knownDuration(), this.audio.currentTime);
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
		this.registerRenderDomEvent(button, 'click', onClick);
		return button;
	}

	/**
	 * Registers a cleanup tied to the CURRENT render pass rather than the
	 * component lifetime, so re-rendering in place tears down the previous
	 * render's observers and listeners instead of stacking them.
	 * @param cleanup - Cleanup callback
	 */
	private registerRenderCleanup(cleanup: () => void): void {
		this.renderCleanups.push(cleanup);
	}

	/**
	 * Runs and clears the current render pass's cleanups. Called at the start
	 * of every re-render and once on unload.
	 */
	private runRenderCleanups(): void {
		const cleanups = this.renderCleanups;
		this.renderCleanups = [];
		for (const cleanup of cleanups) {
			cleanup();
		}
	}

	/**
	 * Adds a DOM listener scoped to the current render pass. The target element
	 * is recreated on every renderUi (containerEl.empty()), so its listener is
	 * removed per render rather than retained on the component until unload.
	 * @param el - Target element (recreated each render)
	 * @param type - DOM event type
	 * @param handler - Event handler
	 */
	private registerRenderDomEvent<K extends keyof HTMLElementEventMap>(
		el: HTMLElement,
		type: K,
		handler: (event: HTMLElementEventMap[K]) => void,
	): void {
		el.addEventListener(type, handler as EventListener);
		this.registerRenderCleanup(() => {
			el.removeEventListener(type, handler as EventListener);
		});
	}

	/**
	 * Whether the waveform should be drawn for this file. It is shown for files
	 * up to a high safety ceiling; a pathological multi-gigabyte file falls back
	 * to the plain (still seekable) bar instead, because decoding it for a
	 * cosmetic waveform would risk an out-of-memory spike. Realistic recordings
	 * stay well under the ceiling and are still drawn progressively.
	 */
	private shouldShowWaveform(): boolean {
		return (
			this.settings.showWaveform &&
			this.file.stat.size <= WAVEFORM_MAX_DECODE_BYTES
		);
	}
}
