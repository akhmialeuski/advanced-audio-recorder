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
import { at } from '../helpers/assertions';
import { partial } from '../helpers/doubles';
import { createMockApp } from '../helpers/createApp';
import { installControlledAudio } from '../helpers/mediaMocks';
import { tick } from '../helpers/async';

/** App stub exposing only the media resource lookup DetachedPlayback needs. */
function appStub(): App {
	return createMockApp({
		vault: { getResourcePath: () => 'app://rec' },
	}).app;
}

/** Audio file stub with the path DetachedPlayback keys its playback on. */
function fileStub(path = 'rec.mp4'): TFile {
	return partial<TFile>({ path });
}

describe('DetachedPlayback', () => {
	it('plays from the timecode and surfaces status-bar controls without markers', () => {
		const harness = installControlledAudio();
		const registry = new AudioPlayerRegistry();
		const listener = jest.fn<void, [PlaybackControlsState | null]>();
		registry.subscribePlayback(listener);

		const onDispose = jest.fn();
		DetachedPlayback.start(registry, appStub(), fileStub(), 30, onDispose);

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
		// A detached playback has no marker UI, so add-marker and the
		// chapter jumps it would navigate are inert
		expect(state?.chaptersEnabled).toBe(false);
		state?.onAddMarker('bookmark');
		state?.onPreviousChapter();
		state?.onNextChapter();
		expect(harness.audio.currentTime).toBe(30);
		expect(onDispose).not.toHaveBeenCalled();
	});

	it('answers the operations it cannot perform without moving', () => {
		const harness = installControlledAudio();
		const registry = new AudioPlayerRegistry();
		const registered = jest.spyOn(registry, 'registerPlaybackController');
		DetachedPlayback.start(registry, appStub(), fileStub(), 30, jest.fn());

		// The registry withholds these from the snapshot, but the contract
		// still has to answer them: a controller that threw would break the
		// surface the moment the gating changed.
		const controller = at(registered.mock.calls, 0)[1];
		controller.addMarker('bookmark');
		controller.previousChapter();
		controller.nextChapter();

		expect(controller.canAddMarkers()).toBe(false);
		expect(controller.canNavigateChapters()).toBe(false);
		expect(harness.audio.currentTime).toBe(30);
	});

	it('delegates transport, mute, volume, and speed to the shared audio', () => {
		const harness = installControlledAudio();
		const registry = new AudioPlayerRegistry();
		const listener = jest.fn<void, [PlaybackControlsState | null]>();
		registry.subscribePlayback(listener);
		DetachedPlayback.start(registry, appStub(), fileStub(), 30, jest.fn());

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
		state?.onSetPlaybackRate(1.5);
		expect(harness.audio.playbackRate).toBe(1.5);
		state = listener.mock.lastCall?.[0];
		state?.onTogglePlay();
		expect(harness.pause).toHaveBeenCalled();
	});

	it('stops by resetting the position, disposing, and dismissing the controls', () => {
		jest.useFakeTimers();
		const harness = installControlledAudio();
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
			jest.useRealTimers();
		}
	});

	it('disposes and dismisses the controls when the media ends', () => {
		const harness = installControlledAudio();
		const registry = new AudioPlayerRegistry();
		const listener = jest.fn<void, [PlaybackControlsState | null]>();
		registry.subscribePlayback(listener);
		const onDispose = jest.fn();
		DetachedPlayback.start(registry, appStub(), fileStub(), 30, onDispose);

		harness.audio.dispatchEvent(new Event('ended'));

		expect(onDispose).toHaveBeenCalledTimes(1);
		expect(listener.mock.lastCall?.[0]).toBeNull();
	});

	it('reuses the same playback when sought again', () => {
		const harness = installControlledAudio();
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
	});

	it('waits for metadata before seeking when the duration is unknown', () => {
		const harness = installControlledAudio({
			duration: 120,
			readyState: 0,
		});
		const registry = new AudioPlayerRegistry();
		DetachedPlayback.start(registry, appStub(), fileStub(), 45, jest.fn());

		// Nothing plays until the element reports metadata
		expect(harness.play).not.toHaveBeenCalled();

		harness.setReadyState(1);
		harness.audio.dispatchEvent(new Event('loadedmetadata'));

		expect(harness.audio.currentTime).toBe(45);
		expect(harness.play).toHaveBeenCalledTimes(1);
	});

	it('ignores a seek after disposal', () => {
		const harness = installControlledAudio();
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
	});

	it('resumes playback from the status bar after a pause', () => {
		const harness = installControlledAudio();
		const registry = new AudioPlayerRegistry();
		const listener = jest.fn<void, [PlaybackControlsState | null]>();
		registry.subscribePlayback(listener);
		DetachedPlayback.start(registry, appStub(), fileStub(), 30, jest.fn());

		listener.mock.lastCall?.[0]?.onTogglePlay();
		expect(harness.pause).toHaveBeenCalledTimes(1);
		listener.mock.lastCall?.[0]?.onTogglePlay();
		expect(harness.play).toHaveBeenCalledTimes(2);
	});

	it('probes for a real duration before seeking a stream that loads without one', () => {
		// A multitrack mp4 that reports Infinity until probed: the offset is
		// deferred until the probe restores a real length, so the status bar
		// and any embed show a real total instead of 0:00
		const harness = installControlledAudio({
			duration: Number.POSITIVE_INFINITY,
			readyState: 1,
		});
		const registry = new AudioPlayerRegistry();
		const listener = jest.fn<void, [PlaybackControlsState | null]>();
		registry.subscribePlayback(listener);
		DetachedPlayback.start(registry, appStub(), fileStub(), 30, jest.fn());

		// Nothing plays while the length is still unknown
		expect(harness.play).not.toHaveBeenCalled();

		// The far-seek probe coaxes out the real duration, which restores
		// the start and then applies the deferred offset
		harness.setDuration(3600);

		expect(harness.audio.currentTime).toBe(30);
		expect(harness.play).toHaveBeenCalledTimes(1);
		expect(listener.mock.lastCall?.[0]?.duration).toBe(3600);
	});

	// The user clicked a timecode link, so the browser's autoplay policy
	// should allow it; when it does not, the position is still right and the
	// status bar's play button works. It is a log, not a Notice.
	it('says why playback did not start rather than failing the seek', async () => {
		const harness = installControlledAudio();
		const warn = jest.spyOn(console, 'warn').mockImplementation();
		harness.blockAutoplay();
		const registry = new AudioPlayerRegistry();

		DetachedPlayback.start(registry, appStub(), fileStub(), 30, jest.fn());
		await tick();

		expect(harness.audio.currentTime).toBe(30);
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining('Detached playback could not start'),
			expect.any(Error),
		);
	});

	// A note closed while the probe was still coaxing a duration out of the
	// stream: the offset must not be applied to audio nobody is listening to.
	it('does not seek when the duration arrives after disposal', () => {
		const harness = installControlledAudio({
			duration: Number.POSITIVE_INFINITY,
			readyState: 1,
		});
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
		harness.setDuration(3600);

		expect(harness.play).not.toHaveBeenCalled();
	});

	// Metadata arrives for a playback that was already positioned; there is
	// no deferred offset left to apply, and re-applying one would restart it.
	it('does nothing on metadata when nothing is waiting to be sought', () => {
		const harness = installControlledAudio();
		const registry = new AudioPlayerRegistry();
		DetachedPlayback.start(registry, appStub(), fileStub(), 30, jest.fn());
		harness.play.mockClear();

		harness.loadMetadata();

		expect(harness.play).not.toHaveBeenCalled();
		expect(harness.audio.currentTime).toBe(30);
	});

	// Metadata that arrives with a usable length applies the deferred offset
	// straight away instead of paying for a probe.
	it('applies the deferred offset on metadata without probing', () => {
		const harness = installControlledAudio({
			duration: 120,
			readyState: 0,
		});
		const registry = new AudioPlayerRegistry();
		DetachedPlayback.start(registry, appStub(), fileStub(), 45, jest.fn());

		harness.loadMetadata();

		expect(harness.audio.currentTime).toBe(45);
		expect(harness.load).not.toHaveBeenCalled();
	});

	it('tears down only once when disposed repeatedly', () => {
		installControlledAudio();
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
	});
});
