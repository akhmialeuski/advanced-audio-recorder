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
