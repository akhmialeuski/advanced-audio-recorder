/**
 * Wires the enhanced audio player into Obsidian. It registers a custom
 * embed creator in Obsidian's embed registry, so Obsidian itself builds the
 * embed for the plugin's media extensions in both Reading view and Live
 * Preview. The registrar is the single decision point:
 *
 *   - audio-only file + feature on  -> the enhanced AudioPlayer
 *   - anything else (video, unsupported, feature off, or a video-capable
 *     container not yet probed) -> Obsidian's OWN native embed, returned
 *     unwrapped. Returning the native embed verbatim is what keeps both
 *     view modes correct: it renders exactly as it would without the
 *     plugin, so Live Preview never doubles it and nothing fights
 *     CodeMirror.
 *
 * The media kind is always determined by probing the actual content (the
 * extension is never trusted, since a container can carry a video track):
 * each file is probed once per session and cached per path, and confident
 * results persist across sessions (MediaKindStore, validated by
 * mtime/size). A not-yet-probed file renders inside a MediaEmbedShell
 * that hosts the native embed and upgrades to the enhanced player IN
 * PLACE when the probe confirms audio - the embedding note is never
 * re-rendered, so a large note is not lagged by a short recording
 * (issue #39). Only the master toggle flip re-renders open views
 * (leaf.rebuildView), because it changes what every embed is in both
 * modes at once. When the internal registry API is unavailable, a
 * Markdown post-processor takes over embeds (Reading view only). A click
 * handler bound on every window's document (main and pop-out) routes timecode
 * links to a live player. All paths respect the feature toggle.
 * @module player/EnhancedPlayerRegistrar
 */

import { TFile, MarkdownView, debounce } from 'obsidian';
import type {
	App,
	Editor,
	MarkdownPostProcessorContext,
	Plugin,
	WorkspaceLeaf,
} from 'obsidian';
import { AUDIO_EXTENSIONS, PLUGIN_LOG_PREFIX } from '../constants';
import type { AudioRecorderSettings } from '../settings/settingsSchema';
import {
	resolvePlayerSettings,
	playerSettingsEqual,
	type ResolvedPlayerSettings,
} from '../player/playerSettings';
import { AudioPlayerRegistry, playbackKey } from './AudioPlayerRegistry';
import { DetachedPlayback } from './DetachedPlayback';
import type {
	PlaybackControlsListener,
	PlaybackControlsState,
} from './playbackControls';
import { WaveformPeakCache, SharedAudioDecoder } from './WaveformData';
import { AudioPlayer } from './AudioPlayer';
import {
	parseAudioLinkTarget,
	isAudioFile,
	parseTimecodeSubpath,
	wikiLinkTargetAtCursor,
} from './timecodeLinks';
import { probeMediaKind, MEDIA_KIND, type MediaKind } from './mediaProbe';
import { registerDomEventOnAllWindows } from '../utils/multiWindowDomEvents';
import { markdownViewContaining } from '../utils/windowScopedViews';
import { MediaEmbedShell } from './MediaEmbedShell';
import type { MediaKindStore } from './MediaKindStore';
import { shouldEnhance } from './playerMode';
import type { RecordingSidecarStore } from '../sidecar/RecordingSidecarStore';
import {
	getEmbedRegistry,
	EmbedRegistryOverride,
	type EmbedComponent,
	type EmbedInfo,
} from '../obsidian/embedRegistry';

/** Dataset flag marking an embed already taken over by the player. */
const ENHANCED_FLAG = 'aarEnhanced';

/**
 * Debounce window for re-rendering open views. Coalesces a burst of
 * settings changes (e.g. dragging a slider) into a single re-render.
 */
const RERENDER_DEBOUNCE_MS = 50;

/**
 * Registers and owns the enhanced player integration.
 */
