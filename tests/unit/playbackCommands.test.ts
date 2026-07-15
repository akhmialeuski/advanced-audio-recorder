/**
 * Tests for the single source of truth for audio playback commands.
 * @jest-environment jsdom
 */

import {
	playAudio,
	readPlaybackSnapshot,
	resetPlayback,
	seekAudio,
	setAudioVolume,
	skipAudio,
	toggleAudioMuted,
	togglePlayback,
} from 'src/player/playbackCommands';

/** Controllable audio whose play/pause emit events and track paused state. */
interface FakeAudio {
	audio: HTMLAudioElement;
	play: jest.SpyInstance<Promise<void>, []>;
	pause: jest.SpyInstance<void, []>;
	setReady(value: number): void;
}

function makeAudio(duration = 100, readyState = 1): FakeAudio {
	const el = document.createElement('audio');
	let paused = true;
	let currentTime = 0;
	let ready = readyState;
	Object.defineProperties(el, {
		paused: { configurable: true, get: () => paused },
		currentTime: {
			configurable: true,
			get: () => currentTime,
			set: (value: number) => {
				currentTime = value;
			},
		},
		duration: { configurable: true, get: () => duration },
		readyState: { configurable: true, get: () => ready },
	});
	const play = jest.spyOn(el, 'play').mockImplementation(() => {
		paused = false;
		return Promise.resolve();
	});
	const pause = jest.spyOn(el, 'pause').mockImplementation(() => {
		paused = true;
	});
	return {
		audio: el,
		play,
		pause,
		setReady: (value: number) => {
			ready = value;
		},
	};
}

describe('playAudio', () => {
	it('starts playback', () => {
		const fake = makeAudio();
		playAudio(fake.audio);
		expect(fake.play).toHaveBeenCalledTimes(1);
	});

	it('routes a rejected play to the handler', async () => {
		const fake = makeAudio();
		fake.play.mockRejectedValueOnce(new Error('blocked'));
		const onError = jest.fn();
		playAudio(fake.audio, onError);
		await Promise.resolve();
		expect(onError).toHaveBeenCalledTimes(1);
	});
});

describe('togglePlayback', () => {
	it('plays when paused and pauses when playing', () => {
		const fake = makeAudio();
		togglePlayback(fake.audio);
		expect(fake.play).toHaveBeenCalledTimes(1);
		togglePlayback(fake.audio);
		expect(fake.pause).toHaveBeenCalledTimes(1);
	});
});

describe('resetPlayback', () => {
	it('pauses and rewinds to the start', () => {
		const fake = makeAudio();
		fake.audio.currentTime = 42;
		resetPlayback(fake.audio);
		expect(fake.pause).toHaveBeenCalledTimes(1);
		expect(fake.audio.currentTime).toBe(0);
	});
});

describe('skipAudio', () => {
	it('clamps to the track bounds with a known duration', () => {
		const fake = makeAudio(100);
		fake.audio.currentTime = 50;
		skipAudio(fake.audio, 10);
		expect(fake.audio.currentTime).toBe(60);
		skipAudio(fake.audio, 1000);
		expect(fake.audio.currentTime).toBe(100);
		skipAudio(fake.audio, -1000);
		expect(fake.audio.currentTime).toBe(0);
	});

	it('bounds a forward skip by the current position when the duration is unknown', () => {
		const fake = makeAudio(Number.POSITIVE_INFINITY);
		fake.audio.currentTime = 30;
		skipAudio(fake.audio, 10);
		expect(fake.audio.currentTime).toBe(40);
	});
});

describe('toggleAudioMuted', () => {
	it('flips the muted flag and returns the new value', () => {
		const fake = makeAudio();
		expect(toggleAudioMuted(fake.audio)).toBe(true);
		expect(fake.audio.muted).toBe(true);
		expect(toggleAudioMuted(fake.audio)).toBe(false);
		expect(fake.audio.muted).toBe(false);
	});
});

describe('setAudioVolume', () => {
	it('applies the volume and reports no unmute when audible was already on', () => {
		const fake = makeAudio();
		expect(setAudioVolume(fake.audio, 0.4)).toBe(false);
		expect(fake.audio.volume).toBe(0.4);
	});

	it('unmutes when raising the volume above zero while muted', () => {
		const fake = makeAudio();
		fake.audio.muted = true;
		expect(setAudioVolume(fake.audio, 0.5)).toBe(true);
		expect(fake.audio.muted).toBe(false);
	});

	it('keeps muted when the requested volume is zero', () => {
		const fake = makeAudio();
		fake.audio.muted = true;
		expect(setAudioVolume(fake.audio, 0)).toBe(false);
		expect(fake.audio.muted).toBe(true);
	});
});

describe('seekAudio', () => {
	it('seeks, autoplays, and runs the applied hook when metadata is ready', () => {
		const fake = makeAudio(100);
		const onApplied = jest.fn();
		seekAudio(fake.audio, 30, { autoplay: true, onApplied });
		expect(fake.audio.currentTime).toBe(30);
		expect(fake.play).toHaveBeenCalledTimes(1);
		expect(onApplied).toHaveBeenCalledTimes(1);
	});

	it('clamps the target to a known duration', () => {
		const fake = makeAudio(100);
		seekAudio(fake.audio, 500, { autoplay: false });
		expect(fake.audio.currentTime).toBe(100);
	});

	it('defers the seek until metadata loads', () => {
		const fake = makeAudio(100, 0);
		seekAudio(fake.audio, 45, { autoplay: true });
		expect(fake.audio.currentTime).toBe(0);
		expect(fake.play).not.toHaveBeenCalled();

		fake.setReady(1);
		fake.audio.dispatchEvent(new Event('loadedmetadata'));
		expect(fake.audio.currentTime).toBe(45);
		expect(fake.play).toHaveBeenCalledTimes(1);
	});

	it('does not autoplay when autoplay is off', () => {
		const fake = makeAudio(100);
		seekAudio(fake.audio, 10, { autoplay: false });
		expect(fake.play).not.toHaveBeenCalled();
	});
});

describe('readPlaybackSnapshot', () => {
	it('reads the live element state', () => {
		const fake = makeAudio(100);
		fake.audio.currentTime = 12;
		fake.audio.volume = 0.6;
		expect(readPlaybackSnapshot(fake.audio)).toEqual({
			currentTime: 12,
			duration: 100,
			paused: true,
			volume: 0.6,
			muted: false,
		});
	});

	it('folds an unusable duration to zero', () => {
		expect(readPlaybackSnapshot(makeAudio(Infinity).audio).duration).toBe(
			0,
		);
		expect(readPlaybackSnapshot(makeAudio(0).audio).duration).toBe(0);
	});
});
