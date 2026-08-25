/**
 * Media-API doubles with paired cleanup, so suites stop hand-rolling globals
 * and leaking them into each other.
 *
 * Covers the HTMLAudioElement and object URLs. It once also carried
 * MediaRecorder, AudioContext, and getUserMedia doubles, which no test ever
 * used - the suites that needed them had installed their own before these were
 * written. Removed rather than left as a second way to do it.
 * @module tests/helpers/mediaMocks
 */

/** Handle returned by the install helpers; restore() undoes the global. */
export interface InstalledMock<T> {
	instances: T[];
	restore: () => void;
}

/**
 * An audio element double whose metadata load a test drives by hand.
 *
 * jsdom loads no media, so anything reading a duration through an element gets
 * one of these instead: the test decides what the element reports and when,
 * which is the only way to play out the sequence a streamed container produces
 * (metadata first with no length, the real one only after a seek).
 */
export class AudioElementDouble {
	preload = '';
	src = '';
	duration = Number.NaN;
	/** Whether the source was released, which every probe owes its element. */
	released = false;
	/** Makes the seek throw, as a source that refuses one does. */
	seekRejects = false;
	private seekTarget: number | null = null;
	private readonly listeners = new Map<string, Set<() => void>>();

	get currentTime(): number {
		return this.seekTarget ?? 0;
	}

	set currentTime(value: number) {
		if (this.seekRejects) {
			throw new Error('seek refused');
		}
		this.seekTarget = value;
	}

	/** Where the probe seeked to, or null when it never seeked. */
	get seekedTo(): number | null {
		return this.seekTarget;
	}

	/** Listeners still attached, so a settled probe can be shown to leak none. */
	get attachedListenerCount(): number {
		let count = 0;
		for (const handlers of this.listeners.values()) {
			count += handlers.size;
		}
		return count;
	}

	addEventListener(type: string, handler: () => void): void {
		const handlers = this.listeners.get(type) ?? new Set<() => void>();
		handlers.add(handler);
		this.listeners.set(type, handlers);
	}

	removeEventListener(type: string, handler: () => void): void {
		this.listeners.get(type)?.delete(handler);
	}

	removeAttribute(name: string): void {
		if (name === 'src') {
			this.released = true;
		}
	}

	load(): void {
		/* mirrors the teardown a probe performs */
	}

	/** Fires an event the element would have fired itself. */
	emit(type: string): void {
		for (const handler of [...(this.listeners.get(type) ?? [])]) {
			handler();
		}
	}
}

/**
 * Installs an Audio constructor returning {@link AudioElementDouble}s.
 * @param respond - Scripts each element, for a test that does not hold the
 * probe open to drive it by hand. Called on the microtask after construction,
 * because a probe attaches its listeners only once the constructor has
 * returned, so an event fired any earlier would reach nobody.
 * @returns Handle with created instances and a restore function
 */
export function installAudioElementMock(
	respond?: (audio: AudioElementDouble) => void,
): InstalledMock<AudioElementDouble> {
	const previous = (globalThis as { Audio?: unknown }).Audio;
	const instances: AudioElementDouble[] = [];
	(globalThis as { Audio?: unknown }).Audio = function AudioMock(
		this: AudioElementDouble,
	) {
		const element = new AudioElementDouble();
		instances.push(element);
		if (respond) {
			queueMicrotask(() => {
				respond(element);
			});
		}
		return element;
	};
	return {
		instances,
		restore: () => {
			(globalThis as { Audio?: unknown }).Audio = previous;
		},
	};
}

/** The object URLs a test handed out, and which of them were released. */
export interface ObjectUrlDouble {
	/** Every URL created, in order. */
	created: string[];
	/** Every URL revoked, in order. */
	revoked: string[];
}

/**
 * Installs URL.createObjectURL/revokeObjectURL, which jsdom does not provide.
 * Tracking both halves is what lets a test assert that a probe releases the
 * blob it made, however the probe ended.
 * @returns Handle whose single instance records the URLs
 */
export function installObjectUrlMock(): InstalledMock<ObjectUrlDouble> {
	const record: ObjectUrlDouble = { created: [], revoked: [] };
	const previousCreate = URL.createObjectURL as unknown;
	const previousRevoke = URL.revokeObjectURL as unknown;
	URL.createObjectURL = jest.fn(() => {
		const url = `blob:test/${String(record.created.length)}`;
		record.created.push(url);
		return url;
	});
	URL.revokeObjectURL = jest.fn((url: string) => {
		record.revoked.push(url);
	});
	return {
		instances: [record],
		restore: () => {
			URL.createObjectURL = previousCreate as typeof URL.createObjectURL;
			URL.revokeObjectURL = previousRevoke as typeof URL.revokeObjectURL;
		},
	};
}

/**
 * Builds a `MediaDeviceInfo` the way the browser reports one.
 *
 * Eight suites hand-rolled this five-field literal, always with the same
 * `toJSON` stub the DOM type demands and no test ever reads. Naming the two
 * fields that matter - the id and the label - keeps a device list readable.
 * @param deviceId - Device id the browser reports
 * @param label - Human-readable name, defaults to the id
 * @param kind - Device kind, defaulting to a microphone
 * @returns The device descriptor
 */
