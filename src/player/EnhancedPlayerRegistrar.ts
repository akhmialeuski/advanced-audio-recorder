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
 * so any player setting applies immediately and identically in both modes —
 * Reading view via previewMode.rerender, Live Preview via the current
 * sub-view's set(get(), true). When the internal registry API is
 * unavailable, a Markdown post-processor takes over embeds (Reading view
 * only). A document-level click handler routes timecode links to a live
 * player. All paths respect the feature toggle.
 * @module player/EnhancedPlayerRegistrar
 */

import { TFile, MarkdownView, debounce } from 'obsidian';
import type {
	App,
	MarkdownPostProcessorContext,
	Plugin,
	WorkspaceLeaf,
} from 'obsidian';
import { AUDIO_EXTENSIONS, PLUGIN_LOG_PREFIX } from '../constants';
import {
	resolvePlayerSettings,
	type AudioRecorderSettings,
} from '../settings/Settings';
import { AudioPlayerRegistry } from './AudioPlayerRegistry';
import { WaveformPeakCache, SharedAudioDecoder } from './WaveformData';
import { AudioPlayer } from './AudioPlayer';
import {
	parseAudioLinkTarget,
	isAudioFile,
	parseTimecodeSubpath,
} from './timecodeLinks';
import { probeMediaKind, type MediaKind } from './mediaProbe';
import type { MarkerStore } from './markers/MarkerStore';
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
	/** Debounced re-render of open markdown views (settings + probe upgrades). */
	private readonly scheduleRerender = debounce(
		() => this.rerenderMarkdownViews(),
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
		this.markerStore.clearCache();
		void this.decoder.close().catch(() => {
			// Closing a context that never opened or already failed is
			// non-fatal during teardown
		});
	}

	/**
	 * Re-evaluates every open view so settings changes (e.g. the player
	 * toggle or any player setting) apply immediately, identically in
	 * Reading view and Live Preview, without re-opening the note.
	 */
	refresh(): void {
		this.scheduleRerender();
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
		const enabled = this.getSettings().enhancedPlayerEnabled;
		const nativeCreator = this.embedOverride?.getPrevious(file.extension);
		const kind = this.knownKind(file);

		if (enabled && kind === 'audio') {
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
	private async probeAndUpgrade(file: TFile): Promise<void> {
		if (this.mediaKindCache.has(file.path) || this.probing.has(file.path)) {
			return;
		}
		this.probing.add(file.path);
		try {
			const kind = await probeMediaKind(
				this.app.vault.getResourcePath(file),
			);
			this.mediaKindCache.set(file.path, kind);
			if (kind === 'audio' && this.getSettings().enhancedPlayerEnabled) {
				this.scheduleRerender();
			}
		} finally {
			this.probing.delete(file.path);
		}
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
	 * Re-renders every open markdown view through Obsidian's own pipeline,
	 * which recreates embeds with the current settings. Reading view uses
	 * previewMode.rerender; Live Preview re-sets the active sub-view's data
	 * (preserving scroll). Using Obsidian's render path means the player
	 * behaves identically in both modes — no in-place DOM surgery.
	 */
	private rerenderMarkdownViews(): void {
		const leaves = this.app.workspace.getLeavesOfType('markdown');
		for (const leaf of leaves) {
			this.rerenderLeaf(leaf);
		}
	}

	/**
	 * Re-renders a single markdown leaf in whichever mode it is showing.
	 * @param leaf - Workspace leaf to re-render
	 */
	private rerenderLeaf(leaf: WorkspaceLeaf): void {
		const view = leaf.view;
		if (!(view instanceof MarkdownView)) {
			return;
		}
		try {
			if (view.getMode() === 'preview') {
				view.previewMode.rerender(true);
				return;
			}
			// Live Preview / source: re-set the active sub-view's data to
			// rebuild its rendered widgets, restoring the scroll position
			const mode = view.currentMode;
			const scroll = mode.getScroll();
			mode.set(mode.get(), true);
			mode.applyScroll(scroll);
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
		const settings = this.getSettings();
		if (
			!settings.enhancedPlayerEnabled ||
			!settings.playerEnableTimestampLinks
		) {
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
