/**
 * The single controller Obsidian creates (via the embed registry) for
 * every media embed of the plugin's extensions. It owns one decision:
 * what to mount into the embed container.
 *
 *   - feature off, or video, or unsupported -> Obsidian's built-in embed
 *     (the captured default creator), with loadFile forwarded so the
 *     native player actually loads its media (this is required: Obsidian
 *     calls loadFile on THIS component, not on the nested native one)
 *   - feature on and audio-only            -> the enhanced AudioPlayer
 *
 * The media kind is probed once and cached. `refresh()` re-runs the
 * decision in place (no Obsidian re-render), so a settings change — most
 * importantly toggling the player on/off — applies immediately.
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
import { probeMediaKind, type MediaKind } from './mediaProbe';
import { shouldEnhance } from './playerMode';
import type {
	EmbedComponent,
	EmbedCreator,
	EmbedInfo,
} from '../obsidian/embedRegistry';

/**
 * Shared dependencies the controller needs. Owned by the registrar.
 */
export interface EnhancedMediaEmbedDeps {
	app: App;
	getSettings: () => AudioRecorderSettings;
	registry: AudioPlayerRegistry;
	peakCache: WaveformPeakCache;
	decoder: AudioDecoder;
	markerStore: MarkerStore;
	/**
	 * Obsidian's default creator for this extension, used for the built-in
	 * embed (feature off / video / unsupported). Undefined when none was
	 * captured.
	 */
	fallbackCreator: EmbedCreator | undefined;
}

/** A mounted child that may expose Obsidian's loadFile hook. */
type MountedChild = Component & { loadFile?(file: TFile): unknown };

/**
 * Decides and mounts the right player for one embedded media file.
 */
export class EnhancedMediaEmbed extends Component implements EmbedComponent {
	private readonly containerEl: HTMLElement;
	private current: MountedChild | null = null;
	private kind: MediaKind | null = null;
	private unloaded = false;
	private deciding = false;

	/**
	 * @param info - Embed context from Obsidian (container, source path)
	 * @param file - Media file to embed
	 * @param subpath - Embed subpath (carries a `#t=` timecode, if any)
	 * @param deps - Shared dependencies
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

	onload(): void {
		void this.decide();
	}

	/**
	 * Obsidian calls this to (re)load the file. Forward it to the mounted
	 * child — crucial for the built-in embed, which only loads its media
	 * when loadFile is called on it.
	 */
	loadFile(): void {
		if (this.current?.loadFile) {
			void this.current.loadFile(this.file);
			return;
		}
		void this.decide();
	}

	onunload(): void {
		this.unloaded = true;
		super.onunload();
	}

	/**
	 * Re-runs the mount decision in place after a settings change, so
	 * enabling/disabling the player (or changing player settings) takes
	 * effect without re-opening the note.
	 */
	refresh(): void {
		if (!this.unloaded) {
			void this.decide(true);
		}
	}

	/**
	 * Probes the file once (cached) and mounts the enhanced player or the
	 * built-in embed per the current settings.
	 * @param force - Re-mount even if something is already mounted
	 */
	private async decide(force = false): Promise<void> {
		if (this.deciding || (this.current && !force)) {
			return;
		}
		this.deciding = true;
		try {
			const enabled = this.deps.getSettings().enhancedPlayerEnabled;
			if (enabled && this.kind === null) {
				const kind = await probeMediaKind(
					this.deps.app.vault.getResourcePath(this.file),
				);
				if (this.unloaded) {
					return;
				}
				this.kind = kind;
			}
			this.mount(shouldEnhance(enabled, this.kind ?? 'unsupported'));
		} finally {
			this.deciding = false;
		}
	}

	/**
	 * Mounts the enhanced player or the built-in embed, replacing whatever
	 * is currently mounted.
	 * @param enhanced - Whether to mount the enhanced player
	 */
	private mount(enhanced: boolean): void {
		if (this.current) {
			this.removeChild(this.current);
			this.current = null;
		}
		this.containerEl.empty();

		const creator = this.deps.fallbackCreator;
		if (!enhanced && creator) {
			const native = creator(this.info, this.file, this.subpath);
			this.current = native;
			this.addChild(native);
			// Obsidian would call loadFile on us, not the nested native
			// embed, so the native one never loads its media unless we do
			if (typeof native.loadFile === 'function') {
				void native.loadFile(this.file);
			}
			return;
		}

		const startSeconds = parseTimecodeSubpath(this.subpath);
		const sourcePath =
			this.info.sourcePath ??
			this.deps.app.workspace.getActiveFile()?.path ??
			'';
		const player = new AudioPlayer(
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
		this.current = player;
		this.addChild(player);
	}
}
