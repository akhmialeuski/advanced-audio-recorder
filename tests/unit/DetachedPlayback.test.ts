/**
 * Tests for note-independent timecode playback surfaced through the status bar.
 * @jest-environment jsdom
 */

import type { App, TFile } from 'obsidian';
import {
	AudioPlayerRegistry,
	playbackKey,
} from 'src/player/AudioPlayerRegistry';
import { DetachedPlayback } from 'src/player/DetachedPlayback';
import type { PlaybackControlsState } from 'src/player/playbackControls';

/** Controllable media element installed as the global Audio factory. */
interface MockAudioHarness {
	audio: HTMLAudioElement;
	play: jest.SpyInstance<Promise<void>, []>;
	pause: jest.SpyInstance<void, []>;
	/** Sets the reported readyState so metadata can be made available late. */
	setReadyState(value: number): void;
	/** Sets the duration and emits durationchange, as a resolved probe would. */
	setDuration(value: number): void;
	restore(): void;
}

/**
 * Installs a deterministic HTMLAudioElement whose play and pause synchronously
 * emit the matching media events, mirroring the registry test harness.
 * @param duration - Finite media duration in seconds
 * @param readyState - Initial readyState (1 means metadata is available)
 * @returns Audio element, spies, readyState control, and cleanup
 */
