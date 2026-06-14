/**
 * Wires the enhanced audio player into Obsidian: a markdown post
 * processor that replaces internal audio embeds with the custom player,
 * and a document-level click handler that routes timecode links to a
 * live player. Both paths are gated on the feature toggle so disabling
 * the player makes Obsidian fall back to its built-in embed on the next
 * render.
 * @module player/EnhancedPlayerRegistrar
 */

import { TFile } from 'obsidian';
import type { App, MarkdownPostProcessorContext, Plugin } from 'obsidian';
import {
	resolvePlayerSettings,
	type AudioRecorderSettings,
} from '../settings/Settings';
import { AudioPlayerRegistry } from './AudioPlayerRegistry';
import { WaveformPeakCache } from './WaveformData';
import { AudioPlayer } from './AudioPlayer';
import { parseAudioLinkTarget, isAudioFile } from './timecodeLinks';
import type { MarkerStore } from './markers/MarkerStore';

/** Dataset flag marking an embed already taken over by the player. */
const ENHANCED_FLAG = 'aarEnhanced';

/**
 * Registers and owns the enhanced player integration.
 */
export class EnhancedPlayerRegistrar {
	private readonly registry = new AudioPlayerRegistry();
	private readonly peakCache = new WaveformPeakCache();

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
		this.plugin.registerMarkdownPostProcessor((el, ctx) => {
			if (!this.getSettings().enhancedPlayerEnabled) {
				return;
			}
			const embeds = Array.from(
				el.querySelectorAll<HTMLElement>('span.internal-embed'),
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
	}

	/**
	 * Releases retained players and cached peaks. Called on unload so
	 * nothing outlives the plugin.
	 */
	dispose(): void {
		this.registry.clear();
		this.peakCache.clear();
		this.markerStore.clearCache();
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
