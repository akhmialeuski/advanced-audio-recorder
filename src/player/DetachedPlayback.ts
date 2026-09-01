/**
 * Note-independent playback started from a timecode link when no embedded
 * player is on screen (e.g. the embed is scrolled out of view in Live Preview
 * and CodeMirror has unloaded it). Clicking a transcript timestamp must play
 * from that moment rather than opening the raw file, so this drives the shared
 * audio element for the file directly and is controlled through the status-bar
 * playback controls. It reuses the plain-embed playback key, so an embed of the
 * same file that later renders shares one audio element and one playback instead
 * of starting a second, overlapping one. Every command routes through the shared
 * playbackCommands helpers, so its behavior can never drift from the embedded
 * player or the status bar.
 * @module player/DetachedPlayback
 */

import type { App, TFile } from 'obsidian';
import { PLAYER_SKIP_SECONDS, PLUGIN_LOG_PREFIX } from '../constants';
import { AudioPlayerRegistry, playbackKey } from './AudioPlayerRegistry';
import { DurationProbe } from './DurationProbe';
import {
	resetPlayback,
	seekAudio,
	setAudioPlaybackRate,
	setAudioVolume,
	skipAudio,
	toggleAudioMuted,
	togglePlayback,
} from './playbackCommands';

/**
 * Drives one detached playback for a file's shared audio element.
 */
export class DetachedPlayback {
	private disposed = false;
	private unregisterController: () => void = () => undefined;
	/**
	 * Offset to move to once the duration is known and the probe settles, and
	 * whether reaching it starts playback. The two travel together because a
	 * deferred seek that lost its intent resumes a playback the listener had
	 * paused, and a click on a timecode is the only one that means to play.
	 */
	private pendingSeek: { seconds: number; autoplay: boolean } | null = null;
	/** Coaxes a real duration out of a stream that loads without one. */
	private readonly durationProbe: DurationProbe;

	/** Logs an autoplay-policy rejection specific to detached playback. */
	private readonly onPlayError = (error: unknown): void => {
		console.warn(
			`${PLUGIN_LOG_PREFIX} Detached playback could not start:`,
			error,
		);
	};

	/** Stable listener references so they can be detached on teardown. */
	private readonly handleEnded = (): void => {
		this.dispose();
	};
	private readonly handleLoadedMetadata = (): void => {
		this.startPendingSeek();
	};

	/**
	 * @param registry - Owner of the shared audio elements
	 * @param path - Vault path of the played file
	 * @param key - Playback key the audio was acquired under
	 * @param audio - Shared audio element for the file
	 * @param onDispose - Called once when this playback tears down
	 * @param skipSeconds - Seconds a skip moves by
	 */
	private constructor(
		private readonly registry: AudioPlayerRegistry,
		readonly path: string,
		private readonly key: string,
		private readonly audio: HTMLAudioElement,
		private readonly onDispose: () => void,
		private readonly skipSeconds: number,
	) {
		// Once the far-seek probe resolves the real duration it restores the
		// start, so the pending offset is applied afterwards - never mid-probe
		this.durationProbe = new DurationProbe(audio, () => {
			this.applyPendingSeek();
		});
	}

	/**
	 * Starts a detached playback for a file at a given offset and wires it to
	 * the status-bar controls. The audio shares the file's plain-embed key, so
	 * an embed that renders later controls the same playback.
	 * @param registry - Owner of the shared audio elements
	 * @param app - Obsidian App (for the media resource URL)
	 * @param file - Audio file to play
	 * @param seconds - Offset in seconds to start playback from
	 * @param onDispose - Called once when this playback tears down
	 * @returns The started playback
	 */
	static start(
		registry: AudioPlayerRegistry,
		app: App,
		file: TFile,
		seconds: number,
		onDispose: () => void,
		skipSeconds: number = PLAYER_SKIP_SECONDS,
	): DetachedPlayback {
		const key = playbackKey(file.path, null);
		const { audio } = registry.acquireAudio(
			key,
			app.vault.getResourcePath(file),
		);
		const playback = new DetachedPlayback(
			registry,
			file.path,
			key,
			audio,
			onDispose,
			skipSeconds,
		);
		playback.register();
		playback.seek(seconds);
		return playback;
	}

