/**
 * Tests for the live audio player registry used by timecode links.
 */

import {
	AudioPlayerRegistry,
	playbackKey,
	type SeekablePlayer,
} from 'src/player/AudioPlayerRegistry';
import type { ResolvedPlayerSettings } from 'src/player/playerSettings';
import type {
	PlaybackController,
	PlaybackControlsState,
} from 'src/player/playbackControls';

/** Controllable media element and spies installed as the global Audio factory. */
interface MockAudioHarness {
	audio: HTMLAudioElement;
	play: jest.SpyInstance<Promise<void>, []>;
	pause: jest.SpyInstance<void, []>;
	/** Restores the global constructor and media method implementations. */
	restore(): void;
}

/**
 * Installs a deterministic HTMLAudioElement for registry playback tests.
 * Its play and pause methods synchronously emit the matching media events.
 * @param duration - Initial finite media duration in seconds
 * @returns Audio element, method spies, and cleanup
 */
function installMockAudio(duration = 120): MockAudioHarness {
	const audio = document.createElement('audio');
	let paused = true;
	Object.defineProperties(audio, {
		paused: {
			configurable: true,
			get: () => paused,
		},
		duration: {
			configurable: true,
			writable: true,
			value: duration,
		},
	});
	const play = jest.spyOn(audio, 'play').mockImplementation(() => {
		paused = false;
		audio.dispatchEvent(new Event('play'));
		return Promise.resolve();
	});
	const pause = jest.spyOn(audio, 'pause').mockImplementation(() => {
		paused = true;
		audio.dispatchEvent(new Event('pause'));
	});
	const load = jest.spyOn(audio, 'load').mockImplementation(() => undefined);
	const audioConstructor = jest
		.spyOn(globalThis, 'Audio')
		.mockImplementation(() => audio);

	return {
		audio,
		play,
		pause,
		restore: () => {
			audioConstructor.mockRestore();
			load.mockRestore();
			pause.mockRestore();
		},
	};
}

/**
 * Builds a jest-backed player command surface for registry delegation tests.
 * @param overrides - Command implementations needed by a specific test
 * @returns Complete playback controller accepted by the registry
 */
function makePlaybackController(
	overrides: Partial<PlaybackController> = {},
): PlaybackController {
	return {
		canAddMarkers: jest.fn(() => true),
		togglePlay: jest.fn(),
		stop: jest.fn(),
		skip: jest.fn(),
		toggleMute: jest.fn(),
		setVolume: jest.fn(),
		addMarker: jest.fn(),
		...overrides,
	};
}

/**
 * Builds a fake player that records seek calls and reports a fixed
 * connection state.
 */
function makePlayer(connected = true): SeekablePlayer & {
	seeks: number[];
	reloads: number;
	applied: number;
} {
	return {
		seeks: [] as number[],
		reloads: 0,
		applied: 0,
		seekTo(seconds: number): void {
			this.seeks.push(seconds);
		},
		isConnected(): boolean {
			return connected;
		},
		reloadMarkers(): void {
			this.reloads += 1;
		},
		applySettings(_settings: ResolvedPlayerSettings): void {
			this.applied += 1;
		},
	};
}

describe('playbackKey', () => {
	it('separates embeds of one file by their #t= start', () => {
		expect(playbackKey('rec.wav', null)).toBe(playbackKey('rec.wav', null));
		expect(playbackKey('rec.wav', 3)).toBe(playbackKey('rec.wav', 3));
		expect(playbackKey('rec.wav', 3)).not.toBe(
			playbackKey('rec.wav', null),
		);
		expect(playbackKey('rec.wav', 3)).not.toBe(playbackKey('rec.wav', 4));
		expect(playbackKey('a.wav', null)).not.toBe(playbackKey('b.wav', null));
	});

	it('cannot collide with a path that spells out the #t= suffix', () => {
		// The separator is a character no vault path can contain, so a file
		// literally named "rec.wav#t=3" never aliases a real #t=3 embed key
		expect(playbackKey('rec.wav#t=3', null)).not.toBe(
			playbackKey('rec.wav', 3),
		);
	});
});

