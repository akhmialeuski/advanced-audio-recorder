/**
 * The single source of truth for playback commands on a shared audio element.
 * Every surface that drives playback - the embedded player, the status-bar
 * controls, and note-independent timecode playback - goes through these
 * functions, so play/pause, stop, skip, mute, volume, rate, and seek can
 * never behave differently between them. Each function operates only on the audio
 * element; view-specific side effects (progress redraw, control icons, the
 * #t= start hint) stay with the caller.
 * @module player/playbackCommands
 */

import { PLUGIN_LOG_PREFIX } from '../constants';

/** Normalized read of an audio element's state for a UI to render. */
export interface PlaybackSnapshot {
	/** Current position in seconds, never negative. */
	currentTime: number;
	/** Total duration in seconds, or 0 while unknown. */
	duration: number;
	/** Whether playback is paused. */
	paused: boolean;
	/** Current volume in the inclusive 0..1 range. */
	volume: number;
	/** Whether output is muted. */
	muted: boolean;
	/** Current playback rate multiplier. */
	playbackRate: number;
}

/** Options for {@link seekAudio}. */
export interface SeekOptions {
	/** Start playback once the seek is applied. */
	autoplay: boolean;
	/** Runs after the position is applied (e.g. to refresh a progress bar). */
	onApplied?: () => void;
	/** Handles an autoplay-policy rejection instead of the default warning. */
	onError?: (error: unknown) => void;
}

/**
 * Starts playback, swallowing autoplay-policy rejections so a blocked play
 * never throws. The default handler logs a warning; pass onError to override.
 * @param audio - The audio element to play
 * @param onError - Optional rejection handler
 */
export function playAudio(
	audio: HTMLAudioElement,
	onError?: (error: unknown) => void,
): void {
	void audio.play().catch((error: unknown) => {
		if (onError) {
			onError(error);
			return;
		}
		console.warn(`${PLUGIN_LOG_PREFIX} Playback could not start:`, error);
	});
}

/**
 * Toggles between play and pause.
 * @param audio - The audio element to toggle
 * @param onError - Optional rejection handler for the play path
 */
export function togglePlayback(
	audio: HTMLAudioElement,
	onError?: (error: unknown) => void,
): void {
	if (audio.paused) {
		playAudio(audio, onError);
	} else {
		audio.pause();
	}
}

/**
 * Stops playback and resets the position to the start.
 * @param audio - The audio element to reset
 */
export function resetPlayback(audio: HTMLAudioElement): void {
	audio.pause();
	audio.currentTime = 0;
}

/**
 * Skips playback by a signed number of seconds, clamped to the track bounds.
 * When the duration is unknown the forward bound is the current position plus
 * the skip, so a skip never strands playback past a not-yet-probed end.
 * @param audio - The audio element to skip
 * @param deltaSeconds - Signed number of seconds to skip
 */
export function skipAudio(audio: HTMLAudioElement, deltaSeconds: number): void {
	const max = Number.isFinite(audio.duration)
		? audio.duration
		: audio.currentTime + Math.abs(deltaSeconds);
	audio.currentTime = Math.min(
		max,
		Math.max(0, audio.currentTime + deltaSeconds),
	);
}

/**
 * Toggles muted output.
 * @param audio - The audio element to mute or unmute
 * @returns The new muted state
 */
export function toggleAudioMuted(audio: HTMLAudioElement): boolean {
	audio.muted = !audio.muted;
	return audio.muted;
}

/**
 * Applies a playback rate multiplier.
 * @param audio - The audio element to adjust
 * @param rate - Playback rate multiplier
 */
export function setAudioPlaybackRate(
	audio: HTMLAudioElement,
	rate: number,
): void {
	audio.playbackRate = rate;
}

/**
 * Applies a volume level, unmuting when the requested level is audible.
 * @param audio - The audio element to adjust
 * @param volume - Volume in the inclusive 0..1 range
 * @returns True when the change also unmuted the element
 */
export function setAudioVolume(
	audio: HTMLAudioElement,
	volume: number,
): boolean {
	audio.volume = volume;
	if (audio.muted && volume > 0) {
		audio.muted = false;
		return true;
	}
	return false;
}

/**
 * Seeks to an absolute offset, optionally starting playback. Waits for
 * metadata when the duration is not yet known, so a freshly loaded element
 * still lands at the requested position.
 * @param audio - The audio element to seek
 * @param seconds - Target offset in seconds
 * @param options - Autoplay and post-seek hooks
 */
export function seekAudio(
	audio: HTMLAudioElement,
	seconds: number,
	options: SeekOptions,
): void {
	const target = Math.max(0, seconds);
	const apply = (): void => {
		audio.currentTime = Number.isFinite(audio.duration)
			? Math.min(target, audio.duration)
			: target;
		if (options.autoplay) {
			playAudio(audio, options.onError);
		}
		options.onApplied?.();
	};
	if (audio.readyState >= 1) {
		apply();
	} else {
		audio.addEventListener('loadedmetadata', apply, { once: true });
	}
}

/**
 * Reads a normalized snapshot of an audio element, folding an unusable
 * duration (Infinity, NaN, or a non-positive value) to 0 so a UI can treat
 * "unknown" uniformly.
 * @param audio - The audio element to read
 * @returns The current playback snapshot
 */
export function readPlaybackSnapshot(
	audio: HTMLAudioElement,
): PlaybackSnapshot {
	const duration =
		Number.isFinite(audio.duration) && audio.duration > 0
			? audio.duration
			: 0;
	const currentTime = Number.isFinite(audio.currentTime)
		? Math.max(0, audio.currentTime)
		: 0;
	return {
		currentTime,
		duration,
		paused: audio.paused,
		volume: audio.volume,
		muted: audio.muted,
		playbackRate: audio.playbackRate,
	};
}
