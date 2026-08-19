/**
 * Tests for the rename dialog's excerpt player: lazy media creation, seeking to
 * the excerpt and playing, stopping at its end on its own, toggling the same
 * excerpt off, switching between excerpts, a blocked autoplay, and teardown.
 * @jest-environment jsdom
 */

import { SpeakerPreviewPlayer } from 'src/player/SpeakerPreviewPlayer';
import { installControlledAudio } from '../helpers/mediaMocks';
import type { ControlledAudio } from '../helpers/mediaMocks';

/** A player plus the change notifications it emitted, in order. */
function makePlayer(
	harness: ControlledAudio,
	src = 'app://vault/audio/rec.wav',
): { player: SpeakerPreviewPlayer; changes: (string | null)[] } {
	const changes: (string | null)[] = [];
	const player = new SpeakerPreviewPlayer(
		() => src,
		(id) => changes.push(id),
	);
	// Referenced so an unused-parameter lint cannot hide a broken harness.
	expect(harness.constructions()).toBe(0);
	return { player, changes };
}

describe('SpeakerPreviewPlayer', () => {
	let harness: ControlledAudio;

	beforeEach(() => {
		harness = installControlledAudio({ duration: 300 });
	});

	afterEach(() => {});

	it('builds no media element until the first excerpt is played', () => {
		const { player } = makePlayer(harness);
		player.stop();
		expect(harness.constructions()).toBe(0);
		expect(player.playingId).toBeNull();

		player.toggle('Speaker 1', { start: 10, end: 20 });
		expect(harness.constructions()).toBe(1);
	});

	it('seeks to the excerpt start, plays, and reports what is playing', () => {
		const { player, changes } = makePlayer(harness);
		player.toggle('Speaker 1', { start: 10, end: 20 });

		expect(harness.audio.src).toContain('audio/rec.wav');
		expect(harness.audio.currentTime).toBe(10);
		expect(harness.play).toHaveBeenCalled();
		expect(player.playingId).toBe('Speaker 1');
		expect(changes).toEqual(['Speaker 1']);
	});

	it('stops on its own once the excerpt ends', () => {
		const { player, changes } = makePlayer(harness);
		player.toggle('Speaker 1', { start: 10, end: 20 });

		harness.advanceTo(15);
		expect(player.playingId).toBe('Speaker 1');

		harness.advanceTo(20);
		expect(player.playingId).toBeNull();
		expect(harness.pause).toHaveBeenCalled();
		expect(changes).toEqual(['Speaker 1', null]);
	});

	it('does not keep stopping after the excerpt already stopped', () => {
		const { player, changes } = makePlayer(harness);
		player.toggle('Speaker 1', { start: 10, end: 20 });
		harness.advanceTo(20);
		harness.advanceTo(25);

		expect(changes).toEqual(['Speaker 1', null]);
	});

	it('toggles the playing excerpt off on a second press', () => {
		const { player, changes } = makePlayer(harness);
		player.toggle('Speaker 1', { start: 10, end: 20 });
		player.toggle('Speaker 1', { start: 10, end: 20 });

		expect(player.playingId).toBeNull();
		// Stop rewinds, so the next press starts the excerpt cleanly.
		expect(harness.audio.currentTime).toBe(0);
		expect(changes).toEqual(['Speaker 1', null]);
	});

	it('switching excerpts reuses the one element and re-seeks', () => {
		const { player, changes } = makePlayer(harness);
		player.toggle('Speaker 1', { start: 10, end: 20 });
		player.toggle('Speaker 2', { start: 40, end: 50 });

		expect(harness.constructions()).toBe(1);
		expect(harness.audio.currentTime).toBe(40);
		expect(player.playingId).toBe('Speaker 2');
		expect(changes).toEqual(['Speaker 1', 'Speaker 2']);
	});

	it('the previous excerpt no longer stops the new one', () => {
		const { player } = makePlayer(harness);
		player.toggle('Speaker 1', { start: 10, end: 20 });
		player.toggle('Speaker 2', { start: 40, end: 60 });

		// Past the FIRST excerpt's end but inside the second: still playing.
		harness.advanceTo(45);
		expect(player.playingId).toBe('Speaker 2');

		harness.advanceTo(60);
		expect(player.playingId).toBeNull();
	});

	describe('while the file is still loading its metadata', () => {
		// A freshly built element reports readyState 0, so the very first press
		// always waits. Everything the user does in that window has to survive.
		let loading: ControlledAudio;

		beforeEach(() => {
			loading = installControlledAudio({ duration: 300, readyState: 0 });
			harness = loading;
		});

		it('starts the excerpt once the metadata arrives', () => {
			const { player, changes } = makePlayer(loading);
			player.toggle('Speaker 1', { start: 12, end: 20 });

			// Nothing can seek yet, but the button already reads as playing.
			expect(loading.play).not.toHaveBeenCalled();
			expect(player.playingId).toBe('Speaker 1');
			expect(changes).toEqual(['Speaker 1']);

			loading.loadMetadata();
			expect(loading.audio.currentTime).toBe(12);
			expect(loading.play).toHaveBeenCalled();
		});

		it('a stop pressed while loading is not overtaken by its own start', () => {
			// The regression this guards: a deferred seek that fires after the
			// user stopped would play on unbounded, with every button showing
			// "play" and no way to stop it.
			const { player, changes } = makePlayer(loading);
			player.toggle('Speaker 1', { start: 12, end: 20 });
			player.toggle('Speaker 1', { start: 12, end: 20 });
			expect(player.playingId).toBeNull();

			loading.loadMetadata();

			expect(loading.play).not.toHaveBeenCalled();
			expect(player.playingId).toBeNull();
			expect(changes).toEqual(['Speaker 1', null]);
		});

		it('only the last excerpt pressed while loading starts', () => {
			const { player } = makePlayer(loading);
			player.toggle('Speaker 1', { start: 12, end: 20 });
			player.toggle('Speaker 2', { start: 40, end: 50 });

			loading.loadMetadata();

			// One seek, to the excerpt that was actually pending.
			expect(loading.play).toHaveBeenCalledTimes(1);
			expect(loading.audio.currentTime).toBe(40);
			expect(player.playingId).toBe('Speaker 2');
		});

		it('still bounds the excerpt that a late start began', () => {
			const { player } = makePlayer(loading);
			player.toggle('Speaker 1', { start: 12, end: 20 });
			loading.loadMetadata();

			loading.advanceTo(20);
			expect(player.playingId).toBeNull();
		});

		it('a dispose while loading starts nothing afterwards', () => {
			const { player } = makePlayer(loading);
			player.toggle('Speaker 1', { start: 12, end: 20 });
			player.dispose();

			loading.loadMetadata();

			expect(loading.play).not.toHaveBeenCalled();
			expect(player.playingId).toBeNull();
		});
	});

	it('stops when the file ends before the excerpt does', () => {
		const { player } = makePlayer(harness);
		player.toggle('Speaker 1', { start: 290, end: 305 });
		harness.audio.dispatchEvent(new Event('ended'));

		expect(player.playingId).toBeNull();
	});

	it('reports nothing playing when autoplay is blocked', async () => {
		// A rejected play() must not leave a button stuck showing stop.
		const warn = jest
			.spyOn(console, 'warn')
			.mockImplementation(() => undefined);
		harness.blockAutoplay();
		const { player, changes } = makePlayer(harness);
		player.toggle('Speaker 1', { start: 10, end: 20 });
		await Promise.resolve();
		await Promise.resolve();

		expect(player.playingId).toBeNull();
		expect(changes).toEqual(['Speaker 1', null]);
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining('Speaker preview could not start'),
			expect.anything(),
		);
	});

	it('dispose stops playback and releases the element', () => {
		const { player, changes } = makePlayer(harness);
		player.toggle('Speaker 1', { start: 10, end: 20 });
		player.dispose();

		expect(player.playingId).toBeNull();
		expect(harness.pause).toHaveBeenCalled();
		expect(harness.load).toHaveBeenCalled();
		expect(harness.audio.getAttribute('src')).toBeNull();
		expect(changes).toEqual(['Speaker 1', null]);
	});

	it('is inert after dispose, so a racing click starts no audio', () => {
		const { player } = makePlayer(harness);
		player.dispose();
		player.toggle('Speaker 1', { start: 10, end: 20 });

		expect(harness.constructions()).toBe(0);
		expect(player.playingId).toBeNull();
	});

	it('dispose is idempotent', () => {
		const { player } = makePlayer(harness);
		player.toggle('Speaker 1', { start: 10, end: 20 });
		player.dispose();
		player.dispose();

		expect(harness.load).toHaveBeenCalledTimes(1);
	});

	it('dispose without a play never builds an element', () => {
		const { player } = makePlayer(harness);
		player.dispose();

		expect(harness.constructions()).toBe(0);
		expect(harness.load).not.toHaveBeenCalled();
	});
});
