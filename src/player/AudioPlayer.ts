/**
 * Enhanced audio player rendered in place of Obsidian's built-in audio
 * embed. Adds a waveform (or seek bar), playback-speed control, skip
 * buttons, a volume control, mute, loop, a time display, per-file
 * markers and chapters, and a "copy timestamp link" action. Implemented
 * as a MarkdownRenderChild so its lifecycle (event listeners, audio
 * element, registry registration, observers) is torn down automatically
 * when the note re-renders or the leaf closes.
 *
 * The class is a coordinator: it owns the embed-takeover lifecycle, the
 * shared audio element, and the #t= start hint, and wires the
 * collaborators that do the rest - PlayerControlsView (control row),
 * SeekController (pointer/keyboard seeking), DurationProbe
 * (initially-unknown durations), WaveformController (progressive decode
 * and drawing), PlayerMarkerController (marker CRUD and persistence),
 * plus WaveformCanvas and MarkerListView for the rendered surfaces.
 * @module player/AudioPlayer
 */

import { MarkdownRenderChild, Menu, Notice } from 'obsidian';
import type { App, TFile } from 'obsidian';
import {
	PLUGIN_LOG_PREFIX,
	PLAYER_PLAYBACK_RATE_PRESETS,
	PLAYER_LOOP,
	PLAYER_PLAYBACK_RATE,
	PLAYER_ATTACH_WAIT_FRAMES,
} from '../constants';
import { formatTimecode } from '../utils/TimeUtils';
import { playbackProgress } from './playbackProgress';
import {
	playerSettingsEqual,
	type ResolvedPlayerSettings,
} from '../player/playerSettings';
import { WaveformPeakCache, type AudioDecoder } from './WaveformData';
import { playbackKey } from './AudioPlayerRegistry';
import type {
	AudioPlayerRegistry,
	SeekablePlayer,
} from './AudioPlayerRegistry';
import type { MarkerStore } from '../markers/MarkerStore';
import type { MarkerKind } from '../markers/markerModel';
import { speedMenuItems } from './playbackRate';
import { isEditableContext } from './playerMode';
import {
	setPlayerEmbedActions,
	clearPlayerEmbedActions,
	type PlayerEmbedActions,
} from './playerEmbedActions';
import { DurationProbe } from './DurationProbe';
import { SeekController } from './SeekController';
import { WaveformController } from './WaveformController';
import { PlayerMarkerController } from './PlayerMarkerController';
import { PlayerControlsView } from './views/PlayerControlsView';
import {
	MarkerListView,
	type MarkerListCallbacks,
	type MarkerListHost,
} from './views/MarkerListView';

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
	/** Shared audio element for this embed's playback key, acquired from the
	 * registry on render so the same embed across view modes controls one
	 * playback while distinct embeds of the file stay independent. */
	private audio!: HTMLAudioElement;
	/**
	 * Identity key of this embed's shared audio element: the file path plus
	 * the #t= start (see playbackKey). Distinct embeds of one file get
	 * different keys and so independent playback; the same embed re-created
	 * across a view-mode switch re-acquires its element under this key.
	 */
	private readonly audioKey: string;
	/**
	 * The #t= start position to show for THIS embed until its playback engages.
	 * The audio element can be shared with the same embed in another view/pane,
	 * so moving its currentTime eagerly would drag that copy; instead the embed
	 * shows its start here (display only) and seeks the shared element to it
	 * just-in-time when the user plays or skips this embed. Null when the embed
	 * has no #t= offset.
	 */
	private startHint: number | null = null;
	private seekEl!: HTMLElement;
	/** Control row for the current render, or null before the first render. */
	private controls: PlayerControlsView | null = null;
	/** Marker/chapter UI, or null when markers are disabled. */
	private markerView: MarkerListView | null = null;
	private progressFillEl: HTMLElement | null = null;
	/** Pointer/keyboard seeking and the clientX-to-time mapping. */
	private readonly seekCtl: SeekController;
	/** Progressive waveform decode and rendering. */
	private readonly waveformCtl: WaveformController;
	/** Marker data, persistence, and chapter navigation. */
	private readonly markerCtl: PlayerMarkerController;
	/** Probe for sources that load without a usable duration. */
	private durationProbe: DurationProbe | null = null;
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
		peakCache: WaveformPeakCache,
		decoder: AudioDecoder,
		markerStore: MarkerStore,
		private readonly options: AudioPlayerOptions,
	) {
		super(containerEl);
		this.audioKey = playbackKey(file.path, options.startSeconds);
		this.seekCtl = new SeekController(
			{
				registerDomEvent: (el, type, handler) => {
					this.registerRenderDomEvent(el, type, handler);
				},
			},
			{
				onSeekToTime: (seconds) => {
					// A user seek engages the shared timeline
					this.engageTimeline();
					this.audio.currentTime = seconds;
					this.updateProgress();
				},
				onSkip: (deltaSeconds) => {
					this.skip(deltaSeconds);
				},
				onEngageTimeline: () => {
					this.engageTimeline();
				},
				duration: () => this.audio.duration,
			},
		);
		this.waveformCtl = new WaveformController(
			app,
			file,
			decoder,
			peakCache,
			{
				registerRenderCleanup: (cleanup) => {
					this.registerRenderCleanup(cleanup);
				},
				isUnloaded: () => this.unloaded,
			},
		);
		this.markerCtl = new PlayerMarkerController(markerStore, file.path, {
			isUnloaded: () => this.unloaded,
			renderMarkers: () => {
				this.renderMarkers();
			},
			refreshTicks: () => {
				this.markerView?.setMarkers(this.markerCtl.all);
				this.markerView?.refreshTicks(this.knownDuration());
			},
			notifyOthers: () => {
				this.registry.reloadMarkers(this.file.path, this);
			},
		});
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
	override onload(): void {
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

		// Bind to this embed's shared audio element (keyed by file path plus
		// #t= start) so the same embed across view modes controls one playback
		// while other embeds of the file stay independent; the registry
		// releases it once the last player unloads
		const { audio, isNew } = this.registry.acquireAudio(
			this.audioKey,
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
		const unregisterPlaybackController =
			this.registry.registerPlaybackController(this.audioKey, {
				canAddMarkers: () => this.settings.enableMarkers,
				togglePlay: () => {
					this.togglePlay();
				},
				stop: () => {
					this.stopPlayback();
				},
				skip: (deltaSeconds) => {
					this.skip(deltaSeconds);
				},
				toggleMute: () => {
					this.toggleMute();
				},
				setVolume: (volume) => {
					this.setVolume(volume);
				},
				addMarker: (kind) => {
					void this.markerCtl.addAt(this.audio.currentTime, kind);
				},
			});
		this.register(unregisterPlaybackController);
		this.register(() => {
			this.registry.releaseAudio(this.audioKey);
		});

		this.durationProbe = new DurationProbe(this.audio, () => {
			this.renderMarkers();
			this.updateProgress();
		});
		this.register(() => {
			this.durationProbe?.cancel();
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
		// component lifetime (each is registered per render, see below).
		this.runRenderCleanups();

		this.containerEl.empty();
		this.containerEl.addClass('aar-player');
		// The embed element keeps Obsidian's own audio loader alive; an
		// audio child it injects later is removed so our player is the
		// only one shown
		this.guardAgainstDefaultEmbed();

		// A fresh marker view per render (the DOM it owns is recreated by
		// empty()); the authoritative markers stay on the marker controller
		this.markerView = this.settings.enableMarkers
			? this.createMarkerView()
			: null;
		this.markerView?.setEditable(this.editable);
		this.markerView?.setMarkers(this.markerCtl.all);

		this.buildControls();
		this.buildSeekArea();
		if (this.markerView) {
			this.markerView.mountList(this.containerEl);
		}

		if (this.settings.enableMarkers) {
			void this.markerCtl.load();
		} else {
			this.markerCtl.clear();
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
			this.waveformCtl.scheduleLoad(this.containerEl);
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
			void this.markerCtl.load();
		}
	}

	/**
	 * Builds the marker view with this player's lifecycle hooks and the
	 * callbacks that route marker edits through the marker controller.
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
				void this.markerCtl.remove(id);
			},
			onRename: (id, label) => {
				void this.markerCtl.rename(id, label);
			},
			onAddAt: (time, kind) => {
				void this.markerCtl.addAt(time, kind);
			},
			timeAtClientX: (clientX) => this.seekCtl.timeAtClientX(clientX),
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
	 * Builds the control row for the current render, reflecting the shared
	 * audio's live state (a player re-rendered while playback is running
	 * must not show stale defaults).
	 */
	private buildControls(): void {
		this.controls = new PlayerControlsView(
			{
				registerDomEvent: (el, type, handler) => {
					this.registerRenderDomEvent(el, type, handler);
				},
			},
			{
				onTogglePlay: () => {
					this.togglePlay();
				},
				onSkip: (deltaSeconds) => {
					this.skip(deltaSeconds);
				},
				onSpeedMenu: (event) => {
					this.showSpeedMenu(event);
				},
				onToggleMute: () => {
					this.toggleMute();
				},
				onVolumeInput: (volume) => {
					this.setVolume(volume);
				},
				onToggleLoop: () => {
					this.audio.loop = !this.audio.loop;
					return this.audio.loop;
				},
				onAddMarker: (kind: MarkerKind) => {
					void this.markerCtl.addAt(this.audio.currentTime, kind);
				},
				onPreviousChapter: () => {
					this.jumpToPreviousChapter();
				},
				onNextChapter: () => {
					this.jumpToNextChapter();
				},
				onCopyTimestampLink: () => {
					void this.copyTimestampLink();
				},
			},
		);
		this.controls.mount(this.containerEl, {
			paused: this.audio.paused,
			playbackRate: this.audio.playbackRate,
			volume: this.audio.volume,
			muted: this.audio.muted,
			loop: this.audio.loop,
			markersEnabled: this.settings.enableMarkers,
		});
	}

	/**
	 * Builds the seek area: a waveform when enabled (and the file is small
	 * enough), otherwise a linear progress bar. Both support click and drag
	 * seeking through the same seek controller.
	 */
	private buildSeekArea(): void {
		this.seekEl = this.containerEl.createDiv({ cls: 'aar-player-seek' });
		// Reset the renderer refs every render. Without this, toggling the
		// waveform off would leave a stale renderer so updateProgress would
		// target the dead canvas and never update the new progress bar.
		this.waveformCtl.reset();
		this.progressFillEl = null;
		// Expose the seek area as a keyboard-operable slider so seeking is
		// not mouse-only (the native audio element offered this for free)
		this.seekEl.setAttribute('role', 'slider');
		this.seekEl.setAttribute('tabindex', '0');
		this.seekEl.setAttribute('aria-label', 'Seek');
		this.seekEl.setAttribute('aria-valuemin', '0');
		if (this.shouldShowWaveform()) {
			this.seekEl.addClass('aar-player-seek-waveform');
			this.waveformCtl.mount(this.seekEl);
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
		this.seekCtl.attach(this.seekEl);
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
		let rafId = 0;
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
			rafId = window.requestAnimationFrame(tick);
		};
		rafId = window.requestAnimationFrame(tick);
		// Cancel outright on re-render/unload instead of relying on the
		// unloaded flag alone to fizzle the loop.
		this.registerRenderCleanup(() => {
			window.cancelAnimationFrame(rafId);
		});
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
			timeAtClientX: (clientX: number) =>
				this.seekCtl.timeAtClientX(clientX),
			addMarkerAtTime: (time: number, kind: MarkerKind) => {
				void this.markerCtl.addAt(time, kind);
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
				this.durationProbe?.probe();
			} else {
				this.renderMarkers();
			}
			this.updateProgress();
		});
		this.registerDomEvent(this.audio, 'timeupdate', () => {
			this.updateProgress();
		});
		this.registerDomEvent(this.audio, 'play', () => {
			// Any play (this player or the same embed in another view/pane)
			// makes the timeline live, so the #t= start hint must not
			// reappear afterwards
			this.engageTimeline();
			this.controls?.setPlaying(true);
		});
		this.registerDomEvent(this.audio, 'pause', () => {
			this.controls?.setPlaying(false);
		});
		this.registerDomEvent(this.audio, 'ended', () => {
			this.controls?.setPlaying(false);
		});
	}

	/**
	 * The position to display for this embed: its #t= start hint while its
	 * shared audio is still untouched (at the very start, paused), otherwise the
	 * real playback position. The hint keeps the displayed start correct even
	 * though the element itself is not moved until the user engages this embed.
	 */
	private currentPosition(): number {
		if (
			this.startHint !== null &&
			this.audio.currentTime === 0 &&
			this.audio.paused &&
			!this.registry.isAudioEngaged(this.audioKey)
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
	 * Records that the user has engaged this embed's shared playback (played or
	 * sought it). Consumes the #t= start hint and marks the timeline engaged in
	 * the registry, so the hint never reappears on this embed (or its copy in
	 * another view/pane) - even after playback later returns to 0. Other embeds
	 * of the same file have their own playback and keep their own hints.
	 */
	private engageTimeline(): void {
		this.startHint = null;
		this.registry.markAudioEngaged(this.audioKey);
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
		if (this.waveformCtl.isMounted()) {
			// Cheap: only moves the clip variable, no canvas work
			this.waveformCtl.setProgress(fraction);
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
		// Format elapsed against the total so both sides share one width
		this.controls?.setTime(
			`${formatTimecode(position, total)} / ${formatTimecode(total, total)}`,
		);
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

	/** Stops playback, resets the timeline, and refreshes the embedded player. */
	private stopPlayback(): void {
		this.audio.pause();
		this.audio.currentTime = 0;
		this.updateProgress();
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
		this.controls?.setPlaybackRate(rate);
	}

	/**
	 * Toggles the muted state and refreshes the mute button icon.
	 */
	private toggleMute(): void {
		this.audio.muted = !this.audio.muted;
		this.controls?.setMuted(this.audio.muted);
	}

	/**
	 * Applies a volume value and unmutes when the requested level is audible.
	 * @param volume - Volume in the inclusive 0..1 range
	 */
	private setVolume(volume: number): void {
		this.audio.volume = volume;
		if (this.audio.muted && volume > 0) {
			this.audio.muted = false;
			this.controls?.setMuted(false);
		}
	}

	/**
	 * Jumps playback to the next chapter after the current position,
	 * preserving the play/pause state.
	 */
	private jumpToNextChapter(): void {
		const target = this.markerCtl.nextChapter(this.audio.currentTime);
		if (target !== null) {
			this.seekTo(target, false);
		}
	}

	/**
	 * Jumps playback to the previous chapter (or the start of the current
	 * one shortly after its boundary), preserving the play/pause state.
	 */
	private jumpToPreviousChapter(): void {
		const target = this.markerCtl.previousChapter(this.audio.currentTime);
		this.seekTo(target ?? 0, false);
	}

	/**
	 * Re-renders this player's markers (ticks and list) from the current
	 * data and duration.
	 */
	private renderMarkers(): void {
		if (!this.settings.enableMarkers) {
			return;
		}
		this.markerView?.setMarkers(this.markerCtl.all);
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
	 * Whether the waveform should be drawn for this file (window toggle on
	 * and the file below the decode safety ceiling).
	 */
	private shouldShowWaveform(): boolean {
		return this.waveformCtl.shouldRender(this.settings.showWaveform);
	}
}
