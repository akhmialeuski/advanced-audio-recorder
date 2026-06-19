/**
 * Tests for the live audio player registry used by timecode links.
 */

import {
	AudioPlayerRegistry,
	type SeekablePlayer,
} from 'src/player/AudioPlayerRegistry';
import type { ResolvedPlayerSettings } from 'src/settings/Settings';

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

describe('AudioPlayerRegistry', () => {
	it('seeks every registered player for a path', () => {
		const registry = new AudioPlayerRegistry();
		const a = makePlayer();
		const b = makePlayer();
		registry.register('rec.wav', a);
		registry.register('rec.wav', b);

		expect(registry.seek('rec.wav', 42)).toBe(true);
		expect(a.seeks).toEqual([42]);
		expect(b.seeks).toEqual([42]);
	});

	it('returns false when no player is registered for the path', () => {
		const registry = new AudioPlayerRegistry();
		expect(registry.seek('missing.wav', 10)).toBe(false);
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
});
