/**
 * Embed component that Obsidian creates (via the embed registry) in place
 * of its default audio/video embed for the plugin's media extensions. It
 * first probes the file: only audio-only files get the enhanced player;
 * files that carry video, or that cannot be played, are handed back to
 * Obsidian's built-in embed (the captured default creator) so video is
 * watchable and unsupported formats degrade gracefully. The enhanced
 * player drives both Reading view and Live Preview without a Markdown
 * post-processor or DOM races; whatever is mounted is added as a child so
 * it is torn down with the embed.
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
import { probeMediaKind } from './mediaProbe';
import type {
	EmbedComponent,
	EmbedCreator,
	EmbedInfo,
} from '../obsidian/embedRegistry';

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
	/**
	 * Obsidian's default creator for this extension, used for video and
	 * unsupported files. Undefined when none was captured.
	 */
	fallbackCreator: EmbedCreator | undefined;
}

/**
 * Probes a media embed and mounts either the enhanced player (audio) or
 * Obsidian's built-in embed (video / unsupported).
 */
export class EnhancedMediaEmbed extends Component implements EmbedComponent {
	private readonly containerEl: HTMLElement;
	private mounted = false;
	private unloaded = false;

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
	 * Probes the file and mounts the right player when Obsidian loads the
	 * embed.
	 */
	onload(): void {
		void this.decide();
	}

	/**
	 * Obsidian may call this instead of (or alongside) onload; deciding is
	 * idempotent so either entry point mounts exactly once.
	 */
	loadFile(): void {
		void this.decide();
	}

	onunload(): void {
		this.unloaded = true;
		super.onunload();
	}

	/**
	 * Probes the container and mounts the enhanced player for audio-only
	 * files, or the built-in embed for video / unsupported files.
	 */
	private async decide(): Promise<void> {
		if (this.mounted) {
			return;
		}
		const resource = this.deps.app.vault.getResourcePath(this.file);
		const kind = await probeMediaKind(resource);
		if (this.unloaded || this.mounted) {
			return;
		}
		if (kind === 'audio') {
			this.mountEnhanced();
		} else {
			this.mountBuiltIn();
		}
	}

	/**
	 * Mounts the enhanced audio player into the embed container.
	 */
	private mountEnhanced(): void {
		this.mounted = true;
		const startSeconds = parseTimecodeSubpath(this.subpath);
		const sourcePath =
			this.info.sourcePath ??
			this.deps.app.workspace.getActiveFile()?.path ??
			'';
		this.addChild(
			new AudioPlayer(
				this.containerEl,
				this.deps.app,
				this.file,
				resolvePlayerSettings(this.deps.getSettings()),
				this.deps.registry,
				this.deps.peakCache,
				this.deps.decoder,
				this.deps.markerStore,
				{ startSeconds, sourcePath, immediate: true },
			),
		);
	}

	/**
	 * Mounts Obsidian's built-in embed (video / unsupported) via the
	 * captured default creator. Falls back to the enhanced player only if
	 * no default creator is available, so the embed is never left blank.
	 */
	private mountBuiltIn(): void {
		this.mounted = true;
		const creator = this.deps.fallbackCreator;
		if (creator) {
			this.addChild(creator(this.info, this.file, this.subpath));
			return;
		}
		this.mounted = false;
		this.mountEnhanced();
	}
}
