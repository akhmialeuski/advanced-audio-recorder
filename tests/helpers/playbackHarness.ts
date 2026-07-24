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
	const factory = jest
		.spyOn(globalThis, 'Audio')
		.mockImplementation(() => el);
	return {
		audio: el,
		restore: () => {
			factory.mockRestore();
		},
	};
}

/**
 * An in-memory sidecar store the players can read and write without
 * persistence. `updateMarkers` mutates a backing map so a write is visible to
 * a later `getMarkers`, and the no-op rename/delete/clear methods let the
 * registrar's vault wiring and dispose run against it.
 * @returns A RecordingSidecarStore double backed by an in-memory map
 */
export function makeMarkerStore(): RecordingSidecarStore {
	const data = new Map<string, PlayerMarker[]>();
	return {
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
	} as unknown as RecordingSidecarStore;
}

/** Reads the elapsed / total text the player renders. */
export function timeText(container: HTMLElement): string {
	return container.querySelector('.aar-player-time')?.textContent ?? '';
}

/** Resolves on the next macrotask, flushing pending player microtasks. */
export const tick = (): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, 0));