export class EnhancedPlayerRegistrar {
	private readonly registry = new AudioPlayerRegistry();
	private readonly peakCache = new WaveformPeakCache();
	/** One AudioContext shared by every player for waveform decoding. */
	private readonly decoder = new SharedAudioDecoder();
	/** Active embed-registry override, or null when on the fallback path. */
	private embedOverride: EmbedRegistryOverride | null = null;
	/** Probed media kind per file path, shared so each file is probed once. */
	private readonly mediaKindCache = new Map<string, MediaKind>();
	/** In-flight probe per file path, shared by every embed of the file. */
	private readonly probes = new Map<string, Promise<MediaKind>>();
	/** Last seen feature-enabled state, so refresh re-renders only on a flip. */
	private lastEnabled = false;
	/** Last applied resolved layout, so an unchanged save re-applies nothing. */
	private lastResolved: ResolvedPlayerSettings | null = null;
	/** Whether every leaf must re-render (master toggle flip). */
	private pendingRerenderAll = false;
	/**
	 * Active timecode playback started when no embedded player was on screen,
	 * or null. Controlled through the status-bar controls, it plays the file's
	 * shared audio directly so a transcript timestamp always plays from that
	 * moment instead of opening the raw file.
	 */
	private detachedPlayback: DetachedPlayback | null = null;
	/** Debounced flush that coalesces a burst of re-render requests. */
	private readonly scheduleRerender = debounce(
		() => this.flushRerender(),
		RERENDER_DEBOUNCE_MS,
		true,
	);

	/**
	 * @param plugin - Owning plugin (for registration lifecycle)
	 * @param app - Obsidian App instance
	 * @param getSettings - Returns the current plugin settings
	 * @param markerStore - Persistence for markers and chapters
	 * @param mediaKindStore - Cross-session media-kind cache, if any
	 */
	constructor(
		private readonly plugin: Plugin,
		private readonly app: App,
		private readonly getSettings: () => AudioRecorderSettings,
		private readonly markerStore: RecordingSidecarStore,
		private readonly mediaKindStore: MediaKindStore | null = null,
	) {}

	/**
	 * Registers the embed creator, the markdown post-processor fallback, the
	 * timecode-link click handler, and the marker sidecar move/delete
	 * handlers. Safe to call once during plugin load.
	 */
	register(): void {
		// Loading later just means early embeds probe instead of hitting
		// the persisted cache, so plugin load is never delayed by it
		void this.mediaKindStore?.load();
		this.lastEnabled = this.getSettings().enhancedPlayerEnabled;
		this.lastResolved = this.lastEnabled
			? resolvePlayerSettings(this.getSettings())
			: null;
		this.setupEmbedRegistry();

		this.plugin.registerMarkdownPostProcessor((el, ctx) => {
			// The embed registry already handles every mode; the
			// post-processor is only the Reading-view fallback
			if (this.embedOverride) {
				return;
			}
			if (!this.getSettings().enhancedPlayerEnabled) {
				return;
			}
			const embeds = Array.from(
				el.querySelectorAll<HTMLElement>('.internal-embed'),
			);
			for (const embed of embeds) {
				this.tryEnhanceEmbed(embed, ctx);
			}
		});

		// Bind the timecode-link click handler on every window's document,
		// including pop-out windows, so a transcript timestamp clicked in a
		// popped-out note routes to a live player instead of being ignored
		// (a pop-out has its own document that never shares events with the
		// main window).
		registerDomEventOnAllWindows(
			this.plugin,
			this.app,
			'click',
			(event) => {
				this.handleTimecodeClick(event);
			},
			{ capture: true },
		);

		// Keep each recording's marker sidecar and media-kind cache entries
		// attached to the file: move them on rename/move, drop them on delete.
		// Renames of other files update the transcript-output paths recorded
		// in the sidecars, so a moved note or transcript file stays reachable
		// for speaker renaming instead of orphaning.
		this.plugin.registerEvent(
			this.app.vault.on('rename', (file, oldPath) => {
				if (!(file instanceof TFile)) {
					return;
				}
				if (isAudioFile(file)) {
					void this.markerStore.handleRename(oldPath, file.path);
					const kind = this.mediaKindCache.get(oldPath);
					if (kind) {
						this.mediaKindCache.delete(oldPath);
						this.mediaKindCache.set(file.path, kind);
					}
					this.mediaKindStore?.handleRename(oldPath, file.path);
					return;
				}
				void this.markerStore.handleOutputRename(oldPath, file.path);
			}),
		);
		this.plugin.registerEvent(
			this.app.vault.on('delete', (file) => {
				if (file instanceof TFile && isAudioFile(file)) {
					void this.markerStore.handleDelete(file.path);
					this.mediaKindCache.delete(file.path);
					this.mediaKindStore?.handleDelete(file.path);
				}
			}),
		);
	}

