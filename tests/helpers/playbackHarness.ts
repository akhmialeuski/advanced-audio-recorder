/**
 * Shared harness for the player integration suites: one controllable audio
 * element installed as the global Audio factory, an in-memory sidecar store,
 * and the small readers both suites use. Extracted so PlaybackSync and the
 * pop-out suites drive the exact same real audio element instead of each
 * hand-rolling (and drifting) their own copy.
 * @module tests/helpers/playbackHarness
 */

import type { RecordingSidecarStore } from 'src/sidecar/RecordingSidecarStore';
import type { PlayerMarker } from 'src/markers/markerModel';
import type { PlaybackControlsState } from 'src/player/playbackControls';
import { makePlaybackDouble } from './audioPlayerHarness';

/** Controllable audio element whose setters emit the matching media events. */
export interface ControllableAudio extends HTMLAudioElement {
	/** Sets the reported readyState so metadata can be made available late. */
	setReady(value: number): void;
	/** Sets the duration and emits durationchange, as a real load would. */
	setDuration(value: number): void;
}

/**
 * Installs one deterministic audio element as the global Audio factory, so the
 * registry's `new Audio()` and every player bind to the same element.
 * @returns The shared element with test-only mutators and a restore function
 */
export function installSharedAudio(): {
	audio: ControllableAudio;
	restore(): void;
} {
	const el = document.createElement('audio') as ControllableAudio;
	let paused = true;
	let currentTime = 0;
	let duration = NaN;
	let ready = 0;
	let playbackRate = 1;
	Object.defineProperties(el, {
		paused: { configurable: true, get: () => paused },
		currentTime: {
			configurable: true,
			get: () => currentTime,
			set: (value: number) => {
				currentTime = value;
				el.dispatchEvent(new Event('timeupdate'));
			},
		},
		playbackRate: {
			configurable: true,
			get: () => playbackRate,
			set: (value: number) => {
				playbackRate = value;
				el.dispatchEvent(new Event('ratechange'));
			},
		},
		duration: { configurable: true, get: () => duration },
		readyState: { configurable: true, get: () => ready },
	});
	jest.spyOn(el, 'play').mockImplementation(() => {
		paused = false;
		el.dispatchEvent(new Event('play'));
		return Promise.resolve();
	});
	jest.spyOn(el, 'pause').mockImplementation(() => {
		paused = true;
		el.dispatchEvent(new Event('pause'));
	});
	jest.spyOn(el, 'load').mockImplementation(() => undefined);
	el.setReady = (value: number) => {
		ready = value;
	};
	el.setDuration = (value: number) => {
		duration = value;
		el.dispatchEvent(new Event('durationchange'));
	};
	jest.spyOn(globalThis, 'Audio').mockImplementation(() => el);
	return {
		audio: el,
		restore: () => {},
	};
}

/**
 * An in-memory sidecar store the players can read and write without
 * persistence. `updateMarkers` mutates a backing map so a write is visible to
 * a later `getMarkers`, and the no-op rename/delete/clear methods let the
 * registrar's vault wiring and dispose run against it.
 * @returns A RecordingSidecarStore double backed by an in-memory map
 */
export function makeMarkerStore(): RecordingSidecarStore & {
	positions: Map<string, number>;
} {
	const data = new Map<string, PlayerMarker[]>();
	return {
		...makePlaybackDouble(),
		getMarkers: jest.fn((path: string) =>
			Promise.resolve([...(data.get(path) ?? [])]),
		),
		updateMarkers: jest.fn(
			(
				path: string,
				change: (
					existing: readonly PlayerMarker[],
				) => readonly PlayerMarker[],
			) => {
				const merged = [...change(data.get(path) ?? [])];
				data.set(path, merged);
				return Promise.resolve(merged);
			},
		),
		handleRename: jest.fn().mockResolvedValue(undefined),
		handleOutputRename: jest.fn().mockResolvedValue(undefined),
		handleDelete: jest.fn().mockResolvedValue(undefined),
		clearCache: jest.fn(),
	} as unknown as RecordingSidecarStore & {
		positions: Map<string, number>;
	};
}

/**
 * A complete playback snapshot with jest-backed commands, as the registry
 * publishes it. Shared so the status bar and the palette commands are
 * exercised against the very same contract.
 * @param overrides - State fields to replace for a specific assertion
 * @returns A playback snapshot every consumer accepts
 */
export function makePlaybackState(
	overrides: Partial<PlaybackControlsState> = {},
): PlaybackControlsState {
	return {
		currentTime: 65,
		duration: 222,
		paused: false,
		volume: 0.75,
		muted: false,
		playbackRate: 1,
		markersEnabled: true,
		skipSeconds: 10,
		chaptersEnabled: true,
		chapterLoopEnabled: false,
		onTogglePlay: jest.fn(),
		onStop: jest.fn(),
		onSkip: jest.fn(),
		onToggleMute: jest.fn(),
		onVolumeInput: jest.fn(),
		onSetPlaybackRate: jest.fn(),
		onAddMarker: jest.fn(),
		onPreviousChapter: jest.fn(),
		onNextChapter: jest.fn(),
		onToggleChapterLoop: jest.fn(),
		...overrides,
	};
}

/** Reads the elapsed / total text the player renders. */
export function timeText(container: HTMLElement): string {
	return container.querySelector('.aar-player-time')?.textContent ?? '';
}

// Re-exported so a playback test needs one import; the implementation lives
// with the other waiting primitives.
export { tick } from './async';
