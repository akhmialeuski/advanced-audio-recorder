/**
 * Wires the enhanced audio player into Obsidian. The primary path
 * registers a custom embed creator in Obsidian's embed registry, so
 * Obsidian itself builds the player for the plugin's media extensions in
 * both Reading view and Live Preview — no DOM race, no default player to
 * suppress. When the (internal) registry API is unavailable, it falls
 * back to a markdown post-processor that takes over `.internal-embed`
 * elements (Reading view only). A document-level click handler routes
 * timecode links to a live player. All paths respect the feature toggle.
 * @module player/EnhancedPlayerRegistrar
 */

import { TFile } from 'obsidian';
import type { App, MarkdownPostProcessorContext, Plugin } from 'obsidian';
import { AUDIO_EXTENSIONS, PLUGIN_LOG_PREFIX } from '../constants';
import {
	resolvePlayerSettings,
	type AudioRecorderSettings,
} from '../settings/Settings';
import { AudioPlayerRegistry } from './AudioPlayerRegistry';
import { WaveformPeakCache, SharedAudioDecoder } from './WaveformData';
import { AudioPlayer } from './AudioPlayer';
import {
	EnhancedMediaEmbed,
	type EnhancedMediaEmbedDeps,
} from './EnhancedMediaEmbed';
import { parseAudioLinkTarget, isAudioFile } from './timecodeLinks';
import type { MarkerStore } from './markers/MarkerStore';
import {
	getEmbedRegistry,
	EmbedRegistryOverride,
	type EmbedComponent,
	type EmbedCreator,
	type EmbedInfo,
} from '../obsidian/embedRegistry';

/** Dataset flag marking an embed already taken over by the player. */
const ENHANCED_FLAG = 'aarEnhanced';

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
	 * Registers the markdown post processor and the timecode-link click
	 * handler. Safe to call once during plugin load.
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
		this.registry.clear();
		this.peakCache.clear();
		this.markerStore.clearCache();
		void this.decoder.close().catch(() => {
			// Closing a context that never opened or already failed is
			// non-fatal during teardown
		});
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
	 * Embed creator installed in the registry. Builds the enhanced player
	 * when the feature is enabled, otherwise delegates to Obsidian's
	 * captured default creator so toggling the setting takes effect on the
	 * next render without re-registering.
	 * @param info - Embed context from Obsidian
	 * @param file - Media file to embed
	 * @param subpath - Embed subpath (timecode, if any)
	 */
	private createEmbed(
		info: EmbedInfo,
		file: TFile,
		subpath: string,
	): EmbedComponent {
		const previous = this.embedOverride?.getPrevious(file.extension);
		// Feature off: hand straight back to Obsidian's default
		if (!this.getSettings().enhancedPlayerEnabled && previous) {
			return previous(info, file, subpath);
		}
		// Feature on: the embed probes the file and mounts the enhanced
		// player only for audio-only files, else the built-in embed (video
		// / unsupported) via the captured default creator
		return new EnhancedMediaEmbed(
			info,
			file,
			subpath,
			this.embedDeps(previous),
		);
	}

	/**
	 * Bundles the shared dependencies an embed needs, including the default
	 * creator to fall back to for video and unsupported files.
	 * @param fallbackCreator - Obsidian's captured default creator
	 */
	private embedDeps(
		fallbackCreator: EmbedCreator | undefined,
	): EnhancedMediaEmbedDeps {
		return {
			app: this.app,
			getSettings: this.getSettings,
			registry: this.registry,
			peakCache: this.peakCache,
			decoder: this.decoder,
			markerStore: this.markerStore,
			fallbackCreator,
		};
	}

	/**
	 * Replaces a single internal embed with an enhanced player when it
	 * resolves to an audio file and has not already been taken over.
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