	/**
	 * Subscribes the shared status bar to active enhanced-player playback.
	 * The registry owns the subscription and releases it during dispose.
	 * @param listener - Consumer for active playback snapshots
	 */
	subscribePlayback(listener: PlaybackControlsListener): void {
		this.registry.subscribePlayback(listener);
	}

	/**
	 * Reads the active playback as it stands right now, for a caller that has
	 * to act on it rather than render it.
	 * @returns Current playback controls, or null while no audio is active
	 */
	currentPlaybackState(): PlaybackControlsState | null {
		return this.registry.currentPlaybackState();
	}

	/**
	 * Tells every connected player of a recording to re-read its markers.
	 * Used when markers change outside any player (e.g. generated chapters
	 * were written to the sidecar), so open players show them at once.
	 * @param path - Vault-relative recording path whose markers changed
	 */
	reloadMarkersFor(path: string): void {
		// The change came from outside any player (generated chapters), so pass
		// a null source to reach every registered player of the file. This is
		// the same purpose-built marker-reload the registry uses to keep views
		// in sync when a marker is added in one of them: each player re-reads
		// the store and re-renders only its own marker view, nothing else on
		// the page.
		this.registry.reloadMarkers(path, null);
	}

	/**
	 * Releases retained players and cached peaks. Called on unload so
	 * nothing outlives the plugin.
	 */
	dispose(): void {
		// Restore Obsidian's default embed creators before anything else,
		// so disabling the plugin never leaves overridden media embeds
		this.embedOverride?.restore();
		this.embedOverride = null;
		this.scheduleRerender.cancel();
		// Stop any timecode playback that has no embed to unload it
		this.detachedPlayback?.dispose();
		this.detachedPlayback = null;
		this.registry.clear();
		this.peakCache.clear();
		this.mediaKindCache.clear();
		this.probes.clear();
		// Persist any probe results from the final debounce window
		this.mediaKindStore?.flush();
		this.markerStore.clearCache();
		void this.decoder.close().catch(() => {
			// Closing a context that never opened or already failed is
			// non-fatal during teardown
		});
	}

	/**
	 * Applies a settings change. Toggling the master enable flips which
	 * component each embed is (native vs enhanced), so it needs a view
	 * re-render - but only on the actual flip. Every other player setting
	 * (the waveform and markers windows) is applied IN PLACE to the live
	 * players, so it never re-renders the note. This split is what keeps
	 * settings changes from lagging the page.
	 */
	refresh(): void {
		const enabled = this.getSettings().enhancedPlayerEnabled;
		if (enabled !== this.lastEnabled) {
			this.lastEnabled = enabled;
			this.lastResolved = enabled
				? resolvePlayerSettings(this.getSettings())
				: null;
			if (!enabled) {
				// Detached timecode playback has no embed to unload and release
				// it, so disabling the feature must stop it here; otherwise the
				// audio and its status-bar controls outlive the switch-off.
				this.detachedPlayback?.dispose();
				this.detachedPlayback = null;
			}
			// A flip changes what every embed is (native vs enhanced), so
			// every leaf must re-render
			this.requestRerenderAll();
			return;
		}
		if (!enabled) {
			return;
		}
		const resolved = resolvePlayerSettings(this.getSettings());
		// Skip when no player window changed, so an unrelated settings save
		// never reapplies the layout to (or rebuilds) open players
		if (
			this.lastResolved &&
			playerSettingsEqual(resolved, this.lastResolved)
		) {
			return;
		}
		this.lastResolved = resolved;
		this.registry.applySettings(resolved);
	}

