/**
 * Announces the active playback to the operating system, so a recording can
 * be driven from the lock screen, a headset button, or the media keys. The
 * only place in the plugin that knows about `navigator.mediaSession`: every
 * action it registers delegates to the playback snapshot the registry
 * publishes, which is the same surface the status bar uses, so no transport
 * logic exists here.
 * @module player/MediaSessionBridge
 */

import { PLUGIN_LOG_PREFIX } from '../constants';
import type { AudioPlayerRegistry } from './AudioPlayerRegistry';
import type { PlaybackControlsState } from './playbackControls';

/** Application name shown beside the recording in the system controls. */
const MEDIA_SESSION_ARTIST = 'Advanced Audio Recorder';

/**
 * Separates the two fields of the metadata cache key.
 *
 * A control character rather than a printable one, because neither a recording
 * name nor a chapter title can hold it and so no two different pairs can build
 * the same key. Written as an escape: a raw NUL byte in the source makes git
 * classify the whole file as binary, which costs the module its diff, its
 * blame, and any chance of being reviewed a line at a time.
 */
const METADATA_KEY_SEPARATOR = '\u0000';

/** What one media-session action does with the playback that is running. */
type TransportHandler = (
	state: PlaybackControlsState,
	details: MediaSessionActionDetails,
) => void;

/**
 * Every action a playback offers, and what each of them does.
 *
 * One table rather than a call per action, because registering them and
 * withdrawing them both read it. Written as two lists, an action added to only
 * one would either never reach the plugin or go on answering for it after it
 * had unloaded, and the second of those is invisible until a media key opens a
 * plugin that is no longer there.
 */
const TRANSPORT_ACTIONS: ReadonlyMap<MediaSessionAction, TransportHandler> =
	new Map<MediaSessionAction, TransportHandler>([
		[
			'play',
			(state): void => {
				state.onTogglePlay();
			},
		],
		[
			'pause',
			(state): void => {
				state.onTogglePlay();
			},
		],
		[
			'stop',
			(state): void => {
				state.onStop();
			},
		],
		[
			'seekbackward',
			(state, details): void => {
				state.onSkip(-(details.seekOffset ?? state.skipSeconds));
			},
		],
		[
			'seekforward',
			(state, details): void => {
				state.onSkip(details.seekOffset ?? state.skipSeconds);
			},
		],
		[
			// The one action that names a destination rather than a step, so
			// it is the one that goes through the absolute seek. Expressed as
			// a skip it was a delta against the last published snapshot, which
			// lags playback by a timeupdate: a scrubber dragged at speed
			// landed short of where it was dropped, and it took the fixed-step
			// path, which the chapter repeat does not follow.
			'seekto',
			(state, details): void => {
				if (details.seekTime !== undefined) {
					state.onSeekTo(details.seekTime);
				}
			},
		],
	]);

/**
 * The recording's own name, without its folder or extension. The system
 * controls have room for a title and not for a path.
 * @param path - Vault-relative recording path
 * @returns The file name with no directory and no extension
 */
function recordingTitle(path: string): string {
	const name = path.slice(path.lastIndexOf('/') + 1);
	const dot = name.lastIndexOf('.');
	return dot > 0 ? name.slice(0, dot) : name;
}

/**
 * Mirrors the active playback into the system media session.
 */
export class MediaSessionBridge {
	/** Latest snapshot, read by every action handler when it fires. */
	private latest: PlaybackControlsState | null = null;

	/** What the metadata currently says, so it is rebuilt only on a change. */
	private shown = '';

	/** Whether the chapter actions are currently registered. */
	private chapterActions = false;

	/** Drops the registry subscription. */
	private readonly unsubscribe: () => void;

	/**
	 * Builds a bridge over a media session, if the platform has one. Obsidian
	 * on a desktop without media integration, and any environment where the
	 * API is absent, get no bridge at all rather than a guarded no-op object.
	 * @param registry - The registry publishing the active playback
	 * @returns The bridge, or null where the platform offers no media session
	 */
	static create(registry: AudioPlayerRegistry): MediaSessionBridge | null {
		const session = navigator.mediaSession as MediaSession | undefined;
		if (!session) {
			return null;
		}
		return new MediaSessionBridge(session, registry);
	}

	/**
	 * @param session - The platform's media session
	 * @param registry - The registry publishing the active playback
	 */
	private constructor(
		private readonly session: MediaSession,
		registry: AudioPlayerRegistry,
	) {
		this.registerTransportActions();
		this.unsubscribe = registry.subscribePlayback((state) => {
			this.apply(state);
		});
	}