function installMockAudio(duration = 120, readyState = 1): MockAudioHarness {
	const audio = document.createElement('audio');
	let paused = true;
	let currentTime = 0;
	let ready = readyState;
	let length = duration;
	Object.defineProperties(audio, {
		paused: { configurable: true, get: () => paused },
		currentTime: {
			configurable: true,
			get: () => currentTime,
			set: (value: number) => {
				currentTime = value;
			},
		},
		duration: { configurable: true, get: () => length },
		readyState: { configurable: true, get: () => ready },
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
		setReadyState: (value: number) => {
			ready = value;
		},
		setDuration: (value: number) => {
			length = value;
			audio.dispatchEvent(new Event('durationchange'));
		},
		restore: () => {
			audioConstructor.mockRestore();
			load.mockRestore();
			pause.mockRestore();
			play.mockRestore();
		},
	};
}

/** App stub exposing only the media resource lookup DetachedPlayback needs. */
function appStub(): App {
	return {
		vault: { getResourcePath: () => 'app://rec' },
	} as unknown as App;
}

/** Audio file stub with the path DetachedPlayback keys its playback on. */
function fileStub(path = 'rec.mp4'): TFile {
	return { path } as unknown as TFile;
}

describe('DetachedPlayback', () => {
	it('plays from the timecode and surfaces status-bar controls without markers', () => {
		const harness = installMockAudio();
		try {
			const registry = new AudioPlayerRegistry();
			const listener = jest.fn<void, [PlaybackControlsState | null]>();
			registry.subscribePlayback(listener);

			const onDispose = jest.fn();
			DetachedPlayback.start(
				registry,
				appStub(),
				fileStub(),
				30,
				onDispose,
			);

			expect(harness.audio.currentTime).toBe(30);
			expect(harness.play).toHaveBeenCalledTimes(1);
			const state = listener.mock.lastCall?.[0];
			expect(state).toEqual(
				expect.objectContaining({
					currentTime: 30,
					duration: 120,
					paused: false,
					markersEnabled: false,
				}),
			);
			// A detached playback has no marker UI, so add-marker is inert
			state?.onAddMarker('bookmark');
			expect(onDispose).not.toHaveBeenCalled();
		} finally {
			harness.restore();
		}
	});

	it('delegates transport, mute, and volume to the shared audio', () => {
		const harness = installMockAudio();
		try {
			const registry = new AudioPlayerRegistry();
			const listener = jest.fn<void, [PlaybackControlsState | null]>();
			registry.subscribePlayback(listener);
			DetachedPlayback.start(
				registry,
				appStub(),
				fileStub(),
				30,
				jest.fn(),
			);

			let state = listener.mock.lastCall?.[0];
			state?.onSkip(-10);
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
			state?.onTogglePlay();
			expect(harness.pause).toHaveBeenCalled();
		} finally {
			harness.restore();
		}
	});

	it('stops by resetting the position, disposing, and dismissing the controls', () => {
		jest.useFakeTimers();
		const harness = installMockAudio();
		try {
			const registry = new AudioPlayerRegistry();
			const listener = jest.fn<void, [PlaybackControlsState | null]>();
			registry.subscribePlayback(listener);
			const onDispose = jest.fn();
			DetachedPlayback.start(
				registry,
				appStub(),
				fileStub(),
				30,
				onDispose,
			);

			listener.mock.lastCall?.[0]?.onStop();

			expect(harness.audio.currentTime).toBe(0);
			expect(harness.pause).toHaveBeenCalled();
			expect(onDispose).toHaveBeenCalledTimes(1);
			expect(listener.mock.lastCall?.[0]).toBeNull();

			// The shared element is torn down after the release grace period
			jest.advanceTimersByTime(1000);
			expect(
				registry.acquireAudio(playbackKey('rec.mp4', null), 'app://rec')
					.isNew,
			).toBe(true);
		} finally {
			harness.restore();
			jest.useRealTimers();
		}
	});

	it('disposes and dismisses the controls when the media ends', () => {
		const harness = installMockAudio();
		try {
			const registry = new AudioPlayerRegistry();
			const listener = jest.fn<void, [PlaybackControlsState | null]>();
			registry.subscribePlayback(listener);
			const onDispose = jest.fn();
			DetachedPlayback.start(
				registry,
				appStub(),
				fileStub(),
				30,
				onDispose,
			);

			harness.audio.dispatchEvent(new Event('ended'));

			expect(onDispose).toHaveBeenCalledTimes(1);
			expect(listener.mock.lastCall?.[0]).toBeNull();
		} finally {
			harness.restore();
		}
	});

	it('reuses the same playback when sought again', () => {
		const harness = installMockAudio();
		try {
			const registry = new AudioPlayerRegistry();
			const playback = DetachedPlayback.start(
				registry,
				appStub(),
				fileStub(),
				30,
				jest.fn(),
			);
			expect(harness.play).toHaveBeenCalledTimes(1);

			playback.seek(60);

			expect(harness.audio.currentTime).toBe(60);
			expect(harness.play).toHaveBeenCalledTimes(2);
		} finally {
			harness.restore();
		}
	});

	it('waits for metadata before seeking when the duration is unknown', () => {
		const harness = installMockAudio(120, 0);
		try {
			const registry = new AudioPlayerRegistry();
			DetachedPlayback.start(
				registry,
				appStub(),
				fileStub(),
				45,
				jest.fn(),
			);

			// Nothing plays until the element reports metadata
			expect(harness.play).not.toHaveBeenCalled();

			harness.setReadyState(1);
			harness.audio.dispatchEvent(new Event('loadedmetadata'));

			expect(harness.audio.currentTime).toBe(45);
			expect(harness.play).toHaveBeenCalledTimes(1);
		} finally {
			harness.restore();
		}
	});

	it('ignores a seek after disposal', () => {
		const harness = installMockAudio();
		try {
			const registry = new AudioPlayerRegistry();
			const playback = DetachedPlayback.start(
				registry,
				appStub(),
				fileStub(),
				30,
				jest.fn(),
			);
			playback.dispose();
			harness.play.mockClear();

			playback.seek(60);

			expect(harness.play).not.toHaveBeenCalled();
		} finally {
			harness.restore();
		}
	});

	it('resumes playback from the status bar after a pause', () => {
		const harness = installMockAudio();
		try {
			const registry = new AudioPlayerRegistry();
			const listener = jest.fn<void, [PlaybackControlsState | null]>();
			registry.subscribePlayback(listener);
			DetachedPlayback.start(
				registry,
				appStub(),
				fileStub(),
				30,
				jest.fn(),
			);

			listener.mock.lastCall?.[0]?.onTogglePlay();
			expect(harness.pause).toHaveBeenCalledTimes(1);
			listener.mock.lastCall?.[0]?.onTogglePlay();
			expect(harness.play).toHaveBeenCalledTimes(2);
		} finally {
			harness.restore();
		}
	});

	it('probes for a real duration before seeking a stream that loads without one', () => {
		// A multitrack mp4 that reports Infinity until probed: the offset is
		// deferred until the probe restores a real length, so the status bar
		// and any embed show a real total instead of 0:00
		const harness = installMockAudio(Number.POSITIVE_INFINITY, 1);
		try {
			const registry = new AudioPlayerRegistry();
			const listener = jest.fn<void, [PlaybackControlsState | null]>();
			registry.subscribePlayback(listener);
			DetachedPlayback.start(
				registry,
				appStub(),
				fileStub(),
				30,
				jest.fn(),
			);

			// Nothing plays while the length is still unknown
			expect(harness.play).not.toHaveBeenCalled();

			// The far-seek probe coaxes out the real duration, which restores
			// the start and then applies the deferred offset
			harness.setDuration(3600);

			expect(harness.audio.currentTime).toBe(30);
			expect(harness.play).toHaveBeenCalledTimes(1);
			expect(listener.mock.lastCall?.[0]?.duration).toBe(3600);
		} finally {
			harness.restore();
		}
	});

	it('tears down only once when disposed repeatedly', () => {
		const harness = installMockAudio();
		try {
			const registry = new AudioPlayerRegistry();
			const onDispose = jest.fn();
			const playback = DetachedPlayback.start(
				registry,
				appStub(),
				fileStub(),
				30,
				onDispose,
			);

			playback.dispose();
			playback.dispose();

			expect(onDispose).toHaveBeenCalledTimes(1);
		} finally {
			harness.restore();
		}
	});
});