	/**
	 * Primes freshly saved recordings for enhancement by starting their
	 * media probe right away. When Obsidian then creates the embed, the
	 * kind is either already cached (the embed is built enhanced from the
	 * start) or the embed's shell joins the in-flight probe and upgrades
	 * in place - no note re-render in either case.
	 * @param audioPaths - Vault paths written by the recording finalizer
	 */
	primeSavedRecordingsForEnhancement(audioPaths: string[]): void {
		if (!this.getSettings().enhancedPlayerEnabled) {
			return;
		}
		for (const audioPath of audioPaths) {
			const file = this.app.vault.getFileByPath(audioPath);
			if (!file || !isAudioFile(file)) {
				continue;
			}
			void this.probeKind(file);
		}
	}

	/**
	 * Registers a custom embed creator for the plugin's media extensions
	 * via Obsidian's internal embed registry, capturing the originals for
	 * restoration. No-ops (leaving the post-processor fallback active)
	 * when the internal API is unavailable.
	 */
	private setupEmbedRegistry(): void {
		// A failure here must never abort plugin load: fall back to the
		// post-processor (Reading view) instead of crashing
		try {
			const registry = getEmbedRegistry(this.app);
			if (!EmbedRegistryOverride.isAvailable(registry)) {
				console.warn(
					`${PLUGIN_LOG_PREFIX} Embed registry API unavailable; using the Markdown post-processor fallback (Reading view only).`,
				);
				return;
			}
			const override = new EmbedRegistryOverride(registry);
			override.override(AUDIO_EXTENSIONS, (info, file, subpath) =>
				this.createEmbed(info, file, subpath),
			);
			this.embedOverride = override;
		} catch (error) {
			console.warn(
				`${PLUGIN_LOG_PREFIX} Failed to set up the embed registry; using the Markdown post-processor fallback.`,
				error,
			);
			this.embedOverride?.restore();
			this.embedOverride = null;
		}
	}

	/**
	 * Embed creator installed in the registry. Returns the enhanced player
	 * for files probed as audio-only when the feature is on, and otherwise
	 * Obsidian's own native embed unwrapped (so video and unsupported files
	 * render exactly as Obsidian would, in both view modes). A not-yet-probed
	 * file renders inside a MediaEmbedShell: the native embed shows now,
	 * the content is probed in the background, and an audio-only verdict
	 * upgrades this one embed in place - the note is never re-rendered.
	 * @param info - Embed context from Obsidian
	 * @param file - Media file to embed
	 * @param subpath - Embed subpath (timecode, if any)
	 */
	private createEmbed(
		info: EmbedInfo,
		file: TFile,
		subpath: string,
	): EmbedComponent {
		const nativeCreator = this.embedOverride?.getPrevious(file.extension);
		// A throw here propagates into Obsidian's embed registry and breaks
		// opening the whole note ("Failed to open"). Guard it: log the full
		// error and fall back to Obsidian's native embed so the note opens.
		try {
			const enabled = this.getSettings().enhancedPlayerEnabled;
			const kind = this.knownKind(file);

			if (shouldEnhance(enabled, kind)) {
				return this.buildAudioPlayer(info, file, subpath);
			}

			// Not yet probed: host Obsidian's own embed in a shell that
			// upgrades to the enhanced player in place if the probe finds
			// audio. Video and unsupported files never leave the native
			// embed, and no probe verdict ever re-renders the note.
			if (enabled && kind === null && nativeCreator) {
				return new MediaEmbedShell(
					nativeCreator(info, file, subpath),
					this.probeKind(file),
					(probedKind) =>
						shouldEnhance(
							this.getSettings().enhancedPlayerEnabled,
							probedKind,
						),
					() => this.buildAudioPlayer(info, file, subpath),
				);
			}
			if (nativeCreator) {
				return nativeCreator(info, file, subpath);
			}
			// No captured native creator (does not happen for the registered
			// media extensions): fall back to the enhanced player so the embed
			// is never empty.
			return this.buildAudioPlayer(info, file, subpath);
		} catch (error) {
			console.error(
				`${PLUGIN_LOG_PREFIX} Failed to create the audio embed for ${file.path}; falling back to the native embed.`,
				error,
			);
			if (nativeCreator) {
				return nativeCreator(info, file, subpath);
			}
			throw error;
		}
	}

