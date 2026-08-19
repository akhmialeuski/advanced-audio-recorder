/**
 * Shared harness for the AudioPlayer suites.
 *
 * The player is worth driving for real - clicks, keydowns, pointer events,
 * against a real container - because a wiring regression in the coordinator
 * hides behind mocked collaborators. What it takes to do that is a controllable
 * audio element, a partial registry, an in-memory sidecar, and an app whose
 * vault and fileManager answer; three suites were each carrying their own copy
 * of all four.
 * @module tests/helpers/audioPlayerHarness
 */

import { App as ObsidianApp, Modal } from 'obsidian';
import type { TFile } from 'obsidian';
import type { AudioPlayerRegistry } from 'src/player/AudioPlayerRegistry';
import type { AudioDecoder } from 'src/player/WaveformData';
import type { RecordingSidecarStore } from 'src/sidecar/RecordingSidecarStore';
import type { PlayerMarker } from 'src/markers/markerModel';
import { partial } from './doubles';
import { createMockApp } from './createApp';

export type Listener = () => void;

export interface FakeAudio {
	paused: boolean;
	loop: boolean;
	playbackRate: number;
	volume: number;
	muted: boolean;
	currentTime: number;
	duration: number;
	readyState: number;
	play: jest.Mock;
	pause: jest.Mock;
	addEventListener: (type: string, cb: Listener) => void;
	removeEventListener: (type: string, cb: Listener) => void;
	emit: (type: string) => void;
}

export function makeFakeAudio(): FakeAudio {
	const handlers = new Map<string, Set<Listener>>();
	const audio: FakeAudio = {
		paused: true,
		loop: false,
		playbackRate: 1,
		volume: 1,
		muted: false,
		currentTime: 0,
		duration: 100,
		readyState: 1,
		play: jest.fn(() => {
			audio.paused = false;
			return Promise.resolve();
		}),
		pause: jest.fn(() => {
			audio.paused = true;
		}),
		addEventListener: (type, cb) => {
			const set = handlers.get(type) ?? new Set<Listener>();
			set.add(cb);
			handlers.set(type, set);
		},
		removeEventListener: (type, cb) => {
			handlers.get(type)?.delete(cb);
		},
		emit: (type) => {
			handlers.get(type)?.forEach((cb) => {
				cb();
			});
		},
	};
	return audio;
}

/**
 * A key-aware registry stand-in that mirrors the real acquire semantics:
 * each distinct playback key (file path + #t= start) gets its own audio
 * element and its own engaged flag, and re-acquiring a known key returns the
 * same element with isNew=false. New keys consume the provided fakes in
 * acquisition order, then fall back to fresh ones - so a test that mounts
 * several distinct embeds controls each element it asserts on.
 * @param audios - Elements handed out to new keys, in order
 * @returns The registry double
 */
export function makeRegistry(...audios: FakeAudio[]): AudioPlayerRegistry {
	// A partial double: these suites drive only the acquire/release surface,
	// so the widening at the boundary is the honest statement of that.
	return partial<AudioPlayerRegistry>(makePartialRegistry(...audios));
}

/** The methods {@link makeRegistry} actually implements. */
export function makePartialRegistry(...audios: FakeAudio[]): object {
	const entries = new Map<string, { audio: FakeAudio; engaged: boolean }>();
	let nextAudio = 0;
	return {
		acquireAudio: jest.fn((key: string) => {
			const existing = entries.get(key);
			if (existing) {
				return {
					audio: partial<HTMLAudioElement>(existing.audio),
					isNew: false,
				};
			}
			const audio = audios[nextAudio] ?? makeFakeAudio();
			nextAudio += 1;
			entries.set(key, { audio, engaged: false });
			return { audio: partial<HTMLAudioElement>(audio), isNew: true };
		}),
		releaseAudio: jest.fn(),
		register: jest.fn(),
		unregister: jest.fn(),
		reloadMarkers: jest.fn(),
		seek: jest.fn(),
		applySettings: jest.fn(),
		clear: jest.fn(),
		registerPlaybackController: jest.fn(() => jest.fn()),
		subscribePlayback: jest.fn(() => jest.fn()),
		markAudioEngaged: jest.fn((key: string) => {
			const entry = entries.get(key);
			if (entry) {
				entry.engaged = true;
			}
		}),
		isAudioEngaged: jest.fn(
			(key: string) => entries.get(key)?.engaged ?? false,
		),
	};
}

export const app = createMockApp({
	vault: {
		getResourcePath: () => 'app://media',
		readBinary: () => Promise.resolve(new ArrayBuffer(0)),
	},
	fileManager: {
		generateMarkdownLink: () => '[[rec.webm]]',
	},
}).app;

/**
 * Decoding is irrelevant to the structural assertions these suites make;
 * rejecting keeps the progressive peak path, and its timers, out of them.
 */
export const decoder: AudioDecoder = {
	decode: () => Promise.reject(new Error('no decode in tests')),
};

/** An in-memory marker store the tests can inspect. */
export function makeMarkerStore(): RecordingSidecarStore & {
	data: Map<string, PlayerMarker[]>;
} {
	const data = new Map<string, PlayerMarker[]>();
	return {
		data,
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
	} as unknown as RecordingSidecarStore & {
		data: Map<string, PlayerMarker[]>;
	};
}

export function makeFile(size = 1000, extension = 'webm'): TFile {
	return partial<TFile>({
		path: `rec.${extension}`,
		extension,
		stat: { mtime: 1, size },
	});
}

export function makeContainer(): HTMLElement {
	const el = new Modal(new ObsidianApp()).contentEl.createDiv();
	document.body.appendChild(el);
	return el;
}

/**
 * A container nested in a CodeMirror editor, so the player resolves to the
 * editable (Live Preview) mode where marker creation is allowed.
 */
export function makeEditableContainer(): HTMLElement {
	const editor = makeContainer();
	editor.addClass('cm-editor');
	return editor.createDiv();
}
