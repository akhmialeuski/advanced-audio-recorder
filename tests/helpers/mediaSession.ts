/**
 * A stand-in for the platform's media session, which jsdom does not provide.
 * Models only what the plugin touches - metadata, playback state, position,
 * and the action handlers - and records it, so a test can fire a system
 * action the way a lock screen or a headset button would.
 * @module tests/helpers/mediaSession
 */

/** What the stand-in was told, and how to fire what it registered. */
export interface MediaSessionDouble {
	/** The session object the bridge talks to. */
	session: MediaSession;
	/** Last metadata set, or null once the announcement was cleared. */
	metadata(): MediaMetadata | null;
	/** Last playback state set. */
	playbackState(): MediaSessionPlaybackState;
	/** Every position update, oldest first. */
	positions: MediaPositionState[];
	/** The action names currently registered. */
	registered(): MediaSessionAction[];
	/** Fires a registered action, as the operating system would. */
	fire(action: MediaSessionAction, details?: MediaSessionActionDetails): void;
	/** Restores whatever was on navigator before. */
	restore(): void;
}

/** The subset of MediaMetadataInit the plugin fills in. */
interface MetadataFields {
	title?: string;
	artist?: string;
	album?: string;
}

/**
 * Installs a media session on `navigator` for the duration of a test, along
 * with the `MediaMetadata` constructor the bridge builds with.
 * @param options - Set `unsupported` to a list of actions the platform
 *   refuses, so the bridge's per-action guard can be exercised
 * @returns The double, with a restore to call when the test is done
 */
export function installMediaSession(
	options: { unsupported?: readonly MediaSessionAction[] } = {},
): MediaSessionDouble {
	const unsupported = new Set(options.unsupported ?? []);
	const handlers = new Map<
		MediaSessionAction,
		(details: MediaSessionActionDetails) => void
	>();
	const positions: MediaPositionState[] = [];
	let metadata: MediaMetadata | null = null;
	let playbackState: MediaSessionPlaybackState = 'none';

	const session = {
		get metadata(): MediaMetadata | null {
			return metadata;
		},
		set metadata(value: MediaMetadata | null) {
			metadata = value;
		},
		get playbackState(): MediaSessionPlaybackState {
			return playbackState;
		},
		set playbackState(value: MediaSessionPlaybackState) {
			playbackState = value;
		},
		setPositionState: (state?: MediaPositionState) => {
			if (state) {
				positions.push(state);
			}
		},
		setActionHandler: (
			action: MediaSessionAction,
			handler: ((details: MediaSessionActionDetails) => void) | null,
		) => {
			if (unsupported.has(action)) {
				throw new TypeError(`Unsupported action: ${action}`);
			}
			if (handler) {
				handlers.set(action, handler);
			} else {
				handlers.delete(action);
			}
		},
	} as unknown as MediaSession;

	const globals = globalThis as unknown as {
		MediaMetadata?: unknown;
		navigator: { mediaSession?: MediaSession };
	};
	const previousMetadata = globals.MediaMetadata;
	const previousSession = globals.navigator.mediaSession;
	globals.MediaMetadata = class {
		title: string;
		artist: string;
		album: string;
		constructor(init: MetadataFields = {}) {
			this.title = init.title ?? '';
			this.artist = init.artist ?? '';
			this.album = init.album ?? '';
		}
	};
	Object.defineProperty(globals.navigator, 'mediaSession', {
		configurable: true,
		value: session,
	});

	return {
		session,
		metadata: () => metadata,
		playbackState: () => playbackState,
		positions,
		registered: () => [...handlers.keys()],
		fire: (action, details = { action }) => {
			const handler = handlers.get(action);
			if (!handler) {
				throw new Error(`No handler registered for ${action}`);
			}
			handler(details);
		},
		restore: () => {
			globals.MediaMetadata = previousMetadata;
			Object.defineProperty(globals.navigator, 'mediaSession', {
				configurable: true,
				value: previousSession,
			});
		},
	};
}

/**
 * Removes the media session from `navigator`, so a test can prove the plugin
 * survives a platform that has none.
 * @returns A restore function
 */
export function withoutMediaSession(): () => void {
	const globals = globalThis as unknown as {
		navigator: { mediaSession?: MediaSession };
	};
	const previous = globals.navigator.mediaSession;
	Object.defineProperty(globals.navigator, 'mediaSession', {
		configurable: true,
		value: undefined,
	});
	return () => {
		Object.defineProperty(globals.navigator, 'mediaSession', {
			configurable: true,
			value: previous,
		});
	};
}