	/**
	 * The media kind already determined by a prior probe - this session's
	 * cache first, then the persisted store (validated by mtime/size) -
	 * or null when the file has not been probed yet. The extension is
	 * never trusted: a container (even one usually holding audio) can
	 * carry a video track, so audio-vs-video is always decided by probing
	 * the actual content.
	 * @param file - Media file
	 */
	private knownKind(file: TFile): MediaKind | null {
		const cached = this.mediaKindCache.get(file.path);
		if (cached) {
			return cached;
		}
		const stored = this.mediaKindStore?.get(file) ?? null;
		if (stored) {
			this.mediaKindCache.set(file.path, stored);
		}
		return stored;
	}

	/**
	 * The file's media kind: cached if known, otherwise probed. One probe
	 * runs per path at a time and every caller (each embed shell of the
	 * file, the saved-recording primer) shares its promise. Confident
	 * results are persisted so later sessions skip the probe entirely;
	 * a timeout fallback is kept for this session only.
	 * @param file - Media file to classify
	 */
	private probeKind(file: TFile): Promise<MediaKind> {
		const known = this.knownKind(file);
		if (known) {
			return Promise.resolve(known);
		}
		const inFlight = this.probes.get(file.path);
		if (inFlight) {
			return inFlight;
		}
		const probe = probeMediaKind(this.app.vault.getResourcePath(file))
			.then((result) => {
				this.mediaKindCache.set(file.path, result.kind);
				if (result.confident) {
					this.mediaKindStore?.set(file, result.kind);
				}
				return result.kind;
			})
			.finally(() => {
				this.probes.delete(file.path);
			});
		this.probes.set(file.path, probe);
		return probe;
	}

	/**
	 * Builds the enhanced player for an owned embed container.
	 * @param info - Embed context from Obsidian
	 * @param file - Audio file
	 * @param subpath - Embed subpath (timecode, if any)
	 */
	private buildAudioPlayer(
		info: EmbedInfo,
		file: TFile,
		subpath: string,
	): EmbedComponent {
		const startSeconds = parseTimecodeSubpath(subpath);
		const sourcePath =
			info.sourcePath ?? this.app.workspace.getActiveFile()?.path ?? '';
		return new AudioPlayer(
			info.containerEl,
			this.app,
			file,
			resolvePlayerSettings(this.getSettings()),
			this.registry,
			this.peakCache,
			this.decoder,
			this.markerStore,
			{ startSeconds, sourcePath, immediate: true },
		);
	}

	/**
	 * Requests a re-render of every open leaf (master toggle flip, which
	 * changes what every embed should be).
	 */
	private requestRerenderAll(): void {
		this.pendingRerenderAll = true;
		this.scheduleRerender();
	}