describe('AudioPlayerRegistry', () => {
	it('seeks only the first connected player for a path', () => {
		const registry = new AudioPlayerRegistry();
		const a = makePlayer();
		const b = makePlayer();
		registry.register('rec.wav', a);
		registry.register('rec.wav', b);

		// Each player drives its own playback element, so seeking (and
		// autoplaying) every player would start overlapping playbacks; a
		// timecode click targets one player only
		expect(registry.seek('rec.wav', 42)).toBe(true);
		expect(a.seeks).toEqual([42]);
		expect(b.seeks).toEqual([]);
	});

	it('returns false when no player is registered for the path', () => {
		const registry = new AudioPlayerRegistry();
		expect(registry.seek('missing.wav', 10)).toBe(false);
	});

	it('falls through to the next player when the first is disconnected', () => {
		const registry = new AudioPlayerRegistry();
		const disconnected = makePlayer(false);
		const connected = makePlayer(true);
		registry.register('rec.wav', disconnected);
		registry.register('rec.wav', connected);

		expect(registry.seek('rec.wav', 5)).toBe(true);
		expect(connected.seeks).toEqual([5]);
		expect(disconnected.seeks).toEqual([]);
	});

	it('prunes disconnected players during a seek', () => {
		const registry = new AudioPlayerRegistry();
		const connected = makePlayer(true);
		const disconnected = makePlayer(false);
		registry.register('rec.wav', connected);
		registry.register('rec.wav', disconnected);

		expect(registry.seek('rec.wav', 5)).toBe(true);
		expect(connected.seeks).toEqual([5]);
		expect(disconnected.seeks).toEqual([]);
	});

	it('drops the path entry once its last player unregisters', () => {
		const registry = new AudioPlayerRegistry();
		const player = makePlayer();
		registry.register('rec.wav', player);
		registry.unregister('rec.wav', player);
		expect(registry.seek('rec.wav', 1)).toBe(false);
	});

	it('returns false when every player is disconnected', () => {
		const registry = new AudioPlayerRegistry();
		registry.register('rec.wav', makePlayer(false));
		expect(registry.seek('rec.wav', 3)).toBe(false);
	});

	it('clears all registrations', () => {
		const registry = new AudioPlayerRegistry();
		registry.register('rec.wav', makePlayer());
		registry.clear();
		expect(registry.seek('rec.wav', 1)).toBe(false);
	});

	it('reloads markers on other players but not the source', () => {
		const registry = new AudioPlayerRegistry();
		const source = makePlayer();
		const other = makePlayer();
		registry.register('rec.wav', source);
		registry.register('rec.wav', other);

		registry.reloadMarkers('rec.wav', source);
		expect(source.reloads).toBe(0);
		expect(other.reloads).toBe(1);
	});

	it('reloads a momentarily disconnected player so a reattached widget is current', () => {
		const registry = new AudioPlayerRegistry();
		const source = makePlayer();
		// Live Preview detaches an embed's widget as the viewport changes; a
		// marker write landing then must still reach that player, or the
		// reattached widget would show stale markers.
		const disconnected = makePlayer(false);
		registry.register('rec.wav', source);
		registry.register('rec.wav', disconnected);

		registry.reloadMarkers('rec.wav', source);
		expect(disconnected.reloads).toBe(1);
	});

	it('does nothing when reloading markers for an unknown path', () => {
		const registry = new AudioPlayerRegistry();
		expect(() => {
			registry.reloadMarkers('missing.wav', makePlayer());
		}).not.toThrow();
	});

	it('shares one audio element across players of the same embed identity', () => {
		const registry = new AudioPlayerRegistry();
		const key = playbackKey('rec.wav', null);
		const first = registry.acquireAudio(key, 'app://rec');
		const second = registry.acquireAudio(key, 'app://rec');

		// Same element -> the same embed in either view mode controls one
		// playback
		expect(first.audio).toBe(second.audio);
		expect(first.isNew).toBe(true);
		expect(second.isNew).toBe(false);

		expect(
			registry.acquireAudio(playbackKey('other.wav', null), 'app://o')
				.audio,
		).not.toBe(first.audio);
	});

	it('gives distinct embeds of one file independent audio elements', () => {
		const registry = new AudioPlayerRegistry();
		// A plain embed and a #t=3 embed of the SAME file must not share a
		// playback: playing or seeking one must never move the other
		const plain = registry.acquireAudio(
			playbackKey('rec.wav', null),
			'app://rec',
		);
		const timed = registry.acquireAudio(
			playbackKey('rec.wav', 3),
			'app://rec',
		);

		expect(timed.audio).not.toBe(plain.audio);
		expect(plain.isNew).toBe(true);
		expect(timed.isNew).toBe(true);
	});

	it('keeps the audio alive across a mode switch, then frees it after the grace period', () => {
		jest.useFakeTimers();
		try {
			const registry = new AudioPlayerRegistry();
			const key = playbackKey('rec.wav', null);
			const a = registry.acquireAudio(key, 'app://rec');
			registry.acquireAudio(key, 'app://rec'); // second view mode

			// One view unloads; the element must survive for the other
			registry.releaseAudio(key);
			jest.advanceTimersByTime(100);
			expect(registry.acquireAudio(key, 'app://rec').audio).toBe(a.audio);

			// Now both remaining holders release -> after grace it is freed
			registry.releaseAudio(key);
			registry.releaseAudio(key);
			jest.advanceTimersByTime(1000);
			expect(registry.acquireAudio(key, 'app://rec').isNew).toBe(true);
		} finally {
			jest.useRealTimers();
		}
	});

	it('broadcasts applySettings to every connected player, pruning the rest', () => {
		const registry = new AudioPlayerRegistry();
		const a = makePlayer();
		const b = makePlayer();
		const gone = makePlayer(false);
		registry.register('rec.wav', a);
		registry.register('rec.wav', b);
		registry.register('other.wav', gone);

		registry.applySettings({} as ResolvedPlayerSettings);

		expect(a.applied).toBe(1);
		expect(b.applied).toBe(1);
		// Disconnected players are not updated (and are pruned)
		expect(gone.applied).toBe(0);
	});

	it('tracks the engaged state of a shared audio element', () => {
		const registry = new AudioPlayerRegistry();
		const key = playbackKey('rec.wav', 3);
		registry.acquireAudio(key, 'app://rec');

		// A fresh element is not engaged, so a #t= embed may show its start
		expect(registry.isAudioEngaged(key)).toBe(false);
		registry.markAudioEngaged(key);
		expect(registry.isAudioEngaged(key)).toBe(true);
	});

	it('tracks the engaged state per embed identity, not per file', () => {
		const registry = new AudioPlayerRegistry();
		const plainKey = playbackKey('rec.wav', null);
		const timedKey = playbackKey('rec.wav', 3);
		registry.acquireAudio(plainKey, 'app://rec');
		registry.acquireAudio(timedKey, 'app://rec');

		// Playing the plain embed must not consume the #t= embed's start hint
		registry.markAudioEngaged(plainKey);
		expect(registry.isAudioEngaged(plainKey)).toBe(true);
		expect(registry.isAudioEngaged(timedKey)).toBe(false);
	});

	it('reports not engaged for an unknown key', () => {
		const registry = new AudioPlayerRegistry();
		const key = playbackKey('missing.wav', null);
		expect(registry.isAudioEngaged(key)).toBe(false);
		// Marking an unknown key is a no-op, never throws
		expect(() => {
			registry.markAudioEngaged(key);
		}).not.toThrow();
	});

	it('resets the engaged state when the shared element is recreated', () => {
		jest.useFakeTimers();
		try {
			const registry = new AudioPlayerRegistry();
			const key = playbackKey('rec.wav', 3);
			registry.acquireAudio(key, 'app://rec');
			registry.markAudioEngaged(key);

			// Release and let the grace period free the element
			registry.releaseAudio(key);
			jest.advanceTimersByTime(1000);

			// A re-mounted #t= embed starts from a fresh, not-engaged element
			registry.acquireAudio(key, 'app://rec');
			expect(registry.isAudioEngaged(key)).toBe(false);
		} finally {
			jest.useRealTimers();
		}
	});

	it('publishes active playback and delegates every status-bar command', () => {
		const harness = installMockAudio();
		try {
			const registry = new AudioPlayerRegistry();
			const listener = jest.fn<void, [PlaybackControlsState | null]>();
			const marker = jest.fn();
			const controller = makePlaybackController({
				togglePlay: jest.fn(() => {
					if (harness.audio.paused) {
						void harness.audio.play();
					} else {
						harness.audio.pause();
					}
				}),
				stop: jest.fn(() => {
					harness.audio.pause();
					harness.audio.currentTime = 0;
				}),
				skip: jest.fn((deltaSeconds: number) => {
					harness.audio.currentTime = Math.min(
						harness.audio.duration,
						Math.max(0, harness.audio.currentTime + deltaSeconds),
					);
				}),
				toggleMute: jest.fn(() => {
					harness.audio.muted = !harness.audio.muted;
				}),
				setVolume: jest.fn((volume: number) => {
					harness.audio.volume = volume;
					if (volume > 0) {
						harness.audio.muted = false;
					}
				}),
				addMarker: marker,
			});
			const key = playbackKey('rec.wav', null);
			registry.subscribePlayback(listener);
			registry.acquireAudio(key, 'app://rec');
			registry.registerPlaybackController(key, controller);
			harness.audio.currentTime = 30;
			harness.audio.volume = 0.8;
			void harness.audio.play();

			let state = listener.mock.lastCall?.[0];
			expect(state).toEqual(
				expect.objectContaining({
					currentTime: 30,
					duration: 120,
					paused: false,
					volume: 0.8,
					muted: false,
					markersEnabled: true,
				}),
			);
			if (!state) {
				throw new Error('Expected active playback state');
			}

			state.onSkip(-10);
			expect(harness.audio.currentTime).toBe(20);
			state = listener.mock.lastCall?.[0];
			state?.onSkip(500);
			expect(harness.audio.currentTime).toBe(120);
			state = listener.mock.lastCall?.[0];
			state?.onToggleMute();
			expect(harness.audio.muted).toBe(true);
			state = listener.mock.lastCall?.[0];
			state?.onVolumeInput(0.4);
			expect(harness.audio.volume).toBe(0.4);
			expect(harness.audio.muted).toBe(false);
			state = listener.mock.lastCall?.[0];
			state?.onAddMarker('bookmark');
			expect(marker).toHaveBeenCalledWith('bookmark');

			state?.onTogglePlay();
			expect(harness.pause).toHaveBeenCalled();
			expect(listener.mock.lastCall?.[0]?.paused).toBe(true);
			listener.mock.lastCall?.[0]?.onTogglePlay();
			expect(harness.play).toHaveBeenCalledTimes(2);

			listener.mock.lastCall?.[0]?.onStop();
			expect(harness.audio.currentTime).toBe(0);
			expect(listener.mock.lastCall?.[0]).toBeNull();
		} finally {
			harness.restore();
		}
	});

	it('dismisses playback when the media ends', () => {
		const harness = installMockAudio();
		try {
			const registry = new AudioPlayerRegistry();
			const listener = jest.fn<void, [PlaybackControlsState | null]>();
			registry.subscribePlayback(listener);
			registry.acquireAudio(playbackKey('rec.wav', null), 'app://rec');
			void harness.audio.play();

			harness.audio.dispatchEvent(new Event('ended'));

			expect(listener.mock.lastCall?.[0]).toBeNull();
		} finally {
			harness.restore();
		}
	});

	it('keeps paused playback visible until the shared audio is released', () => {
		jest.useFakeTimers();
		const harness = installMockAudio();
		try {
			const registry = new AudioPlayerRegistry();
			const listener = jest.fn<void, [PlaybackControlsState | null]>();
			const key = playbackKey('rec.wav', null);
			registry.subscribePlayback(listener);
			registry.acquireAudio(key, 'app://rec');
			void harness.audio.play();

			registry.releaseAudio(key);
			expect(listener.mock.lastCall?.[0]?.paused).toBe(true);
			jest.advanceTimersByTime(1000);
			expect(listener.mock.lastCall?.[0]).toBeNull();
		} finally {
			harness.restore();
			jest.useRealTimers();
		}
	});

	it('hides marker actions without an eligible live player', () => {
		const harness = installMockAudio();
		try {
			const registry = new AudioPlayerRegistry();
			const listener = jest.fn<void, [PlaybackControlsState | null]>();
			const marker = jest.fn();
			const key = playbackKey('rec.wav', null);
			registry.subscribePlayback(listener);
			registry.acquireAudio(key, 'app://rec');
			void harness.audio.play();
			expect(listener.mock.lastCall?.[0]?.markersEnabled).toBe(false);
			const unregister = registry.registerPlaybackController(
				key,
				makePlaybackController({
					canAddMarkers: () => false,
					addMarker: marker,
				}),
			);

			expect(listener.mock.lastCall?.[0]?.markersEnabled).toBe(false);
			listener.mock.lastCall?.[0]?.onAddMarker('chapter');
			expect(marker).not.toHaveBeenCalled();

			unregister();
			expect(listener.mock.lastCall?.[0]?.markersEnabled).toBe(false);
			const cleanupMissing = registry.registerPlaybackController(
				'missing',
				makePlaybackController({ addMarker: marker }),
			);
			expect(cleanupMissing).not.toThrow();
		} finally {
			harness.restore();
		}
	});

	it('ignores commands from a stale playback snapshot', () => {
		const first = installMockAudio();
		try {
			const registry = new AudioPlayerRegistry();
			const listener = jest.fn<void, [PlaybackControlsState | null]>();
			const controller = makePlaybackController();
			const firstKey = playbackKey('first.wav', null);
			registry.subscribePlayback(listener);
			registry.acquireAudio(firstKey, 'app://first');
			registry.registerPlaybackController(firstKey, controller);
			first.audio.currentTime = 10;
			void first.audio.play();
			const staleState = listener.mock.lastCall?.[0];
			if (!staleState) {
				throw new Error('Expected active playback state');
			}

			first.audio.dispatchEvent(new Event('ended'));
			staleState.onSkip(10);
			staleState.onToggleMute();
			staleState.onTogglePlay();
			staleState.onVolumeInput(0.5);
			staleState.onAddMarker('bookmark');
			staleState.onStop();
			expect(controller.skip).not.toHaveBeenCalled();
			expect(controller.toggleMute).not.toHaveBeenCalled();
			expect(controller.togglePlay).not.toHaveBeenCalled();
			expect(controller.setVolume).not.toHaveBeenCalled();
			expect(controller.addMarker).not.toHaveBeenCalled();
			expect(controller.stop).not.toHaveBeenCalled();
		} finally {
			first.restore();
		}
	});

	it('falls back to the shared audio element when stop occurs during handoff', () => {
		const harness = installMockAudio();
		try {
			const registry = new AudioPlayerRegistry();
			const listener = jest.fn<void, [PlaybackControlsState | null]>();
			registry.subscribePlayback(listener);
			registry.acquireAudio(playbackKey('rec.wav', null), 'app://rec');
			harness.audio.currentTime = 30;
			void harness.audio.play();

			listener.mock.lastCall?.[0]?.onTogglePlay();
			expect(harness.pause).not.toHaveBeenCalled();
			listener.mock.lastCall?.[0]?.onStop();

			expect(harness.pause).toHaveBeenCalled();
			expect(harness.audio.currentTime).toBe(0);
			expect(listener.mock.lastCall?.[0]).toBeNull();
		} finally {
			harness.restore();
		}
	});

	it('stops notifying a playback subscriber after cleanup', () => {
		const harness = installMockAudio();
		try {
			const registry = new AudioPlayerRegistry();
			const listener = jest.fn<void, [PlaybackControlsState | null]>();
			const unsubscribe = registry.subscribePlayback(listener);
			registry.acquireAudio(playbackKey('rec.wav', null), 'app://rec');
			unsubscribe();

			void harness.audio.play();

			expect(listener).toHaveBeenCalledTimes(1);
		} finally {
			harness.restore();
		}
	});

	it('clears active playback, pending release, and media listeners', () => {
		jest.useFakeTimers();
		const harness = installMockAudio();
		try {
			const registry = new AudioPlayerRegistry();
			const listener = jest.fn<void, [PlaybackControlsState | null]>();
			const key = playbackKey('rec.wav', null);
			registry.subscribePlayback(listener);
			registry.acquireAudio(key, 'app://rec');
			void harness.audio.play();
			registry.releaseAudio(key);

			registry.clear();
			const callsAfterClear = listener.mock.calls.length;
			harness.audio.dispatchEvent(new Event('timeupdate'));
			jest.advanceTimersByTime(1000);

			expect(listener.mock.lastCall?.[0]).toBeNull();
			expect(listener).toHaveBeenCalledTimes(callsAfterClear);
			expect(harness.pause).toHaveBeenCalled();
		} finally {
			harness.restore();
			jest.useRealTimers();
		}
	});

	it('returns idle state when an active key no longer has an audio entry', () => {
		const registry = new AudioPlayerRegistry();
		const internals = registry as unknown as {
			activePlaybackKey: string | null;
		};
		internals.activePlaybackKey = playbackKey('missing.wav', null);
		const listener = jest.fn<void, [PlaybackControlsState | null]>();

		registry.subscribePlayback(listener);

		expect(listener).toHaveBeenCalledWith(null);
	});

	it('resumes playback when the same key is re-acquired within the grace period', () => {
		jest.useFakeTimers();
		const harness = installMockAudio();
		try {
			const registry = new AudioPlayerRegistry();
			const key = playbackKey('rec.wav', null);
			registry.acquireAudio(key, 'app://rec');
			void harness.audio.play();
			expect(harness.play).toHaveBeenCalledTimes(1);

			// The last holder releases while playback was running: the element
			// is paused but kept alive for the grace window
			registry.releaseAudio(key);
			expect(harness.pause).toHaveBeenCalledTimes(1);

			// Re-acquiring within grace (a view-mode switch) resumes the same
			// element instead of starting a fresh one from the beginning
			jest.advanceTimersByTime(100);
			const reacquired = registry.acquireAudio(key, 'app://rec');
			expect(reacquired.isNew).toBe(false);
			expect(reacquired.audio).toBe(harness.audio);
			expect(harness.play).toHaveBeenCalledTimes(2);
		} finally {
			harness.restore();
			jest.useRealTimers();
		}
	});

	it('ignores releasing an audio key that was never acquired', () => {
		const registry = new AudioPlayerRegistry();
		expect(() => {
			registry.releaseAudio(playbackKey('missing.wav', null));
		}).not.toThrow();
	});

	it('refreshes the status snapshot on volume, duration, and metadata changes', () => {
		const harness = installMockAudio();
		try {
			const registry = new AudioPlayerRegistry();
			const listener = jest.fn<void, [PlaybackControlsState | null]>();
			const key = playbackKey('rec.wav', null);
			registry.subscribePlayback(listener);
			registry.acquireAudio(key, 'app://rec');
			void harness.audio.play();
			const before = listener.mock.calls.length;

			// Each media event on the active key republishes a fresh snapshot,
			// so the status bar reflects volume, duration, and metadata updates
			harness.audio.dispatchEvent(new Event('volumechange'));
			harness.audio.dispatchEvent(new Event('durationchange'));
			harness.audio.dispatchEvent(new Event('loadedmetadata'));

			expect(listener.mock.calls).toHaveLength(before + 3);
		} finally {
			harness.restore();
		}
	});

	it('reports whether a shared element exists for a key', () => {
		const registry = new AudioPlayerRegistry();
		const key = playbackKey('rec.wav', null);
		expect(registry.hasSharedAudio(key)).toBe(false);
		registry.acquireAudio(key, 'app://rec');
		expect(registry.hasSharedAudio(key)).toBe(true);
	});

	it('seeks the existing shared element so any embed stays in sync', () => {
		const harness = installMockAudio();
		Object.defineProperty(harness.audio, 'readyState', {
			configurable: true,
			get: () => 1,
		});
		try {
			const registry = new AudioPlayerRegistry();
			const key = playbackKey('rec.wav', null);
			registry.acquireAudio(key, 'app://rec');

			expect(registry.seekSharedAudio(key, 42)).toBe(true);
			expect(harness.audio.currentTime).toBe(42);
			expect(harness.play).toHaveBeenCalledTimes(1);
		} finally {
			harness.restore();
		}
	});

	it('returns false when seeking a key with no shared element', () => {
		const registry = new AudioPlayerRegistry();
		expect(
			registry.seekSharedAudio(playbackKey('missing.wav', null), 10),
		).toBe(false);
	});

	it('declines to seek a released element in its grace window', () => {
		jest.useFakeTimers();
		const harness = installMockAudio();
		Object.defineProperty(harness.audio, 'readyState', {
			configurable: true,
			get: () => 1,
		});
		try {
			const registry = new AudioPlayerRegistry();
			const key = playbackKey('rec.wav', null);
			registry.acquireAudio(key, 'app://rec');
			// Last holder releases: the element lingers for the grace window
			registry.releaseAudio(key);

			// A timecode seek during grace finds no live holder, so it declines
			// rather than reviving ownerless playback: the reuse must go through
			// a fresh acquire (the DetachedPlayback path) that takes a reference.
			expect(registry.seekSharedAudio(key, 12)).toBe(false);
			expect(harness.play).not.toHaveBeenCalled();

			// Since nothing re-acquired it, the grace release still tears it down
			jest.advanceTimersByTime(1000);
			expect(registry.hasSharedAudio(key)).toBe(false);
		} finally {
			harness.restore();
			jest.useRealTimers();
		}
	});

	it('reuses a grace-window element when an owner re-acquires it', () => {
		jest.useFakeTimers();
		const harness = installMockAudio();
		Object.defineProperty(harness.audio, 'readyState', {
			configurable: true,
			get: () => 1,
		});
		try {
			const registry = new AudioPlayerRegistry();
			const key = playbackKey('rec.wav', null);
			registry.acquireAudio(key, 'app://rec');
			registry.releaseAudio(key);

			// An owning re-acquire (what DetachedPlayback.start does) revives the
			// element with a reference and cancels the pending release, so it is
			// now seekable in place and survives past the grace window
			const { isNew } = registry.acquireAudio(key, 'app://rec');
			expect(isNew).toBe(false);
			expect(registry.seekSharedAudio(key, 12)).toBe(true);

			jest.advanceTimersByTime(1000);
			expect(registry.hasSharedAudio(key)).toBe(true);
			expect(harness.audio.currentTime).toBe(12);
		} finally {
			harness.restore();
			jest.useRealTimers();
		}
	});
});
