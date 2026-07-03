/**
 * Tests for the live audio player registry used by timecode links.
 */

import {
	AudioPlayerRegistry,
	playbackKey,
	type SeekablePlayer,
} from 'src/player/AudioPlayerRegistry';
import type { ResolvedPlayerSettings } from 'src/player/playerSettings';

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

	it('skips disconnected players when reloading markers', () => {
		const registry = new AudioPlayerRegistry();
		const source = makePlayer();
		const disconnected = makePlayer(false);
		registry.register('rec.wav', source);
		registry.register('rec.wav', disconnected);

		registry.reloadMarkers('rec.wav', source);
		expect(disconnected.reloads).toBe(0);
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
});
