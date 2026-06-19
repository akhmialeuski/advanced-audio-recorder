/**
 * Registry of live enhanced audio players, keyed by the vault path of
 * the file they play. Timecode links use it to seek an already-rendered
 * player instead of opening a fresh one, and a settings change uses it to
 * re-apply the player layout in place (no view re-render).
 * @module player/AudioPlayerRegistry
 */

import type { ResolvedPlayerSettings } from '../settings/Settings';

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
	 * Drops every registration. Used when the feature is torn down.
	 */
	clear(): void {
		this.playersByPath.clear();
	}
}
