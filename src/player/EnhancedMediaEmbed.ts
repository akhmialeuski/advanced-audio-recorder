/**
 * Embed component that Obsidian creates (via the embed registry) in place
 * of its default audio/video embed for the plugin's media extensions. It
 * mounts the existing AudioPlayer into the embed's container, so the same
 * player drives both Reading view and Live Preview without a Markdown
 * post-processor or DOM races. Obsidian owns this component's lifecycle
 * through its render tree; the player is added as a child so it is torn
 * down with the embed.
 * @module player/EnhancedMediaEmbed
 */

import { Component } from 'obsidian';
import type { App, TFile } from 'obsidian';
import { AudioPlayer } from './AudioPlayer';
import type { AudioPlayerRegistry } from './AudioPlayerRegistry';
import type { WaveformPeakCache, AudioDecoder } from './WaveformData';
import type { MarkerStore } from './markers/MarkerStore';
import {
	resolvePlayerSettings,
	type AudioRecorderSettings,
} from '../settings/Settings';
import { parseTimecodeSubpath } from './timecodeLinks';
import type { EmbedComponent, EmbedInfo } from '../obsidian/embedRegistry';

/**
 * Shared dependencies the embed needs to build a player. Owned by the
 * registrar and passed through unchanged.
 */
export interface EnhancedMediaEmbedDeps {
	app: App;
	getSettings: () => AudioRecorderSettings;
	registry: AudioPlayerRegistry;
	peakCache: WaveformPeakCache;
	decoder: AudioDecoder;
	markerStore: MarkerStore;
}

/**
 * Mounts the enhanced player for one embedded media file.
 */
export class EnhancedMediaEmbed extends Component implements EmbedComponent {
	private readonly containerEl: HTMLElement;
	private player: AudioPlayer | null = null;

	/**
	 * @param info - Embed context from Obsidian (container, source path)
	 * @param file - Media file to play
	 * @param subpath - Embed subpath (carries a `#t=` timecode, if any)
	 * @param deps - Shared player dependencies
	 */
	constructor(
		private readonly info: EmbedInfo,
		private readonly file: TFile,
		private readonly subpath: string,
		private readonly deps: EnhancedMediaEmbedDeps,
	) {
		super();
		this.containerEl = info.containerEl;
	}

	/**
	 * Builds the player when Obsidian loads the embed.
	 */
	onload(): void {
		this.build();
	}

	/**
	 * Obsidian may call this instead of (or alongside) onload; building is
	 * idempotent so either entry point renders the player exactly once.
	 */
	loadFile(): void {
		this.build();
	}

	/**
	 * Creates the player once and adds it as a child so its lifecycle is
	 * tied to this embed.
	 */
	private build(): void {
		if (this.player) {
			return;
		}
		const startSeconds = parseTimecodeSubpath(this.subpath);
		const sourcePath =
			this.info.sourcePath ??
			this.deps.app.workspace.getActiveFile()?.path ??
			'';
		this.player = new AudioPlayer(
			this.containerEl,
			this.deps.app,
			this.file,
			resolvePlayerSettings(this.deps.getSettings()),
			this.deps.registry,
			this.deps.peakCache,
			this.deps.decoder,
			this.deps.markerStore,
			{ startSeconds, sourcePath, immediate: true },
		);
		this.addChild(this.player);
	}
}