export function mediaDevice(
	deviceId: string,
	label: string = deviceId,
	kind: MediaDeviceKind = 'audioinput',
): MediaDeviceInfo {
	return {
		deviceId,
		label,
		kind,
		groupId: `group-${deviceId}`,
		toJSON: () => ({}),
	};
}

/**
 * Puts a `navigator.mediaDevices` double in place for every test of the
 * calling suite, and puts the real one back afterwards.
 *
 * Call it in the describe body; it registers both hooks. jsdom ships no media
 * devices, so every suite that touches an input has to install its own, and
 * every one of them wrote the same defineProperty pair by hand - which is
 * where a leaked global comes from, since the restore is a convention rather
 * than a guarantee. Pairing them here means the restore cannot be forgotten.
 * @param build - Builds the MediaDevices members this suite needs, per test
 * @returns Reads the double the current test is running against
 */
export function withMediaDevices<T extends object>(build: () => T): () => T {
	const original = navigator.mediaDevices;
	let current: T;
	beforeEach(() => {
		current = build();
		Object.defineProperty(navigator, 'mediaDevices', {
			value: current,
			configurable: true,
		});
	});
	afterEach(() => {
		Object.defineProperty(navigator, 'mediaDevices', {
			value: original,
			configurable: true,
		});
	});
	return () => current;
}

/** The device id the browser uses for the system default input. */
export const DEFAULT_DEVICE_ID = 'default';

/**
 * The stock device list: a system default microphone plus a named second one.
 * @returns Two audio inputs, the first of them the system default
 */
export function defaultDeviceList(): MediaDeviceInfo[] {
	return [
		mediaDevice(DEFAULT_DEVICE_ID, 'Default - Microphone'),
		mediaDevice('device1', 'Microphone 1'),
	];
}

/** A real audio element whose playback state a test drives. */
export interface ControlledAudio {
	/** The element itself, ready to hand to the code under test. */
	audio: HTMLAudioElement;
	play: jest.SpyInstance<Promise<void>, []>;
	pause: jest.SpyInstance<void, []>;
	load: jest.SpyInstance<void, []>;
	/** How many times `new Audio()` was called, for a SUT that builds its own. */
	constructions: () => number;
	/** Moves the playhead and fires the timeupdate that follows it. */
	advanceTo: (seconds: number) => void;
	/** Reports a new length and fires durationchange, as a stream does. */
	setDuration: (seconds: number) => void;
	/** Sets readyState; 1 is "metadata is in", 0 is "nothing yet". */
	setReadyState: (value: number) => void;
	/** Marks metadata as arrived and fires loadedmetadata. */
	loadMetadata: () => void;
	/** Makes play() reject, the way a browser blocking autoplay does. */
	blockAutoplay: () => void;
}

/** What a suite varies about the element it plays through. */
export interface ControlledAudioOptions {
	/** Length the element reports. */
	duration?: number;
	/** Initial readyState; 0 models an element whose metadata has not landed. */
	readyState?: number;
	/** Whether `new Audio()` should hand back this element. */
	asConstructor?: boolean;
}

/**
 * Builds an audio element that actually behaves like one.
 *
 * jsdom implements no media: `play()` does nothing, `paused` never changes,
 * `duration` is NaN. Five suites each grew the same answer to that - property
 * stubs over the element plus spies that flip them and fire the matching event
 * - which is one double, not five.
 *
 * Nothing needs restoring afterwards: the element is built per call and thrown
 * away, and the one global touched is the Audio constructor, which the
 * projects' `restoreMocks` puts back.
 * @param options - Length, readiness, and whether it stands in for `new Audio`
 * @returns The element and the controls a test drives it with
 */
export function installControlledAudio(
	options: ControlledAudioOptions = {},
): ControlledAudio {
	const { duration = 120, readyState = 1, asConstructor = true } = options;
	const audio = document.createElement('audio');
	let paused = true;
	let currentTime = 0;
	let ready = readyState;
	let length = duration;
	let autoplayBlocked = false;
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
		if (autoplayBlocked) {
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
	const factory = asConstructor
		? jest.spyOn(globalThis, 'Audio').mockImplementation(() => audio)
		: null;

	return {
		audio,
		play,
		pause,
		load,
		constructions: () => factory?.mock.calls.length ?? 0,
		advanceTo: (seconds) => {
			currentTime = seconds;
			audio.dispatchEvent(new Event('timeupdate'));
		},
		setDuration: (seconds) => {
			length = seconds;
			audio.dispatchEvent(new Event('durationchange'));
		},
		setReadyState: (value) => {
			ready = value;
		},
		loadMetadata: () => {
			ready = 1;
			audio.dispatchEvent(new Event('loadedmetadata'));
		},
		blockAutoplay: () => {
			autoplayBlocked = true;
		},
	};
}
