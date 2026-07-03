/**
 * Registry of live enhanced audio players, keyed by the vault path of
 * the file they play. Timecode links use it to seek an already-rendered
 * player instead of opening a fresh one, and a settings change uses it to
 * re-apply the player layout in place (no view re-render).
 * @module player/AudioPlayerRegistry
 */

import { SHARED_AUDIO_GRACE_MS } from '../constants';
import type { ResolvedPlayerSettings } from '../player/playerSettings';

/** A reference-counted audio element shared by every player of one file. */
interface SharedAudio {
	audio: HTMLAudioElement;
	/** Number of live players currently bound to this element. */
	refs: number;
	/** Pending release timer id, or 0 when none is scheduled. */
	releaseTimer: number;
	/** Whether playback should resume if a player re-acquires during grace. */
	resumeOnReacquire: boolean;
	/**
	 * Whether the user has engaged this playback (played or sought it). Once
	 * engaged, a per-embed #t= start hint is no longer meaningful and must not
	 * reappear, so it is tracked here (shared across every embed of the file)
	 * rather than per player.
	 */
	engaged: boolean;
}

/**
 * Minimal contract a player exposes to the registry. Kept narrow so the
 * registry stays decoupled from the player's DOM and lifecycle.
 */
export interface SeekablePlayer {
	/** Seeks to the given offset in seconds and starts playback. */
	seekTo(seconds: number): void;
	/** True while the player is attached to the document. */
	isConnected(): boolean;
	/** Re-reads and re-renders this player's markers from the store. */
	reloadMarkers(): void;
	/** Re-renders the player UI in place with new settings. */
	applySettings(settings: ResolvedPlayerSettings): void;
}

/**
 * Tracks the players currently mounted for each audio file. A file can
 * have several players (the same recording embedded more than once), so
 * each path maps to a set.
 */
export class AudioPlayerRegistry {
	private readonly playersByPath = new Map<string, Set<SeekablePlayer>>();
	/** One shared audio element per file path, so every view mode controls
	 * the same playback (a player in Reading view and one in Live Preview are
	 * never independent). */
	private readonly audioByPath = new Map<string, SharedAudio>();

	/**
	 * Returns the shared audio element for a file, creating it on first use.
	 * Every player for the same path gets the SAME element, so playing,
	 * pausing or seeking from any view mode affects the one playback. A
	 * re-acquire during the release grace period cancels the release and
	 * resumes playback if it was running, making a mode switch seamless.
	 * @param path - Vault-relative path of the file
	 * @param src - Resource URL to play (used only when creating)
	 * @returns The shared element and whether it was just created
	 */
	acquireAudio(
		path: string,
		src: string,
	): { audio: HTMLAudioElement; isNew: boolean } {
		const existing = this.audioByPath.get(path);
		if (existing) {
			if (existing.releaseTimer !== 0) {
				window.clearTimeout(existing.releaseTimer);
				existing.releaseTimer = 0;
			}
			existing.refs += 1;
			if (existing.resumeOnReacquire) {
				existing.resumeOnReacquire = false;
				void existing.audio.play().catch(() => {
					// Resume may be blocked; the user can press play
				});
			}
			return { audio: existing.audio, isNew: false };
		}
		const audio = new Audio();
		audio.preload = 'metadata';
		audio.src = src;
		this.audioByPath.set(path, {
			audio,
			refs: 1,
			releaseTimer: 0,
			resumeOnReacquire: false,
			engaged: false,
		});
		return { audio, isNew: true };
	}

	/**
	 * Releases one player's hold on a file's shared audio. When the last
	 * player lets go, playback is paused immediately (so no audio outlives a
	 * closed note) but the element is kept for a short grace period, so a
	 * view-mode switch can re-acquire and resume it instead of restarting.
	 * @param path - Vault-relative path the audio was acquired under
	 */
	releaseAudio(path: string): void {
		const entry = this.audioByPath.get(path);
		if (!entry) {
			return;
		}
		entry.refs -= 1;
		if (entry.refs > 0) {
			return;
		}
		entry.resumeOnReacquire = !entry.audio.paused;
		entry.audio.pause();
		entry.releaseTimer = window.setTimeout(() => {
			entry.audio.removeAttribute('src');
			entry.audio.load();
			this.audioByPath.delete(path);
		}, SHARED_AUDIO_GRACE_MS);
	}

