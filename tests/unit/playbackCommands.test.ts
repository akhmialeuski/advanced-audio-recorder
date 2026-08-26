/**
 * Tests for the single source of truth for audio playback commands.
 * @jest-environment jsdom
 */

import {
	playAudio,
	readPlaybackSnapshot,
	resetPlayback,
	seekAudio,
	setAudioPlaybackRate,
	setAudioVolume,
	skipAudio,
	toggleAudioMuted,
	togglePlayback,
} from 'src/player/playbackCommands';
import { installControlledAudio } from '../helpers/mediaMocks';

describe('playAudio', () => {
	it('starts playback', () => {
		const fake = installControlledAudio({
			duration: 100,
			asConstructor: false,
		});
		playAudio(fake.audio);
		expect(fake.play).toHaveBeenCalledTimes(1);
	});

	it('routes a rejected play to the handler', async () => {
		const fake = installControlledAudio({
			duration: 100,
			asConstructor: false,
		});
		fake.play.mockRejectedValueOnce(new Error('blocked'));
		const onError = jest.fn();
		playAudio(fake.audio, onError);
		await Promise.resolve();
		expect(onError).toHaveBeenCalledTimes(1);
	});
});

describe('togglePlayback', () => {
	it('plays when paused and pauses when playing', () => {
		const fake = installControlledAudio({
			duration: 100,
			asConstructor: false,
		});
		togglePlayback(fake.audio);
		expect(fake.play).toHaveBeenCalledTimes(1);
		togglePlayback(fake.audio);
		expect(fake.pause).toHaveBeenCalledTimes(1);
	});
});

describe('resetPlayback', () => {
	it('pauses and rewinds to the start', () => {
		const fake = installControlledAudio({
			duration: 100,
			asConstructor: false,
		});
		fake.audio.currentTime = 42;
		resetPlayback(fake.audio);
		expect(fake.pause).toHaveBeenCalledTimes(1);
		expect(fake.audio.currentTime).toBe(0);
	});
});

describe('skipAudio', () => {
	it('clamps to the track bounds with a known duration', () => {
		const fake = installControlledAudio({
			duration: 100,
			asConstructor: false,
		});
		fake.audio.currentTime = 50;
		skipAudio(fake.audio, 10);
		expect(fake.audio.currentTime).toBe(60);
		skipAudio(fake.audio, 1000);
		expect(fake.audio.currentTime).toBe(100);
		skipAudio(fake.audio, -1000);
		expect(fake.audio.currentTime).toBe(0);
	});

	it('bounds a forward skip by the current position when the duration is unknown', () => {
		const fake = installControlledAudio({
			duration: Number.POSITIVE_INFINITY,
			asConstructor: false,
		});
		fake.audio.currentTime = 30;
		skipAudio(fake.audio, 10);
		expect(fake.audio.currentTime).toBe(40);
	});
});

describe('toggleAudioMuted', () => {
	it('flips the muted flag and returns the new value', () => {
		const fake = installControlledAudio({
			duration: 100,
			asConstructor: false,
		});
		expect(toggleAudioMuted(fake.audio)).toBe(true);
		expect(fake.audio.muted).toBe(true);
		expect(toggleAudioMuted(fake.audio)).toBe(false);
		expect(fake.audio.muted).toBe(false);
	});
});

describe('setAudioVolume', () => {
	it('applies the volume and reports no unmute when audible was already on', () => {
		const fake = installControlledAudio({
			duration: 100,
			asConstructor: false,
		});
		expect(setAudioVolume(fake.audio, 0.4)).toBe(false);
		expect(fake.audio.volume).toBe(0.4);
	});

	it('unmutes when raising the volume above zero while muted', () => {
		const fake = installControlledAudio({
			duration: 100,
			asConstructor: false,
		});
		fake.audio.muted = true;
		expect(setAudioVolume(fake.audio, 0.5)).toBe(true);
		expect(fake.audio.muted).toBe(false);
	});

	it('keeps muted when the requested volume is zero', () => {
		const fake = installControlledAudio({
			duration: 100,
			asConstructor: false,
		});
		fake.audio.muted = true;
		expect(setAudioVolume(fake.audio, 0)).toBe(false);
		expect(fake.audio.muted).toBe(true);
	});
});

describe('setAudioPlaybackRate', () => {
	it('applies the rate to the element', () => {
		const fake = installControlledAudio({
			duration: 100,
			asConstructor: false,
		});
		setAudioPlaybackRate(fake.audio, 1.5);
		expect(fake.audio.playbackRate).toBe(1.5);
	});
});

describe('seekAudio', () => {
	it('seeks, autoplays, and runs the applied hook when metadata is ready', () => {
		const fake = installControlledAudio({
			duration: 100,
			asConstructor: false,
		});
		const onApplied = jest.fn();
		seekAudio(fake.audio, 30, { autoplay: true, onApplied });
		expect(fake.audio.currentTime).toBe(30);
		expect(fake.play).toHaveBeenCalledTimes(1);
		expect(onApplied).toHaveBeenCalledTimes(1);
	});

	it('clamps the target to a known duration', () => {
		const fake = installControlledAudio({
			duration: 100,
			asConstructor: false,
		});
		seekAudio(fake.audio, 500, { autoplay: false });
		expect(fake.audio.currentTime).toBe(100);
	});

	it('defers the seek until metadata loads', () => {
		const fake = installControlledAudio({
			duration: 100,
			readyState: 0,
			asConstructor: false,
		});
		seekAudio(fake.audio, 45, { autoplay: true });
		expect(fake.audio.currentTime).toBe(0);
		expect(fake.play).not.toHaveBeenCalled();

		fake.setReadyState(1);
		fake.audio.dispatchEvent(new Event('loadedmetadata'));
		expect(fake.audio.currentTime).toBe(45);
		expect(fake.play).toHaveBeenCalledTimes(1);
	});

	it('does not autoplay when autoplay is off', () => {
		const fake = installControlledAudio({
			duration: 100,
			asConstructor: false,
		});
		seekAudio(fake.audio, 10, { autoplay: false });
		expect(fake.play).not.toHaveBeenCalled();
	});
});

describe('readPlaybackSnapshot', () => {
	it('reads the live element state', () => {
		const fake = installControlledAudio({
			duration: 100,
			asConstructor: false,
		});
		fake.audio.currentTime = 12;
		fake.audio.volume = 0.6;
		fake.audio.playbackRate = 1.25;
		expect(readPlaybackSnapshot(fake.audio)).toEqual({
			currentTime: 12,
			duration: 100,
			paused: true,
			volume: 0.6,
			muted: false,
			playbackRate: 1.25,
		});
	});

	it('folds an unusable duration to zero', () => {
		expect(
			readPlaybackSnapshot(
				installControlledAudio({
					duration: Infinity,
					asConstructor: false,
				}).audio,
			).duration,
		).toBe(0);
		expect(
			readPlaybackSnapshot(
				installControlledAudio({ duration: 0, asConstructor: false })
					.audio,
			).duration,
		).toBe(0);
	});
});