	/**
	 * Flushes the coalesced re-render request by rebuilding every open
	 * markdown leaf. Only the master toggle flip requests this: probe
	 * upgrades happen inside the embed's own shell and never re-render a
	 * note, which is what keeps a large note from lagging on the first
	 * probe of a short recording.
	 */
	private flushRerender(): void {
		if (!this.pendingRerenderAll) {
			return;
		}
		this.pendingRerenderAll = false;
		for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
			this.rerenderLeaf(leaf);
		}
	}

	/**
	 * Rebuilds a single markdown leaf. rebuildView fully recreates the view,
	 * which unloads the old embeds - stopping any media they were playing -
	 * and recreates them. This is the reliable path for Live Preview, where
	 * merely re-setting the editor data leaves stale embeds running. Reading
	 * view falls back to previewMode.rerender if rebuildView is unavailable.
	 * @param leaf - Workspace leaf to rebuild
	 */
	private rerenderLeaf(leaf: WorkspaceLeaf): void {
		const view = leaf.view;
		if (!(view instanceof MarkdownView)) {
			return;
		}
		try {
			const rebuildable = leaf as WorkspaceLeaf & {
				rebuildView?: () => void;
			};
			if (typeof rebuildable.rebuildView === 'function') {
				rebuildable.rebuildView();
				return;
			}
			if (view.getMode() === 'preview') {
				view.previewMode.rerender(true);
			}
		} catch (error) {
			// One view failing to re-render must not stop the rest
			console.error(
				`${PLUGIN_LOG_PREFIX} Failed to re-render a markdown view.`,
				error,
			);
		}
	}

	/**
	 * Replaces a single internal embed with an enhanced player when it
	 * resolves to an audio file and has not already been taken over. Only
	 * used on the post-processor fallback path (Reading view).
	 * @param embed - The `.internal-embed` element
	 * @param ctx - Post-processor context (source path, child tracking)
	 */
	private tryEnhanceEmbed(
		embed: HTMLElement,
		ctx: MarkdownPostProcessorContext,
	): void {
		if (embed.dataset[ENHANCED_FLAG] === 'true') {
			return;
		}
		const src = embed.getAttribute('src');
		if (!src) {
			return;
		}
		const { linkPath, startSeconds } = parseAudioLinkTarget(src);
		const file = this.app.metadataCache.getFirstLinkpathDest(
			linkPath,
			ctx.sourcePath,
		);
		if (!(file instanceof TFile) || !isAudioFile(file)) {
			return;
		}
		embed.dataset[ENHANCED_FLAG] = 'true';
		const player = new AudioPlayer(
			embed,
			this.app,
			file,
			resolvePlayerSettings(this.getSettings()),
			this.registry,
			this.peakCache,
			this.decoder,
			this.markerStore,
			{ startSeconds, sourcePath: ctx.sourcePath },
		);
		ctx.addChild(player);
	}

	/**
	 * Intercepts clicks on internal timecode links (`...#t=...`) that point to
	 * an audio file, playing that file from the offset instead of letting
	 * Obsidian open it. Works the same in Reading view and Live Preview: the
	 * former exposes a rendered `a.internal-link`, the latter renders the link
	 * through CodeMirror with no `data-href`, so its target is read from the
	 * editor source under the click.
	 * @param event - The captured click event
	 */
	private handleTimecodeClick(event: MouseEvent): void {
		// Timecode links are part of the fixed player feature set; they work
		// whenever the enhanced player is enabled.
		if (!this.getSettings().enhancedPlayerEnabled) {
			return;
		}
		const href = this.resolveTimecodeHref(event);
		if (!href || !href.includes('#t=')) {
			return;
		}
		const { linkPath, startSeconds } = parseAudioLinkTarget(href);
		if (startSeconds === null) {
			return;
		}
		// Resolve the link against the note that actually contains the clicked
		// timecode link, located from the DOM rather than the globally active
		// file, so a relative link stays correct when the note lives in a
		// pop-out window or a background split whose note is not the active one.
		// This mirrors the resolution the player context menu uses.
		const target = event.target as Node | null;
		const owningView = target
			? markdownViewContaining(this.app, target)
			: null;
		const sourcePath =
			owningView?.file?.path ??
			this.app.workspace.getActiveFile()?.path ??
			'';
		const file = this.app.metadataCache.getFirstLinkpathDest(
			linkPath,
			sourcePath,
		);
		if (!(file instanceof TFile) || !isAudioFile(file)) {
			return;
		}
		// isAudioFile trusts only the extension, but a container (.mp4/.webm)
		// can hold a video track. When a prior probe classified this file as
		// video it keeps Obsidian's own player, so never consume the click into
		// audio-only detached playback; let Obsidian open it with its video UI.
		if (this.knownKind(file) === MEDIA_KIND.video) {
			return;
		}
		// An on-screen embed for the file seeks in place; otherwise start a
		// detached playback from the timecode so clicking a transcript
		// timestamp always plays from that moment instead of opening the file.
		if (this.registry.seek(file.path, startSeconds)) {
			// An embed now owns this file's playback; drop any detached one so
			// only one surface controls the (shared) audio element.
			if (this.detachedPlayback?.path === file.path) {
				this.detachedPlayback.dispose();
			}
		} else {
			this.playFromTimecode(file, startSeconds);
		}
		event.preventDefault();
		event.stopPropagation();
	}

	/**
	 * Plays a file's shared audio from a timecode without an on-screen embed,
	 * surfaced through the status-bar controls. Reuses the current detached
	 * playback when it already targets this file (a second click just seeks),
	 * and replaces one that targets a different file.
	 * @param file - Audio file to play
	 * @param seconds - Offset in seconds to start playback from
	 */
	private playFromTimecode(file: TFile, seconds: number): void {
		// Reuse this timecode playback if it already targets the file
		if (this.detachedPlayback?.path === file.path) {
			this.detachedPlayback.seek(seconds);
			return;
		}
		// Reuse the file's existing shared element (an embed's) if one is still
		// alive, so a click that races the embed's registration never spawns a
		// second, out-of-sync element. Drop a detached playback of another file.
		if (
			this.registry.seekSharedAudio(playbackKey(file.path, null), seconds)
		) {
			this.detachedPlayback?.dispose();
			return;
		}
		// No element for the file exists: start a fresh detached playback
		this.detachedPlayback?.dispose();
		this.detachedPlayback = DetachedPlayback.start(
			this.registry,
			this.app,
			file,
			seconds,
			() => {
				this.detachedPlayback = null;
			},
			resolvePlayerSettings(this.getSettings()).skipSeconds,
		);
	}

	/**
	 * Resolves the link target under a click, in either view mode. Reading view
	 * (and the post-processor fallback) exposes a rendered `a.internal-link`
	 * with the target in an attribute; Live Preview renders the link through
	 * CodeMirror with no attribute, so its target is read from the editor
	 * source at the clicked position.
	 * @param event - The captured click event
	 * @returns The link target (with any `#t=` subpath), or null when none
	 */
	private resolveTimecodeHref(event: MouseEvent): string | null {
		const target = event.target as HTMLElement | null;
		if (!target) {
			return null;
		}
		const anchor = target.closest<HTMLElement>('a.internal-link');
		if (anchor) {
			return (
				anchor.getAttribute('data-href') ?? anchor.getAttribute('href')
			);
		}
		// Live Preview renders a wikilink as a .cm-hmd-internal-link token that
		// carries no data-href. Resolve from source ONLY when the click is on
		// that token; otherwise a click on a rendered embed's widget, another
		// decoration, or plain line text would also fall through here and,
		// because posAtDOM snaps to the token, hijack a nearby timecode link -
		// so a player button or ordinary text would seek instead of acting.
		const linkToken = target.closest<HTMLElement>('.cm-hmd-internal-link');
		if (!linkToken) {
			return null;
		}
		return this.resolveEditorLinkTarget(linkToken);
	}

	/**
	 * Reads the wikilink target at a clicked node from the editor of the note
	 * that actually contains the node, so a Live Preview timecode link clicked
	 * in a pop-out window or a background split reads from that note's editor
	 * rather than the globally active one, whose CodeMirror instance does not
	 * own this node. Uses CodeMirror's DOM-to-offset mapping (the same internal
	 * API the context menu uses) to find the line and column, then extracts the
	 * link there. Falls back to the active view for a detached render, and
	 * returns null when the click is not on a wikilink or the editor internals
	 * are unavailable.
	 * @param node - The clicked DOM node inside the editor
	 * @returns The wikilink target, or null when none is under the click
	 */
	private resolveEditorLinkTarget(node: Node): string | null {
		const view =
			markdownViewContaining(this.app, node) ??
			this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view) {
			return null;
		}
		const cm = (view.editor as EditorWithCodeMirror).cm;
		if (!cm?.posAtDOM) {
			return null;
		}
		try {
			const cursor = view.editor.offsetToPos(cm.posAtDOM(node));
			return wikiLinkTargetAtCursor(
				view.editor.getLine(cursor.line),
				cursor.ch,
			);
		} catch (error) {
			console.error(
				`${PLUGIN_LOG_PREFIX} Failed to resolve a timecode link in the editor.`,
				error,
			);
			return null;
		}
	}
}

/** CodeMirror view attached to an Obsidian Editor (internal API). */
interface EditorWithCodeMirror extends Editor {
	cm?: { posAtDOM?(node: Node): number };
}