	/**
	 * Seeks to an offset and resumes playback. When the duration is not yet
	 * usable the offset is deferred: metadata is probed first (which restores
	 * the start), then the offset is applied, so a stream that loads without a
	 * length still starts at the right place and shows a real total.
	 * @param seconds - Offset in seconds to seek to
	 * @param autoplay - Start playback on arrival; a timecode click means to
	 * listen, while a scrubber leaves a paused playback paused
	 */
	seek(seconds: number, autoplay = true): void {
		if (this.disposed) {
			return;
		}
		this.pendingSeek = { seconds, autoplay };
		if (this.durationKnown()) {
			this.applyPendingSeek();
		} else if (this.audio.readyState >= 1) {
			// Metadata is present but the length is unusable: probe for it now
			this.durationProbe.probe();
		}
		// Otherwise startPendingSeek runs once metadata loads
	}

	/**
	 * Tears down the playback: stops the media listeners, removes the
	 * status-bar controller, and releases the shared audio hold. Idempotent.
	 */
	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this.durationProbe.cancel();
		this.audio.removeEventListener('ended', this.handleEnded);
		this.audio.removeEventListener(
			'loadedmetadata',
			this.handleLoadedMetadata,
		);
		this.unregisterController();
		this.registry.releaseAudio(this.key);
		this.onDispose();
	}

	/** Registers the status-bar controller and the media lifecycle listeners. */
	private register(): void {
		this.unregisterController = this.registry.registerPlaybackController(
			this.key,
			{
				// No marker UI is attached to a detached playback, so it
				// neither creates markers nor navigates the chapters they
				// would define
				canAddMarkers: () => false,
				canNavigateChapters: () => false,
				// Note-independent playback has no marker list, so it has no chapters
				// to repeat; the surfaces gate the control on canNavigateChapters and
				// never reach these.
				chapterLoopEnabled: () => false,
				toggleChapterLoop: () => undefined,
				currentChapterLabel: () => null,
				skipSeconds: () => this.skipSeconds,
				togglePlay: () => {
					togglePlayback(this.audio, this.onPlayError);
				},
				stop: () => {
					this.stop();
				},
				skip: (deltaSeconds) => {
					skipAudio(this.audio, deltaSeconds);
				},
				// Through the same deferral a timecode click takes, so a
				// scrubber moved before the length is known still lands where
				// it was dragged; it only leaves the play state alone.
				seekToPosition: (seconds) => {
					this.seek(seconds, !this.audio.paused);
				},
				toggleMute: () => {
					toggleAudioMuted(this.audio);
				},
				setVolume: (volume) => {
					setAudioVolume(this.audio, volume);
				},
				setPlaybackRate: (rate) => {
					setAudioPlaybackRate(this.audio, rate);
				},
				addMarker: () => undefined,
				previousChapter: () => undefined,
				nextChapter: () => undefined,
			},
		);
		this.audio.addEventListener('ended', this.handleEnded);
		this.audio.addEventListener(
			'loadedmetadata',
			this.handleLoadedMetadata,
		);
	}

	/** Whether the element reports a usable, positive duration. */
	private durationKnown(): boolean {
		return Number.isFinite(this.audio.duration) && this.audio.duration > 0;
	}

	/**
	 * Runs when metadata first loads: applies the offset directly when the
	 * length is usable, otherwise probes for the real length first.
	 */
	private startPendingSeek(): void {
		if (this.pendingSeek === null) {
			return;
		}
		if (this.durationKnown()) {
			this.applyPendingSeek();
		} else {
			this.durationProbe.probe();
		}
	}

	/** Applies the deferred offset with the intent it was asked with. */
	private applyPendingSeek(): void {
		if (this.disposed || this.pendingSeek === null) {
			return;
		}
		const { seconds, autoplay } = this.pendingSeek;
		this.pendingSeek = null;
		seekAudio(this.audio, seconds, {
			autoplay,
			onError: this.onPlayError,
		});
	}

	/** Stops playback, resets the position, and dismisses the controls. */
	private stop(): void {
		resetPlayback(this.audio);
		this.dispose();
	}
}
