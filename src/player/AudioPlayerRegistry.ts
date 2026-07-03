/**
 * Registry of live enhanced audio players. Player registrations are keyed
 * by the vault path of the file they play (timecode links use them to seek
 * an already-rendered player, marker edits to sync the other views, and a
 * settings change to re-apply the player layout in place). The shared audio
 * elements are keyed more finely, by playback key (path + #t= start), so
 * distinct embeds of one file play independently while the same embed keeps
 * its playback across a view-mode switch.
 * @module player/AudioPlayerRegistry
 */

import { SHARED_AUDIO_GRACE_MS } from '../constants';
import type { ResolvedPlayerSettings } from '../player/playerSettings';

/**
 * Separates the path from the #t= start inside a playback key. U+0000 cannot
 * appear in a vault path, so a file whose name spells out the suffix (e.g.
 * "rec.wav#t=3") can never collide with a real #t= embed key.
 */
const PLAYBACK_KEY_SEPARATOR = '\u0000';

/**
 * Builds the identity key a player's shared audio element is stored under:
 * the file path plus the embed's parsed #t= start. Distinct embeds of one
 * file (a plain embed and a #t= embed, or two different #t= offsets) get
 * different keys and therefore independent playback, while the same embed
 * re-created across a view-mode switch or an in-place re-render maps to the
 * same key and so keeps its element (and running playback). Byte-identical
 * embeds share a key by design: without a stable source position they are
 * indistinguishable from the same embed re-rendered, and keeping them on one
 * element is what preserves cross-view continuity.
 * @param path - Vault-relative path of the audio file
 * @param startSeconds - Parsed #t= start of the embed, or null when absent
 */
export function playbackKey(path: string, startSeconds: number | null): string {
	return `${path}${PLAYBACK_KEY_SEPARATOR}t=${startSeconds === null ? '' : String(startSeconds)}`;
}

/** A reference-counted audio element shared by every player of one
 * playback key (the same embed shown in several views/panes). */
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
	 * engaged, the embed's #t= start hint is no longer meaningful and must not
	 * reappear, so it is tracked here (shared across every player of the same
	 * playback key, e.g. the same embed in another pane) rather than per
	 * player instance.
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
	/** One shared audio element per playback key (see playbackKey), so the
	 * same embed across view modes controls one playback while distinct
	 * embeds of the same file stay independent. */
	private readonly audioByKey = new Map<string, SharedAudio>();

	/**
	 * Returns the shared audio element for a playback key, creating it on
	 * first use. Every player for the same key (the same embed across view
	 * modes/panes) gets the SAME element, so playing, pausing or seeking it
	 * anywhere affects that one playback - while a different embed of the
	 * same file has a different key and is untouched. A re-acquire during
	 * the release grace period cancels the release and resumes playback if
	 * it was running, making a mode switch seamless.
	 * @param key - Playback key of the embed (see playbackKey)
	 * @param src - Resource URL to play (used only when creating)
	 * @returns The shared element and whether it was just created
	 */
	acquireAudio(
		key: string,
		src: string,
	): { audio: HTMLAudioElement; isNew: boolean } {
		const existing = this.audioByKey.get(key);
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
		this.audioByKey.set(key, {
			audio,
			refs: 1,
			releaseTimer: 0,
			resumeOnReacquire: false,
			engaged: false,
		});
		return { audio, isNew: true };
	}

	/**
	 * Releases one player's hold on its embed's shared audio. When the last
	 * player lets go, playback is paused immediately (so no audio outlives a
	 * closed note) but the element is kept for a short grace period, so a
	 * view-mode switch can re-acquire and resume it instead of restarting.
	 * @param key - Playback key the audio was acquired under
	 */
	releaseAudio(key: string): void {
		const entry = this.audioByKey.get(key);
		if (!entry) {
			return;
		}
		// Clamp at zero so a double release (a defensive caller running its
		// cleanup twice) cannot push the count negative and make the next
		// acquire/release pairing skip the actual teardown.
		entry.refs = Math.max(0, entry.refs - 1);
		if (entry.refs > 0) {
			return;
		}
		entry.resumeOnReacquire = !entry.audio.paused;
		entry.audio.pause();
		entry.releaseTimer = window.setTimeout(() => {
			entry.audio.removeAttribute('src');
			entry.audio.load();
			this.audioByKey.delete(key);
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
	 * Seeks the FIRST connected player for a path to the given offset.
	 * Players of one file drive independent playback elements (one per
	 * embed), so seeking every player would start several overlapping
	 * playbacks from a single timecode click; only one is targeted
	 * (registration order, which follows document order). The same embed
	 * shown in another view mode shares that player's element, so it stays
	 * in sync anyway. Disconnected players are pruned in passing so a
	 * closed view never holds a stale registration.
	 * @param path - Vault-relative path of the target file
	 * @param seconds - Offset in seconds to seek to
	 * @returns True when a connected player was seeked
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
			if (!seeked) {
				player.seekTo(seconds);
				seeked = true;
			}
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
	 * Marks an embed's shared playback as engaged: the user has played or
	 * sought it, so its #t= start hint is no longer meaningful and must not
	 * reappear (e.g. when playback later returns to 0). Shared across every
	 * player of the same playback key (the same embed in another view/pane),
	 * while a different embed of the file keeps its own hint.
	 * @param key - Playback key of the embed (see playbackKey)
	 */
	markAudioEngaged(key: string): void {
		const entry = this.audioByKey.get(key);
		if (entry) {
			entry.engaged = true;
		}
	}

	/**
	 * Whether an embed's shared playback has been engaged (played or sought).
	 * Defaults to false for an unknown key or a freshly created element, so a
	 * #t= embed shows its start until its timeline actually moves.
	 * @param key - Playback key of the embed (see playbackKey)
	 */
	isAudioEngaged(key: string): boolean {
		return this.audioByKey.get(key)?.engaged ?? false;
	}

	/**
	 * Drops every registration and tears down all shared audio. Used when the
	 * feature is torn down.
	 */
	clear(): void {
		for (const entry of this.audioByKey.values()) {
			if (entry.releaseTimer !== 0) {
				window.clearTimeout(entry.releaseTimer);
			}
			entry.audio.pause();
			entry.audio.removeAttribute('src');
			entry.audio.load();
		}
		this.audioByKey.clear();
		this.playersByPath.clear();
	}
}
