/**
 * Note-independent playback started from a timecode link when no embedded
 * player is on screen (e.g. the embed is scrolled out of view in Live Preview
 * and CodeMirror has unloaded it). Clicking a transcript timestamp must play
 * from that moment rather than opening the raw file, so this drives the shared
 * audio element for the file directly and is controlled through the status-bar
 * playback controls. It reuses the plain-embed playback key, so an embed of the
 * same file that later renders shares one audio element and one playback instead
 * of starting a second, overlapping one.
 * @module player/DetachedPlayback
 */

import type { App, TFile } from 'obsidian';
import { PLUGIN_LOG_PREFIX } from '../constants';
import { AudioPlayerRegistry, playbackKey } from './AudioPlayerRegistry';

/**
 * Drives one detached playback for a file's shared audio element.
 */
export class DetachedPlayback {
	private disposed = false;
	private unregisterController: () => void = () => undefined;
	/** Stable listener reference so it can be detached on teardown. */
	private readonly handleEnded = (): void => {
		this.dispose();
	};

	/**
	 * @param registry - Owner of the shared audio elements
	 * @param path - Vault path of the played file
	 * @param key - Playback key the audio was acquired under
	 * @param audio - Shared audio element for the file
	 * @param onDispose - Called once when this playback tears down
	 */
	private constructor(
		private readonly registry: AudioPlayerRegistry,
		readonly path: string,
		private readonly key: string,
		private readonly audio: HTMLAudioElement,
		private readonly onDispose: () => void,
	) {}

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
		);
		playback.register();
		playback.seek(seconds);
		return playback;
	}

	/**
	 * Seeks the shared audio to an offset and resumes playback. Waits for
	 * metadata when the duration is not yet known, so a just-created element
	 * still starts at the requested position.
	 * @param seconds - Offset in seconds to seek to
	 */
	seek(seconds: number): void {
		if (this.disposed) {
			return;
		}
		const target = Math.max(0, seconds);
		const apply = (): void => {
			this.audio.currentTime = Number.isFinite(this.audio.duration)
				? Math.min(target, this.audio.duration)
				: target;
			this.play();
		};
		if (this.audio.readyState >= 1) {
			apply();
		} else {
			this.audio.addEventListener('loadedmetadata', apply, {
				once: true,
			});
		}
	}

	/**
	 * Tears down the playback: stops the media listener, removes the status-bar
	 * controller, and releases the shared audio hold. Idempotent.
	 */
	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this.audio.removeEventListener('ended', this.handleEnded);
		this.unregisterController();
		this.registry.releaseAudio(this.key);
		this.onDispose();
	}

	/** Registers the status-bar controller and the end-of-media teardown. */
	private register(): void {
		this.unregisterController = this.registry.registerPlaybackController(
			this.key,
			{
				// No marker UI is attached to a detached playback
				canAddMarkers: () => false,
				togglePlay: () => {
					this.togglePlay();
				},
				stop: () => {
					this.stop();
				},
				skip: (deltaSeconds) => {
					this.skip(deltaSeconds);
				},
				toggleMute: () => {
					this.toggleMute();
				},
				setVolume: (volume) => {
					this.setVolume(volume);
				},
				addMarker: () => undefined,
			},
		);
		this.audio.addEventListener('ended', this.handleEnded);
	}

	/** Toggles play/pause on the shared audio. */
	private togglePlay(): void {
		if (this.audio.paused) {
			this.play();
		} else {
			this.audio.pause();
		}
	}

	/** Stops playback, resets the position, and dismisses the controls. */
	private stop(): void {
		this.audio.pause();
		this.audio.currentTime = 0;
		this.dispose();
	}

	/**
	 * Skips playback by a relative number of seconds, clamped to the track.
	 * @param deltaSeconds - Signed number of seconds to skip
	 */
	private skip(deltaSeconds: number): void {
		const max = Number.isFinite(this.audio.duration)
			? this.audio.duration
			: this.audio.currentTime + Math.abs(deltaSeconds);
		this.audio.currentTime = Math.min(
			max,
			Math.max(0, this.audio.currentTime + deltaSeconds),
		);
	}

	/** Toggles muted output on the shared audio. */
	private toggleMute(): void {
		this.audio.muted = !this.audio.muted;
	}

	/**
	 * Applies a volume value and unmutes when the requested level is audible.
	 * @param volume - Volume in the inclusive 0..1 range
	 */
	private setVolume(volume: number): void {
		this.audio.volume = volume;
		if (this.audio.muted && volume > 0) {
			this.audio.muted = false;
		}
	}

	/** Starts playback, swallowing autoplay-policy rejections. */
	private play(): void {
		void this.audio.play().catch((error: unknown) => {
			console.warn(
				`${PLUGIN_LOG_PREFIX} Detached playback could not start:`,
				error,
			);
		});
	}
}
