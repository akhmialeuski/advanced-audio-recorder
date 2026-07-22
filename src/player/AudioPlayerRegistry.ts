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
import type { MarkerKind } from '../markers/markerModel';
import type { ResolvedPlayerSettings } from '../player/playerSettings';
import {
	readPlaybackSnapshot,
	resetPlayback,
	seekAudio,
} from './playbackCommands';
import type {
	PlaybackControlsListener,
	PlaybackControlsState,
	PlaybackController,
} from './playbackControls';

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
	/** Players that can persist markers for this playback key. */
	playbackControllers: Set<PlaybackController>;
	/** Detaches the registry's one set of media lifecycle listeners. */
	detachPlaybackEvents: () => void;
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
	/** Playback key currently represented in the status bar. */
	private activePlaybackKey: string | null = null;
	/** Consumers interested in the active status-bar playback snapshot. */
	private readonly playbackListeners = new Set<PlaybackControlsListener>();

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
		const detachPlaybackEvents = this.attachPlaybackEvents(key, audio);
		const entry: SharedAudio = {
			audio,
			refs: 1,
			releaseTimer: 0,
			resumeOnReacquire: false,
			engaged: false,
			playbackControllers: new Set<PlaybackController>(),
			detachPlaybackEvents,
		};
		this.audioByKey.set(key, entry);
		return { audio, isNew: true };
	}

	/**
	 * Whether a shared audio element currently exists for a playback key.
	 * @param key - Playback key (see {@link playbackKey})
	 */
	hasSharedAudio(key: string): boolean {
		return this.audioByKey.has(key);
	}

	/**
	 * Seeks a file's live shared element to an offset and resumes playback,
	 * for a timecode click that races an embed's player registration: the
	 * element already exists and is still held, so any embed bound to it
	 * follows the seek through its own media listeners and no second,
	 * out-of-sync element is ever created. Only an element with a live holder
	 * (refs > 0) is reused this way; a released element sitting in its grace
	 * window has no owner, so it is left for a {@link DetachedPlayback} to
	 * re-acquire (which takes a reference and installs a controller) rather
	 * than being revived here as ownerless playback.
	 * @param key - Playback key (see {@link playbackKey})
	 * @param seconds - Offset in seconds to seek to
	 * @returns True when a still-held shared element existed and was seeked
	 */
	seekSharedAudio(key: string, seconds: number): boolean {
		const entry = this.audioByKey.get(key);
		if (!entry || entry.refs === 0) {
			return false;
		}
		seekAudio(entry.audio, seconds, { autoplay: true });
		return true;
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
			if (this.activePlaybackKey === key) {
				this.activePlaybackKey = null;
				this.emitPlaybackState();
			}
			entry.detachPlaybackEvents();
			entry.audio.removeAttribute('src');
			entry.audio.load();
			this.audioByKey.delete(key);
		}, SHARED_AUDIO_GRACE_MS);
	}

	/**
	 * Registers the existing player actions associated with a shared audio
	 * element, so the status bar delegates to the same implementation as the
	 * embedded control row.
	 * @param key - Playback key returned by {@link playbackKey}
	 * @param controller - Existing transport, volume, and marker actions
	 * @returns Cleanup that removes this player from the playback key
	 */
	registerPlaybackController(
		key: string,
		controller: PlaybackController,
	): () => void {
		const entry = this.audioByKey.get(key);
		if (!entry) {
			return () => undefined;
		}
		entry.playbackControllers.add(controller);
		if (this.activePlaybackKey === key) {
			this.emitPlaybackState();
		}
		return () => {
			entry.playbackControllers.delete(controller);
			if (this.activePlaybackKey === key) {
				this.emitPlaybackState();
			}
		};
	}

	/**
	 * Subscribes to the active playback shown in the status bar. The listener
	 * receives the current snapshot immediately, including null when idle.
	 * @param listener - Playback state consumer
	 * @returns Cleanup that removes the listener
	 */
	subscribePlayback(listener: PlaybackControlsListener): () => void {
		this.playbackListeners.add(listener);
		listener(this.currentPlaybackState());
		return () => {
			this.playbackListeners.delete(listener);
		};
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
	 * Tells every other registered player for a path to re-read its markers,
	 * so a change made in one view (e.g. Live Preview) shows in the others
	 * (e.g. Reading view) without re-opening the note.
	 *
	 * A momentarily disconnected player is reloaded too, and deliberately not
	 * pruned here: Live Preview detaches and reattaches an embed's widget as
	 * the editor viewport changes, so an external write (e.g. generated auto
	 * chapters) that lands while the widget is detached would otherwise be
	 * missed and the reattached widget would show stale markers. Reloading a
	 * detached-but-live player updates its view so the reattached widget is
	 * current; a truly gone player unregisters itself on unload, and an
	 * unloaded player's reload is a guarded no-op, so nothing renders into a
	 * dead view.
	 * @param path - Vault-relative path whose markers changed
	 * @param source - The player that made the change (skipped), or null
	 *   when the change came from outside any player (e.g. auto chapters)
	 *   so every other registered player reloads
	 */
	reloadMarkers(path: string, source: SeekablePlayer | null): void {
		const players = this.playersByPath.get(path);
		if (!players) {
			return;
		}
		for (const player of [...players]) {
			if (player !== source) {
				player.reloadMarkers();
			}
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
			entry.detachPlaybackEvents();
			entry.audio.pause();
			entry.audio.removeAttribute('src');
			entry.audio.load();
		}
		this.audioByKey.clear();
		this.playersByPath.clear();
		this.activePlaybackKey = null;
		this.emitPlaybackState();
		this.playbackListeners.clear();
	}

	/**
	 * Adds the one registry-level set of listeners that drives the global
	 * status-bar controls for a shared audio element.
	 * @param key - Playback key represented by the audio
	 * @param audio - Shared media element
	 * @returns Cleanup that removes all listeners
	 */
	private attachPlaybackEvents(
		key: string,
		audio: HTMLAudioElement,
	): () => void {
		const activate = (): void => {
			this.activePlaybackKey = key;
			this.emitPlaybackState();
		};
		const refresh = (): void => {
			if (this.activePlaybackKey === key) {
				this.emitPlaybackState();
			}
		};
		const finish = (): void => {
			if (this.activePlaybackKey === key) {
				this.activePlaybackKey = null;
				this.emitPlaybackState();
			}
		};

		audio.addEventListener('play', activate);
		audio.addEventListener('pause', refresh);
		audio.addEventListener('timeupdate', refresh);
		audio.addEventListener('loadedmetadata', refresh);
		audio.addEventListener('durationchange', refresh);
		audio.addEventListener('volumechange', refresh);
		audio.addEventListener('ended', finish);

		return () => {
			audio.removeEventListener('play', activate);
			audio.removeEventListener('pause', refresh);
			audio.removeEventListener('timeupdate', refresh);
			audio.removeEventListener('loadedmetadata', refresh);
			audio.removeEventListener('durationchange', refresh);
			audio.removeEventListener('volumechange', refresh);
			audio.removeEventListener('ended', finish);
		};
	}

	/** Emits a fresh snapshot to every status-bar subscriber. */
	private emitPlaybackState(): void {
		const state = this.currentPlaybackState();
		for (const listener of this.playbackListeners) {
			listener(state);
		}
	}

	/**
	 * Builds the controls for the active playback key. Commands capture the key
	 * so a stale DOM event can never affect a newer playback that replaced it.
	 * @returns Current playback controls, or null while no audio is active
	 */
	private currentPlaybackState(): PlaybackControlsState | null {
		const key = this.activePlaybackKey;
		if (key === null) {
			return null;
		}
		const entry = this.audioByKey.get(key);
		if (!entry) {
			return null;
		}
		const snapshot = readPlaybackSnapshot(entry.audio);
		const markerController = this.markerController(entry);

		return {
			currentTime: snapshot.currentTime,
			duration: snapshot.duration,
			paused: snapshot.paused,
			volume: snapshot.volume,
			muted: snapshot.muted,
			markersEnabled: markerController !== null,
			onTogglePlay: () => {
				this.runPlaybackCommand(key, (controller) => {
					controller.togglePlay();
				});
			},
			onStop: () => {
				this.stopPlayback(key);
			},
			onSkip: (deltaSeconds) => {
				this.runPlaybackCommand(key, (controller) => {
					controller.skip(deltaSeconds);
				});
			},
			onToggleMute: () => {
				this.runPlaybackCommand(key, (controller) => {
					controller.toggleMute();
				});
			},
			onVolumeInput: (volume) => {
				this.runPlaybackCommand(key, (controller) => {
					controller.setVolume(volume);
				});
			},
			onAddMarker: (kind) => {
				this.addPlaybackMarker(key, kind);
			},
		};
	}

	/**
	 * Returns the newest live player that currently permits marker creation.
	 * @param entry - Shared audio entry whose players are considered
	 * @returns Eligible marker controller, or null when marker creation is off
	 */
	private markerController(entry: SharedAudio): PlaybackController | null {
		const controllers = [...entry.playbackControllers];
		for (let index = controllers.length - 1; index >= 0; index--) {
			const controller = controllers[index];
			if (controller?.canAddMarkers()) {
				return controller;
			}
		}
		return null;
	}

	/**
	 * Returns the newest live player for a playback key.
	 * @param entry - Shared audio entry whose players are considered
	 * @returns Newest playback controller, or null during lifecycle handoff
	 */
	private playbackController(entry: SharedAudio): PlaybackController | null {
		const controllers = [...entry.playbackControllers];
		return controllers[controllers.length - 1] ?? null;
	}

	/**
	 * Stops a playback, resets its position, and dismisses the status controls.
	 * @param key - Playback key captured by the status snapshot
	 */
	private stopPlayback(key: string): void {
		const entry = this.activeEntry(key);
		if (!entry) {
			return;
		}
		this.activePlaybackKey = null;
		const controller = this.playbackController(entry);
		if (controller) {
			controller.stop();
		} else {
			// No live player (e.g. a handoff between embeds): reset the element
			// directly through the shared command so the stop behaves identically
			resetPlayback(entry.audio);
		}
		this.emitPlaybackState();
	}

	/**
	 * Delegates a command to the existing player implementation and publishes
	 * the resulting shared-audio state without waiting for a media event.
	 * @param key - Playback key captured by the status snapshot
	 * @param command - Operation to run against the newest live player
	 */
	private runPlaybackCommand(
		key: string,
		command: (controller: PlaybackController) => void,
	): void {
		const entry = this.activeEntry(key);
		if (!entry) {
			return;
		}
		const controller = this.playbackController(entry);
		if (controller) {
			command(controller);
			this.emitPlaybackState();
		}
	}

	/**
	 * Delegates marker creation to the newest eligible live player.
	 * @param key - Playback key captured by the status snapshot
	 * @param kind - Marker or chapter kind to persist
	 */
	private addPlaybackMarker(key: string, kind: MarkerKind): void {
		const entry = this.activeEntry(key);
		if (entry) {
			this.markerController(entry)?.addMarker(kind);
		}
	}

	/**
	 * Returns an entry only while its key is still the active playback.
	 * @param key - Playback key captured by the status snapshot
	 * @returns Matching active entry, or null after playback was replaced
	 */
	private activeEntry(key: string): SharedAudio | null {
		return this.activePlaybackKey === key
			? (this.audioByKey.get(key) ?? null)
			: null;
	}
}