	/**
	 * Stops announcing playback and clears what the system is showing. Called
	 * on plugin unload, so the lock-screen controls do not outlive the plugin
	 * that answers them.
	 */
	dispose(): void {
		this.unsubscribe();
		this.clear();
		// The chapter actions go with the metadata inside clear(), but these
		// were bound once at construction and nothing else takes them back.
		// Left registered, they hold this bridge and the last snapshot alive
		// for as long as the window lives, and a press of the play key still
		// reaches a plugin that has gone instead of whatever would otherwise
		// have answered it.
		for (const action of TRANSPORT_ACTIONS.keys()) {
			this.clearAction(action);
		}
	}

	/**
	 * Mirrors one snapshot, or clears the announcement when playback ends.
	 * @param state - Latest playback snapshot, or null once it stops
	 */
	private apply(state: PlaybackControlsState | null): void {
		this.latest = state;
		if (!state) {
			this.clear();
			return;
		}
		this.showMetadata(state);
		this.session.playbackState = state.paused ? 'paused' : 'playing';
		this.showChapterActions(state.chaptersEnabled);
		this.showPosition(state);
	}

	/**
	 * Names the recording and the chapter it is inside. Rebuilt only when the
	 * text changes: a snapshot arrives on every timeupdate, and allocating
	 * metadata four times a second for the same two strings is waste the
	 * system would have to diff anyway.
	 * @param state - Latest playback snapshot
	 */
	private showMetadata(state: PlaybackControlsState): void {
		const title = recordingTitle(state.recordingPath);
		const album = state.chapterLabel ?? '';
		const shown = `${title}${METADATA_KEY_SEPARATOR}${album}`;
		if (this.shown === shown) {
			return;
		}
		this.shown = shown;
		this.session.metadata = new MediaMetadata({
			title,
			artist: MEDIA_SESSION_ARTIST,
			album,
		});
	}

	/**
	 * Tells the system where playback stands, so a lock screen can draw a
	 * scrubber. Skipped while the duration is unknown or the position has run
	 * past it, both of which the platform rejects outright.
	 * @param state - Latest playback snapshot
	 */
	private showPosition(state: PlaybackControlsState): void {
		if (state.duration <= 0 || state.currentTime > state.duration) {
			return;
		}
		this.session.setPositionState({
			duration: state.duration,
			position: state.currentTime,
			playbackRate: state.playbackRate,
		});
	}

	/**
	 * Registers the actions every playback offers. Set once rather than per
	 * snapshot: each handler reads the live snapshot when it fires, so a
	 * stale one can never be acted on.
	 */
	private registerTransportActions(): void {
		for (const [action, run] of TRANSPORT_ACTIONS) {
			this.setAction(action, run);
		}
	}

	/**
	 * Offers the chapter actions only while the playing recording has
	 * chapters, matching how the embed and the status bar gate them. A system
	 * control the plugin would ignore is worse than one that is not there.
	 * @param enabled - Whether the recording defines chapters
	 */
	private showChapterActions(enabled: boolean): void {
		if (this.chapterActions === enabled) {
			return;
		}
		this.chapterActions = enabled;
		if (!enabled) {
			this.clearAction('previoustrack');
			this.clearAction('nexttrack');
			return;
		}
		this.setAction('previoustrack', (state) => {
			state.onPreviousChapter();
		});
		this.setAction('nexttrack', (state) => {
			state.onNextChapter();
		});
	}

	/**
	 * Binds one action to the live snapshot. A platform that does not know
	 * the action name throws, and one unsupported action must not stop the
	 * rest from being registered.
	 * @param action - Media session action name
	 * @param run - What to do with the snapshot that is playing
	 */
	private setAction(
		action: MediaSessionAction,
		run: (
			state: PlaybackControlsState,
			details: MediaSessionActionDetails,
		) => void,
	): void {
		try {
			this.session.setActionHandler(action, (details) => {
				if (this.latest) {
					run(this.latest, details);
				}
			});
		} catch (error) {
			console.warn(
				`${PLUGIN_LOG_PREFIX} The platform does not offer the ${action} media control:`,
				error,
			);
		}
	}

	/**
	 * Withdraws one action, ignoring a platform that never had it.
	 * @param action - Media session action name
	 */
	private clearAction(action: MediaSessionAction): void {
		try {
			this.session.setActionHandler(action, null);
		} catch {
			// Withdrawing an action the platform does not know is a no-op.
		}
	}

	/** Stops the announcement: no metadata, no position, nothing playing. */
	private clear(): void {
		this.latest = null;
		this.shown = '';
		this.session.metadata = null;
		this.session.playbackState = 'none';
		this.showChapterActions(false);
	}
}
