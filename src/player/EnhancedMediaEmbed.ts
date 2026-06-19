/**
 * The single controller Obsidian creates (via the embed registry) for
 * every media embed of the plugin's extensions. It owns one decision:
 * what to mount into the embed container — and it mounts native-first.
 *
 * Native-first is the rule that keeps both view modes working:
 *
 *   - On load it mounts Obsidian's built-in embed SYNCHRONOUSLY (the
 *     captured default creator), so the container is never empty. This is
 *     the final state for video and unsupported files, and a placeholder
 *     for audio. Mounting synchronously matters in Live Preview, where
 *     CodeMirror measures the embed's height at creation: an empty
 *     container collapses to a zero-height box (the "empty bar" bug), and a
 *     late async mount lands inside it.
 *   - It then probes the media kind once (only when the feature is on and
 *     the kind is still unknown) and, ONLY if the file is confirmed
 *     audio-only, REPLACES the native embed with the enhanced AudioPlayer.
 *
 * So the only DOM surgery the plugin performs is for files it actually
 * enhances (audio); video/unsupported files are mounted natively and never
 * touched again. The probed kind is cached per file path (shared across
 * embeds), so re-renders decide synchronously — no flash, no re-probe.
 * `refresh()` re-evaluates in place after a settings change (most
 * importantly toggling the player on/off), applying it immediately.
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
	 * Probed media kind per file path, shared across embeds so a file is
	 * probed once and every later render decides synchronously.
	 */
	mediaKindCache: Map<string, MediaKind>;
	/**
	 * Obsidian's default creator for this extension, used for the built-in
	 * embed (feature off / video / unsupported / not-yet-probed). Undefined
	 * when none was captured.
	 */
	fallbackCreator: EmbedCreator | undefined;
}

/** A mounted child that may expose Obsidian's loadFile hook. */
type MountedChild = Component & { loadFile?(file: TFile): unknown };

/** What is currently mounted into the container. */
type MountKind = 'native' | 'enhanced';

/**
 * Decides and mounts the right player for one embedded media file.
 */
export class EnhancedMediaEmbed extends Component implements EmbedComponent {
	private readonly containerEl: HTMLElement;
	private child: MountedChild | null = null;
	private mounted: MountKind | null = null;
	private probeStarted = false;
	private unloaded = false;

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
		// Mount synchronously (native unless a cached kind says otherwise),
		// then probe in the background — never leave the container empty
		this.evaluate();
		void this.probeIfNeeded();
	}

	/**
	 * Obsidian calls this to (re)load the file. Ensure something is mounted,
	 * then forward to the native child — the built-in embed only loads its
	 * media when loadFile is called on it, and Obsidian calls it on THIS
	 * component, not on the nested native one.
	 */
	loadFile(): void {
		this.evaluate();
		if (this.mounted === 'native' && this.child?.loadFile) {
			void this.child.loadFile(this.file);
		}
		void this.probeIfNeeded();
	}

	onunload(): void {
		this.unloaded = true;
		super.onunload();
	}

	/**
	 * Re-evaluates the mount in place after a settings change, so toggling
	 * the player (or any player setting) takes effect without re-opening the
	 * note.
	 */
	refresh(): void {
		if (this.unloaded) {
			return;
		}
		this.evaluate();
		void this.probeIfNeeded();
	}

	/**
	 * The mount the current knowledge calls for. An unknown kind resolves to
	 * native: the safe default that is never empty and matches what Obsidian
	 * would show anyway.
	 */
	private desiredMount(): MountKind {
		const enabled = this.deps.getSettings().enhancedPlayerEnabled;
		const kind = this.deps.mediaKindCache.get(this.file.path);
		return shouldEnhance(enabled, kind ?? 'unsupported')
			? 'enhanced'
			: 'native';
	}

	/** Mounts the desired target if it differs from what is mounted. */
	private evaluate(): void {
		this.mount(this.desiredMount());
	}

	/**
	 * Probes the media kind once, but only when it could change the mount:
	 * the feature must be on (a disabled player is always native) and the
	 * kind still unknown (a cached kind is final). Upgrades to the enhanced
	 * player if the file turns out audio-only.
	 */
	private async probeIfNeeded(): Promise<void> {
		if (this.probeStarted || this.unloaded) {
			return;
		}
		if (!this.deps.getSettings().enhancedPlayerEnabled) {
			return;
		}
		if (this.deps.mediaKindCache.has(this.file.path)) {
			return;
		}
		this.probeStarted = true;
		const kind = await probeMediaKind(
			this.deps.app.vault.getResourcePath(this.file),
		);
		if (this.unloaded) {
			return;
		}
		this.deps.mediaKindCache.set(this.file.path, kind);
		this.evaluate();
	}

	/**
	 * Mounts the target, replacing whatever is mounted. Idempotent: a no-op
	 * when the target is already mounted, so re-renders and refreshes never
	 * churn the DOM or flash.
	 * @param target - What to mount
	 */
	private mount(target: MountKind): void {
		if (this.mounted === target) {
			return;
		}
		if (this.child) {
			this.removeChild(this.child);
			this.child = null;
		}
		this.containerEl.empty();
		this.mounted = target;
		if (target === 'enhanced') {
			this.mountEnhanced();
		} else {
			this.mountNative();
		}
	}

	/** Mounts Obsidian's built-in embed and loads its media. */
	private mountNative(): void {
		const creator = this.deps.fallbackCreator;
		if (!creator) {
			// No default creator was captured for this extension; nothing to
			// delegate to. The container stays empty (a pre-existing edge
			// that does not occur for the registered media extensions).
			return;
		}
		const native = creator(this.info, this.file, this.subpath);
		this.child = native;
		this.addChild(native);
		if (typeof native.loadFile === 'function') {
			void native.loadFile(this.file);
		}
	}

	/** Mounts the enhanced audio player. */
	private mountEnhanced(): void {
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
		this.child = player;
		this.addChild(player);
	}
}
