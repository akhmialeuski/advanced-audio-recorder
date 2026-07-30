/**
 * Tests for the rename dialog's excerpt player: lazy media creation, seeking to
 * the excerpt and playing, stopping at its end on its own, toggling the same
 * excerpt off, switching between excerpts, a blocked autoplay, and teardown.
 * @jest-environment jsdom
 */

import { SpeakerPreviewPlayer } from 'src/player/SpeakerPreviewPlayer';

/** Controllable media element installed as the global Audio factory. */
interface AudioHarness {
	audio: HTMLAudioElement;
	play: jest.SpyInstance<Promise<void>, []>;
	pause: jest.SpyInstance<void, []>;
	load: jest.SpyInstance<void, []>;
	/** Constructions of `new Audio()` observed so far. */
	constructions(): number;
	/** Moves the playhead and emits timeupdate, as playback would. */
	advanceTo(seconds: number): void;
	/** Makes the next play() reject, as an autoplay policy would. */
	blockPlayback(): void;
	restore(): void;
}

/**
 * Installs a deterministic audio element whose play/pause emit the matching
 * events and whose currentTime is observable, mirroring the other player suites.
 */
function installAudio(duration = 300): AudioHarness {
	const audio = document.createElement('audio');
	let paused = true;
	let currentTime = 0;
	let blocked = false;
	Object.defineProperties(audio, {
		paused: { configurable: true, get: () => paused },
		currentTime: {
			configurable: true,
			get: () => currentTime,
			set: (value: number) => {
				currentTime = value;
			},
		},
		duration: { configurable: true, get: () => duration },
		readyState: { configurable: true, get: () => 1 },
	});
	const play = jest.spyOn(audio, 'play').mockImplementation(() => {
		if (blocked) {
			return Promise.reject(new Error('autoplay blocked'));
		}
		paused = false;
		audio.dispatchEvent(new Event('play'));
		return Promise.resolve();
	});
	const pause = jest.spyOn(audio, 'pause').mockImplementation(() => {
		paused = true;
		audio.dispatchEvent(new Event('pause'));
	});
	const load = jest.spyOn(audio, 'load').mockImplementation(() => undefined);
	const factory = jest
		.spyOn(globalThis, 'Audio')
		.mockImplementation(() => audio);

	return {
		audio,
		play,
		pause,
		load,
		constructions: () => factory.mock.calls.length,
		advanceTo: (seconds: number) => {
			currentTime = seconds;
			audio.dispatchEvent(new Event('timeupdate'));
		},
		blockPlayback: () => {
			blocked = true;
		},
		restore: () => {
			factory.mockRestore();
		},
	};
}

/** A player plus the change notifications it emitted, in order. */
function makePlayer(
	harness: AudioHarness,
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
	let harness: AudioHarness;

	beforeEach(() => {
		harness = installAudio();
	});

	afterEach(() => {
		harness.restore();
	});

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
		harness.blockPlayback();
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
		warn.mockRestore();
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