	/**
	 * Registers a player for a file path.
	 * @param path - Vault-relative path of the played file
	 * @param player - Player to register
	 */
	register(path: string, player: SeekablePlayer): void {
		let players = this.playersByPath.get(path);
		if (!players) {
			players = new Set<SeekablePlayer>();
			this.playersByPath.set(path, players);
		}
		players.add(player);
	}

	/**
	 * Removes a player registration, dropping the path entry once its
	 * last player is gone.
	 * @param path - Vault-relative path the player was registered under
	 * @param player - Player to remove
	 */
	unregister(path: string, player: SeekablePlayer): void {
		const players = this.playersByPath.get(path);
		if (!players) {
			return;
		}
		players.delete(player);
		if (players.size === 0) {
			this.playersByPath.delete(path);
		}
	}

	/**
	 * Seeks every connected player for a path to the given offset.
	 * Disconnected players are pruned in passing so a closed view never
	 * holds a stale registration.
	 * @param path - Vault-relative path of the target file
	 * @param seconds - Offset in seconds to seek to
	 * @returns True when at least one connected player was seeked
	 */
	seek(path: string, seconds: number): boolean {
		const players = this.playersByPath.get(path);
		if (!players || players.size === 0) {
			return false;
		}
		let seeked = false;
		for (const player of [...players]) {
			if (!player.isConnected()) {
				players.delete(player);
				continue;
			}
			player.seekTo(seconds);
			seeked = true;
		}
		if (players.size === 0) {
			this.playersByPath.delete(path);
		}
		return seeked;
	}

	/**
	 * Tells every other connected player for a path to re-read its markers,
	 * so a change made in one view (e.g. Live Preview) shows in the others
	 * (e.g. Reading view) without re-opening the note. Disconnected players
	 * are pruned in passing.
	 * @param path - Vault-relative path whose markers changed
	 * @param source - The player that made the change (skipped)
	 */
	reloadMarkers(path: string, source: SeekablePlayer): void {
		const players = this.playersByPath.get(path);
		if (!players) {
			return;
		}
		for (const player of [...players]) {
			if (!player.isConnected()) {
				players.delete(player);
				continue;
			}
			if (player !== source) {
				player.reloadMarkers();
			}
		}
		if (players.size === 0) {
			this.playersByPath.delete(path);
		}
	}

	/**
	 * Re-applies the player layout to every connected player in place, so a
	 * settings change (e.g. toggling the waveform or markers window) takes
	 * effect immediately without re-rendering the note. Disconnected players
	 * are pruned in passing.
	 * @param settings - The new render-ready player settings
	 */
	applySettings(settings: ResolvedPlayerSettings): void {
		for (const players of this.playersByPath.values()) {
			for (const player of [...players]) {
				if (!player.isConnected()) {
					players.delete(player);
					continue;
				}
				player.applySettings(settings);
			}
		}
	}

	/**
	 * Marks a file's shared playback as engaged: the user has played or sought
	 * it, so a per-embed #t= start hint is no longer meaningful and must not
	 * reappear (e.g. when playback later returns to 0). Shared across every
	 * embed of the file, so engaging from one clears the hint on all of them.
	 * @param path - Vault-relative path of the file
	 */
	markAudioEngaged(path: string): void {
		const entry = this.audioByPath.get(path);
		if (entry) {
			entry.engaged = true;
		}
	}

	/**
	 * Whether a file's shared playback has been engaged (played or sought).
	 * Defaults to false for an unknown path or a freshly created element, so a
	 * #t= embed shows its start until the timeline actually moves.
	 * @param path - Vault-relative path of the file
	 */
	isAudioEngaged(path: string): boolean {
		return this.audioByPath.get(path)?.engaged ?? false;
	}

	/**
	 * Drops every registration and tears down all shared audio. Used when the
	 * feature is torn down.
	 */
	clear(): void {
		for (const entry of this.audioByPath.values()) {
			if (entry.releaseTimer !== 0) {
				window.clearTimeout(entry.releaseTimer);
			}
			entry.audio.pause();
			entry.audio.removeAttribute('src');
			entry.audio.load();
		}
		this.audioByPath.clear();
		this.playersByPath.clear();
	}
}
