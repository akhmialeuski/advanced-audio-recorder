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
 * each file is probed once and cached per path. When a probe reveals an
 * audio-only file, the open views are re-rendered so the embed is rebuilt
 * as the enhanced player. Settings changes use the SAME re-render,
 * so any player setting applies immediately and identically in both modes -
 * Reading view via previewMode.rerender, Live Preview via the current
 * sub-view's set(get(), true). When the internal registry API is
 * unavailable, a Markdown post-processor takes over embeds (Reading view
 * only). A document-level click handler routes timecode links to a live
 * player. All paths respect the feature toggle.
 * @module player/EnhancedPlayerRegistrar
 */

import { TFile, MarkdownView, debounce, getLinkpath } from 'obsidian';
import type {
	App,
	MarkdownPostProcessorContext,
	Plugin,
	WorkspaceLeaf,
} from 'obsidian';
import { AUDIO_EXTENSIONS, PLUGIN_LOG_PREFIX } from '../constants';
import { type AudioRecorderSettings } from '../settings/Settings';
import {
	resolvePlayerSettings,
	playerSettingsEqual,
	type ResolvedPlayerSettings,
} from '../player/playerSettings';
import { AudioPlayerRegistry } from './AudioPlayerRegistry';
import { WaveformPeakCache, SharedAudioDecoder } from './WaveformData';
import { AudioPlayer } from './AudioPlayer';
import {
	parseAudioLinkTarget,
	isAudioFile,
	parseTimecodeSubpath,
} from './timecodeLinks';
import { probeMediaKind, type MediaKind } from './mediaProbe';
import { shouldEnhance } from './playerMode';
import type { MarkerStore } from '../markers/MarkerStore';
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
 * settings changes (e.g. dragging a slider) or simultaneous probe results
 * into a single re-render.
 */
const RERENDER_DEBOUNCE_MS = 50;

/**
 * Number of extra scoped re-render attempts for a freshly inserted embed
 * whose metadata cache entry may lag behind the editor update.
 */
const SCOPED_RERENDER_RETRY_LIMIT = 5;

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
	/** File paths with a probe in flight, to avoid concurrent probes. */
	private readonly probing = new Set<string>();
	/** Last seen feature-enabled state, so refresh re-renders only on a flip. */
	private lastEnabled = false;
	/** Last applied resolved layout, so an unchanged save re-applies nothing. */
	private lastResolved: ResolvedPlayerSettings | null = null;
	/** Paths pending a scoped re-render (probe upgrades of specific files). */
	private readonly pendingRerenderPaths = new Set<string>();
	/** Retry count per scoped path while metadata catches up. */
	private readonly pendingRerenderRetries = new Map<string, number>();
	/** Notes to rebuild directly once a saved recording probes as audio. */
	private readonly pendingDirectRerenderNotePaths = new Map<
		string,
		Set<string>
	>();
	/** Notes that should receive a direct rebuild after the current probe. */
	private readonly pendingProbeNotePaths = new Map<string, Set<string>>();
	/** Whether every leaf must re-render (master toggle flip). */
	private pendingRerenderAll = false;
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
	 */
	constructor(
		private readonly plugin: Plugin,
		private readonly app: App,
		private readonly getSettings: () => AudioRecorderSettings,
		private readonly markerStore: MarkerStore,
	) {}

	/**
	 * Registers the embed creator, the markdown post-processor fallback, the
	 * timecode-link click handler, and the marker sidecar move/delete
	 * handlers. Safe to call once during plugin load.
	 */
	register(): void {
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

		this.plugin.registerDomEvent(
			activeDocument,
			'click',
			(event) => {
				this.handleTimecodeClick(event);
			},
			{ capture: true },
		);

		// Keep each recording's marker sidecar attached to the file: move
		// it on rename/move and remove it on delete
		this.plugin.registerEvent(
			this.app.vault.on('rename', (file, oldPath) => {
				if (file instanceof TFile && isAudioFile(file)) {
					void this.markerStore.handleRename(oldPath, file.path);
				}
			}),
		);
		this.plugin.registerEvent(
			this.app.vault.on('delete', (file) => {
				if (file instanceof TFile && isAudioFile(file)) {
					void this.markerStore.handleDelete(file.path);
				}
			}),
		);
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
		this.registry.clear();
		this.peakCache.clear();
		this.mediaKindCache.clear();
		this.probing.clear();
		this.pendingRerenderPaths.clear();
		this.pendingRerenderRetries.clear();
		this.pendingDirectRerenderNotePaths.clear();
		this.pendingProbeNotePaths.clear();
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
	 * Primes freshly saved recordings for enhancement after the recording
	 * pipeline inserts their embeds into a note. This avoids depending on
	 * Obsidian first creating a native embed and starting the lazy probe: once
	 * the file is proven audio-only, the note that received the embed is
	 * rebuilt directly.
	 * @param audioPaths - Vault paths written by the recording finalizer
	 * @param notePath - Note that received the embed links, if any
	 */
	primeSavedRecordingsForEnhancement(
		audioPaths: string[],
		notePath: string | null,
	): void {
		if (!this.getSettings().enhancedPlayerEnabled || !notePath) {
			return;
		}
		for (const audioPath of audioPaths) {
			const file = this.app.vault.getAbstractFileByPath(audioPath);
			if (!(file instanceof TFile) || !isAudioFile(file)) {
				continue;
			}
			void this.probeAndUpgrade(file, notePath);
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
	 * file renders native now and is probed; if it is audio-only, a re-render
	 * upgrades it.
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

			// Not (yet) known to be audio: render Obsidian's own embed. If the
			// file has not been probed yet, probe its content in the background
			// and re-render to upgrade it if it turns out audio-only.
			if (enabled && kind === null && nativeCreator) {
				void this.probeAndUpgrade(file);
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
	 * The media kind already determined by a prior probe, or null when the
	 * file has not been probed yet. The extension is never trusted: a
	 * container (even one usually holding audio) can carry a video track, so
	 * audio-vs-video is always decided by probing the actual content.
	 * @param file - Media file
	 */
	private knownKind(file: TFile): MediaKind | null {
		return this.mediaKindCache.get(file.path) ?? null;
	}

	/**
	 * Probes a media file's content once and, if it is audio-only, re-renders
	 * open views so the embed is rebuilt as the enhanced player.
	 * @param file - Media file to probe
	 */
	private async probeAndUpgrade(
		file: TFile,
		notePath?: string,
	): Promise<void> {
		if (notePath) {
			this.addPendingProbeNotePath(file.path, notePath);
		}
		const knownKind = this.mediaKindCache.get(file.path);
		if (knownKind) {
			if (
				shouldEnhance(
					this.getSettings().enhancedPlayerEnabled,
					knownKind,
				)
			) {
				this.requestRerenderForFile(file.path, notePath);
			}
			return;
		}
		if (this.probing.has(file.path)) {
			return;
		}
		this.probing.add(file.path);
		try {
			const kind = await probeMediaKind(
				this.app.vault.getResourcePath(file),
			);
			this.mediaKindCache.set(file.path, kind);
			if (shouldEnhance(this.getSettings().enhancedPlayerEnabled, kind)) {
				const notePaths = this.pendingProbeNotePaths.get(file.path);
				if (notePaths && notePaths.size > 0) {
					for (const pendingNotePath of notePaths) {
						this.requestRerenderForFile(file.path, pendingNotePath);
					}
				} else {
					// Only the notes that actually embed this file need rebuilding,
					// so a large note that does not embed it is never re-rendered
					this.requestRerenderForFile(file.path);
				}
			}
		} finally {
			this.pendingProbeNotePaths.delete(file.path);
			this.probing.delete(file.path);
		}
	}

	/**
	 * Remembers that a saved recording should rebuild a known note after its
	 * media probe completes.
	 * @param path - Vault path of the recording
	 * @param notePath - Note that received the embed link
	 */
	private addPendingProbeNotePath(path: string, notePath: string): void {
		const notePaths = this.pendingProbeNotePaths.get(path) ?? new Set();
		notePaths.add(notePath);
		this.pendingProbeNotePaths.set(path, notePaths);
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
	 * Requests a re-render of only the leaves that embed the given file, so a
	 * probe upgrade never re-renders unrelated (possibly large) notes.
	 * @param path - Vault path of the upgraded file
	 */
	private requestRerenderForFile(path: string, notePath?: string): void {
		this.pendingRerenderPaths.add(path);
		if (notePath) {
			const notePaths =
				this.pendingDirectRerenderNotePaths.get(path) ?? new Set();
			notePaths.add(notePath);
			this.pendingDirectRerenderNotePaths.set(path, notePaths);
		}
		if (!this.pendingRerenderRetries.has(path)) {
			this.pendingRerenderRetries.set(path, 0);
		}
		this.scheduleRerender();
	}

	/**
	 * Flushes the coalesced re-render requests: rebuilds every leaf on a full
	 * request, otherwise only the leaves whose note embeds a pending file.
	 */
	private flushRerender(): void {
		const all = this.pendingRerenderAll;
		const paths = new Set(this.pendingRerenderPaths);
		this.pendingRerenderAll = false;
		this.pendingRerenderPaths.clear();
		if (!all && paths.size === 0) {
			return;
		}
		const leaves = this.app.workspace.getLeavesOfType('markdown');
		if (all) {
			for (const leaf of leaves) {
				this.rerenderLeaf(leaf);
			}
			for (const path of paths) {
				this.pendingRerenderRetries.delete(path);
				this.pendingDirectRerenderNotePaths.delete(path);
			}
			return;
		}
		const unmatchedPaths = new Set(paths);
		const matchedRerenderPaths = new Set<string>();
		for (const leaf of leaves) {
			const matchedPaths = new Set([
				...this.leafDirectRerenderPaths(leaf, paths),
				...this.leafEmbeddedPaths(leaf, paths),
			]);
			if (matchedPaths.size > 0) {
				this.rerenderLeaf(leaf);
				for (const path of matchedPaths) {
					unmatchedPaths.delete(path);
					matchedRerenderPaths.add(path);
				}
			}
		}
		for (const path of matchedRerenderPaths) {
			this.pendingRerenderRetries.delete(path);
			this.pendingDirectRerenderNotePaths.delete(path);
		}
		this.rescheduleUnmatchedRerenders(unmatchedPaths);
	}

	/**
	 * Returns probed file paths that should rebuild this exact note because
	 * the recording pipeline just inserted their embeds there.
	 * @param leaf - Workspace leaf to test
	 * @param paths - Candidate embedded file paths
	 */
	private leafDirectRerenderPaths(
		leaf: WorkspaceLeaf,
		paths: Set<string>,
	): Set<string> {
		const matchedPaths = new Set<string>();
		const view = leaf.view;
		if (!(view instanceof MarkdownView) || !view.file) {
			return matchedPaths;
		}
		for (const path of paths) {
			const notePaths = this.pendingDirectRerenderNotePaths.get(path);
			if (notePaths?.has(view.file.path)) {
				matchedPaths.add(path);
			}
		}
		return matchedPaths;
	}

	/**
	 * Returns the given file paths embedded by a leaf's note, resolved through
	 * the metadata cache. A note with no matching embed is left untouched.
	 * @param leaf - Workspace leaf to test
	 * @param paths - Candidate embedded file paths
	 */
	private leafEmbeddedPaths(
		leaf: WorkspaceLeaf,
		paths: Set<string>,
	): Set<string> {
		const matchedPaths = new Set<string>();
		const view = leaf.view;
		if (!(view instanceof MarkdownView) || !view.file) {
			return matchedPaths;
		}
		const embeds = this.app.metadataCache.getFileCache(view.file)?.embeds;
		if (!embeds) {
			return matchedPaths;
		}
		for (const embed of embeds) {
			const dest = this.app.metadataCache.getFirstLinkpathDest(
				getLinkpath(embed.link),
				view.file.path,
			);
			if (dest && paths.has(dest.path)) {
				matchedPaths.add(dest.path);
			}
		}
		return matchedPaths;
	}

	/**
	 * Keeps a scoped upgrade alive briefly when the media probe finished before
	 * Obsidian indexed the newly inserted embed in metadataCache.
	 * @param unmatchedPaths - Probed audio paths not found in open note caches
	 */
	private rescheduleUnmatchedRerenders(unmatchedPaths: Set<string>): void {
		for (const path of unmatchedPaths) {
			const retryCount = this.pendingRerenderRetries.get(path) ?? 0;
			if (retryCount >= SCOPED_RERENDER_RETRY_LIMIT) {
				this.pendingRerenderRetries.delete(path);
				this.pendingDirectRerenderNotePaths.delete(path);
				continue;
			}
			this.pendingRerenderRetries.set(path, retryCount + 1);
			this.pendingRerenderPaths.add(path);
		}
		if (this.pendingRerenderPaths.size > 0) {
			this.scheduleRerender();
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
	 * Intercepts clicks on internal timecode links (`...#t=...`) that
	 * point to an audio file with a live player, seeking that player
	 * instead of letting Obsidian open the file.
	 * @param event - The captured click event
	 */
	private handleTimecodeClick(event: MouseEvent): void {
		// Timecode links are part of the fixed player feature set; they work
		// whenever the enhanced player is enabled.
		if (!this.getSettings().enhancedPlayerEnabled) {
			return;
		}
		const target = event.target as HTMLElement | null;
		const anchor = target?.closest<HTMLElement>('a.internal-link');
		if (!anchor) {
			return;
		}
		const href =
			anchor.getAttribute('data-href') ?? anchor.getAttribute('href');
		if (!href || !href.includes('#t=')) {
			return;
		}
		const { linkPath, startSeconds } = parseAudioLinkTarget(href);
		if (startSeconds === null) {
			return;
		}
		const sourcePath = this.app.workspace.getActiveFile()?.path ?? '';
		const file = this.app.metadataCache.getFirstLinkpathDest(
			linkPath,
			sourcePath,
		);
		if (!(file instanceof TFile) || !isAudioFile(file)) {
			return;
		}
		if (this.registry.seek(file.path, startSeconds)) {
			event.preventDefault();
			event.stopPropagation();
		}
	}
}
